/**
 * 定时计划（左侧导航的「计划」）：面板进程在跑时，按计划到点新建一个对话并开始执行。
 *
 * - 计划存在数据目录的 config/schedules.json，和设置、角色这些配置一起被「数据」页覆盖（导出、清理）
 * - 到点判定、执行后往后推时间的规则全在 shared/schedule.ts（有单测），这里只负责读写和启动对话
 * - 进程不在时错过的计划不补跑：下一次轮询发现已经过了宽限时间的，只标成错过
 * - 启动出来的对话和用户手动新建的一样（走 tasks 的创建链路），不另造一套执行流程
 */
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import {
  afterBlocked,
  afterFail,
  afterMiss,
  afterRun,
  alignScheduleAt,
  scheduleClock,
  appendRun,
  dependencyBlocker,
  nextRunAt,
  orderByDependency,
  pickDue,
  sameMinute,
  scheduleCycle,
  scheduleCycleLabel,
  scheduleEnded,
  scheduleTimingError,
  settleRun,
  SCHEDULE_MISS_MS,
  SCHEDULE_TICK_MS,
  Schedule,
  ScheduleInput,
  type RunTaskState,
  type ScheduleRun,
} from '../shared/schedule.ts'
import { NewTaskInput, type Task } from '../shared/schema.ts'
import type { ScheduleDelivery, ScheduleEvent } from '../shared/schedule.ts'
import { t } from '../shared/i18n.ts'
import { createCollection } from './store.ts'
import { getSettings } from './settings.ts'
import { deliverWebhook, webhookPayload } from './webhook.ts'
import { log } from './log.ts'

const bad = (c: Context, error: string, status: 400 | 404 = 400) => c.json({ error }, status)

/**
 * 运行记录的耗时只补这么久以内启动的：对话被删掉了就永远等不到它跑完，
 * 不能每轮询一次都去查一遍；两天还没跑完的长对话也不再算它的耗时
 */
const SETTLE_WINDOW_MS = 2 * 86_400_000

/** 默认的 Webhook 投递：现读设置里的地址，真的 POST 出去（单测注入假的，不走网络） */
async function deliverDefault(
  event: ScheduleEvent,
  s: Schedule,
  at: string,
  projectName: string,
): Promise<ScheduleDelivery | null> {
  const settings = await getSettings()
  return deliverWebhook(settings.webhook, event, webhookPayload(s, event, at, projectName))
}

/** 新建时的运行状态字段：还没跑过 */
const EMPTY_STATE = {
  status: 'pending' as const,
  lastRunAt: '',
  lastTaskId: '',
  missedAt: '',
  lastError: '',
  blockedAt: '',
  blockedReason: '',
  // create 不经过 schema 解析：这里显式给一份，读出来的新计划和旧计划字段一致
  lastDelivery: null,
  runs: [] as ScheduleRun[],
}

export function schedulesApi(deps: {
  /** 走和页面新建任务完全一样的链路，失败时抛出原因 */
  startChat: (input: NewTaskInput) => Promise<Task>
  /** 投递 Webhook：默认读设置后真的 POST 出去，单测注入假的 */
  deliver?: (event: ScheduleEvent, s: Schedule, at: string, projectName: string) => Promise<ScheduleDelivery | null>
  /** 项目名：Webhook 载荷里带上，接的一方不用再去查项目 id */
  projectName?: (id: string) => Promise<string>
  /**
   * 查启动出来的对话现在的状态（不读整段对话）：跑完时在运行记录上补结束时间和耗时（见 settleRun）。
   * 不传就不补，运行记录里不显示耗时
   */
  peekTask?: (id: string) => Promise<RunTaskState | null>
}) {
  const store = createCollection('schedules.json', Schedule)
  const routes = new Hono()
  /** 上一轮轮询还没做完时不重入：启动一条计划可能慢，重叠起来会把同一条计划启动两次 */
  let ticking = false
  /** 在途的 Webhook 投递：不阻塞计划，但停止 / 单测时要能等它们落地 */
  const pending = new Set<Promise<void>>()

  /**
   * 计划跑到终态时投递 Webhook，结果记进计划给用户看。
   * 故意不 await：投递可能要重试几秒，不能把后面计划的启动拖住；失败也只记日志。
   */
  function notify(event: ScheduleEvent, s: Schedule, at: string) {
    const run = (async () => {
      try {
        const projectName = s.projectId ? ((await deps.projectName?.(s.projectId)) ?? '') : ''
        const res = await (deps.deliver ?? deliverDefault)(event, s, at, projectName)
        if (res) await store.update(s.id, { lastDelivery: res })
      } catch (e) {
        log.warn('schedule', 'Webhook 投递失败', { schedule: s.id, error: (e as Error).message })
      }
    })()
    pending.add(run)
    void run.finally(() => pending.delete(run))
  }

  /**
   * 写回运行状态。写之前重新读一次：tick 开头拿到的是快照，启动对话期间用户可能改过排期，
   * 用快照算出来的 at / missedAt 写回去会跟用户的新排期打架。
   * 「改没改排期」和 PUT 用同一个口径（sameMinute）：界面上的时间只到分钟，
   * 用户只改名字、带秒的时间被截成整分时，不能当成换了排期（否则单次的 done 会被丢掉、下一轮又启动一次）。
   * run 是这次运行的记录：它是已经发生的事实，不归排期计算管，用户改过排期也照常追加。
   */
  async function writeBack(id: string, snapshotAt: string, patch: Partial<Schedule>, run?: ScheduleRun) {
    const latest = await store.get(id)
    if (!latest) return null
    const withRun = run ? { ...patch, runs: appendRun(latest.runs, run) } : patch
    if (sameMinute(latest.at, snapshotAt)) return store.update(id, withRun)
    // 排期被改过：这次判定算出来的时间、状态和「谁没跑成」都归用户的新排期管，不能写回——
    // 尤其 blockedAt 存的是快照里的旧 at，single 计划还会被写成 skipped，用户新排的时间就永远不会执行
    const { at, missedAt, blockedAt, blockedReason, status, ...rest } = withRun
    return store.update(id, rest)
  }

  /**
   * 保存前的依赖校验：上游必须存在、不能依赖自己、不能成环。
   * id 是正在保存的计划（新建时为空）；返回错误文案，通过返回空字符串。
   */
  async function checkDependencies(id: string, dependsOn: string[]): Promise<string> {
    const list = await store.list()
    if (id && dependsOn.includes(id)) return t('计划不能依赖自己，请去掉这一项')
    const missing = dependsOn.filter((x) => !list.some((s) => s.id === x))
    if (missing.length) return t('选中的上游计划已经不存在，请重新选择')
    const cycle = scheduleCycle(list, id, dependsOn)
    if (cycle.length) return t('依赖关系成环：{path}，请去掉一个上游再保存', { path: scheduleCycleLabel(cycle, list) })
    return ''
  }

  /**
   * 计划启动出来的对话跑完了：在那条运行记录上补结束时间、耗时和成败。
   * 每次轮询顺带查一遍还没补的（只看 SETTLE_WINDOW_MS 以内启动的），写回前重新读一次计划，
   * 只替换补上的那几条，不覆盖这期间新追加的记录。返回补过的计划（替换进轮询的快照）
   */
  async function settleRuns(list: Schedule[], now: number): Promise<Schedule[]> {
    const peek = deps.peekTask
    if (!peek) return []
    const key = (r: ScheduleRun) => `${r.taskId}@${r.happenedAt}`
    const out: Schedule[] = []
    for (const s of list) {
      const done = new Map<string, ScheduleRun>()
      for (const r of s.runs) {
        if (r.event !== 'run' || !r.taskId || r.endedAt) continue
        if (now - Date.parse(r.happenedAt) > SETTLE_WINDOW_MS) continue
        const settled = settleRun(r, await peek(r.taskId).catch(() => null))
        if (settled) done.set(key(r), settled)
      }
      if (!done.size) continue
      const latest = await store.get(s.id)
      if (!latest) continue
      const saved = await store.update(s.id, { runs: latest.runs.map((r) => done.get(key(r)) ?? r) })
      if (saved) out.push(saved)
    }
    return out
  }

  /** 把计划转成新建对话的输入：执行上限也跟着走，之后改计划不影响已经启动的对话 */
  function startInput(s: Schedule) {
    return NewTaskInput.parse({
      projectId: s.projectId,
      mode: 'chat',
      agentId: s.agentId,
      prompt: s.prompt,
      budgetTokens: s.budget.tokens,
      budgetMinutes: s.budget.minutes,
    })
  }

  /** 到点启动对话；失败的原因记进计划，用户下次打开列表就能看到 */
  async function launch(s: Schedule, now: number) {
    const happenedAt = new Date(now).toISOString()
    try {
      const task = await deps.startChat(startInput(s))
      const saved =
        (await writeBack(s.id, s.at, afterRun(s, now, task.id), {
          at: s.at,
          happenedAt,
          event: 'run',
          manual: false,
          taskId: task.id,
          error: '',
        })) ?? s
      log.info('schedule', '计划已启动对话', { schedule: s.id, name: s.name, task: task.id })
      notify('run', saved, s.at)
      return { schedule: saved, taskId: task.id }
    } catch (e) {
      const error = (e as Error).message
      // 启动失败也要把时间往后推，否则每次轮询都会重试、一直刷同一条错误
      const saved =
        (await writeBack(s.id, s.at, afterFail(s, now, error), {
          at: s.at,
          happenedAt,
          event: 'fail',
          manual: false,
          taskId: '',
          error,
        })) ?? s
      log.warn('schedule', '计划启动对话失败', { schedule: s.id, name: s.name, error })
      notify('fail', saved, s.at)
      return { schedule: saved, taskId: '' }
    }
  }

  /**
   * 轮询一次：到点的启动对话，错过太久的只记下错过。
   * 时钟参数给单测注入固定时间用。
   */
  async function tick(now = Date.now()) {
    if (ticking) return
    ticking = true
    try {
      const all = await store.list()
      // 先补上一轮启动的对话跑完没有：补不上（写盘失败）不影响后面的到点判定
      const settled = await settleRuns(all, now).catch((e) => {
        log.warn('schedule', '补运行耗时出错', { error: (e as Error).message })
        return []
      })
      for (const x of settled) {
        const i = all.findIndex((y) => y.id === x.id)
        if (i >= 0) all[i] = x
      }
      const { run, missed } = pickDue(all, now)
      // 写回后的记录替换进这一轮的快照：同一批里排在下游的计划要读到上游最新的结果
      const replaceSnapshot = (saved: Schedule) => {
        const i = all.findIndex((x) => x.id === saved.id)
        if (i >= 0) all[i] = saved
      }
      const happenedAt = new Date(now).toISOString()
      for (const s of missed) {
        // 一条写失败不能中断整轮：后面到点的计划还要启动
        const saved = await writeBack(s.id, s.at, afterMiss(s, now), {
          at: s.at,
          happenedAt,
          event: 'miss',
          manual: false,
          taskId: '',
          error: '',
        }).catch((e) => {
          log.warn('schedule', '记录错过时写盘失败', { schedule: s.id, error: (e as Error).message })
          return null
        })
        log.info('schedule', '计划已经错过，不补跑', { schedule: s.id, name: s.name, at: s.at })
        if (saved) {
          replaceSnapshot(saved)
          notify('miss', saved, s.at)
        }
      }
      // 一条条启动：startChat 启动后就返回，不会等到对话跑完。
      // 按依赖顺序排：上游先启动，下游判定时能拿到本轮刚写回的成功记录
      const started = new Set<string>()
      for (const s of orderByDependency(run)) {
        // 上游没成功就不启动，把原因写进计划给用户看，不静默跳过
        const reason = dependencyBlocker(s, all, now, started)
        if (reason) {
          const saved = await writeBack(s.id, s.at, afterBlocked(s, now, reason), {
            at: s.at,
            happenedAt,
            event: 'blocked',
            manual: false,
            taskId: '',
            error: reason,
          }).catch((e) => {
            log.warn('schedule', '记录上游没成功时写盘失败', { schedule: s.id, error: (e as Error).message })
            return null
          })
          log.info('schedule', '上游没有成功，计划没有启动', { schedule: s.id, name: s.name, reason })
          if (saved) {
            replaceSnapshot(saved)
            notify('blocked', saved, s.at)
          }
          continue
        }
        const res = await launch(s, now).catch((e) => {
          log.warn('schedule', '启动计划出错', { schedule: s.id, error: (e as Error).message })
          return null
        })
        if (res?.taskId) started.add(s.id)
        // 换成写回后的记录：同一批里排在下游的计划要读到上游最新的结果
        if (res) replaceSnapshot(res.schedule)
      }
    } finally {
      ticking = false
    }
  }

  /** 用户点「立即执行」：不改排期（下次时间照旧），只记下这次启动的对话。显式操作不受上游依赖限制 */
  async function runNow(id: string, now = Date.now()) {
    const s = await store.get(id)
    if (!s) return null
    const happenedAt = new Date(now).toISOString()
    try {
      const task = await deps.startChat(startInput(s))
      // 启动对话期间计划可能被改过：历史追加到最新一份上，不覆盖用户这期间的改动
      const latest = (await store.get(id)) ?? s
      const run: ScheduleRun = { at: '', happenedAt, event: 'run', manual: true, taskId: task.id, error: '' }
      const saved = await store.update(id, {
        lastRunAt: happenedAt,
        lastTaskId: task.id,
        lastError: '',
        runs: appendRun(latest.runs, run),
      })
      log.info('schedule', '手动执行计划', { schedule: id, name: s.name, task: task.id })
      return { schedule: saved ?? s, taskId: task.id }
    } catch (e) {
      const error = (e as Error).message
      const latest = (await store.get(id)) ?? s
      const run: ScheduleRun = { at: '', happenedAt, event: 'fail', manual: true, taskId: '', error }
      const saved = await store.update(id, { lastError: error, runs: appendRun(latest.runs, run) })
      log.warn('schedule', '手动执行计划失败', { schedule: id, name: s.name, error })
      return { schedule: saved ?? s, taskId: '' }
    }
  }

  routes.get('/', async (c) => c.json(await store.list()))

  routes.post('/', async (c) => {
    const p = ScheduleInput.safeParse(await c.req.json().catch(() => null))
    if (!p.success) return bad(c, z.prettifyError(p.error))
    // 同一个上游选两次没有意义，保存时去重
    const dependsOn = [...new Set(p.data.dependsOn)]
    // 新建的计划还没有 id，别的计划依赖不了它，不会成环，只校验上游是否存在
    const depError = await checkDependencies('', dependsOn)
    if (depError) return bad(c, depError)
    const timing = scheduleTimingError(p.data)
    if (timing) return bad(c, timing)
    const now = new Date().toISOString()
    // 每周 / 工作日的首次执行也要落在选中的星期：保存前对齐，到点判定（pickDue）和徽标才一致
    const item = await store.create({
      ...p.data,
      dependsOn,
      at: alignScheduleAt(p.data),
      clock: scheduleClock(p.data.at),
      ...EMPTY_STATE,
      createdAt: now,
      updatedAt: now,
    })
    log.info('schedule', '新建计划', { schedule: item.id, name: item.name, at: item.at })
    return c.json(item, 201)
  })

  routes.put('/:id', async (c) => {
    const id = c.req.param('id')
    const old = await store.get(id)
    if (!old) return bad(c, t('计划不存在'), 404)
    const p = ScheduleInput.safeParse(await c.req.json().catch(() => null))
    if (!p.success) return bad(c, z.prettifyError(p.error))
    const dependsOn = [...new Set(p.data.dependsOn)]
    const depError = await checkDependencies(id, dependsOn)
    if (depError) return bad(c, depError)
    const timing = scheduleTimingError(p.data)
    if (timing) return bad(c, timing)
    const input = { ...p.data, dependsOn, at: alignScheduleAt(p.data) }
    // 已经结束的计划把结束日期往后改（或改成永不）：存着的 at 是结束后那一次、早就过了，
    // 不推到现在之后的话下一轮会先记一次「错过」。推过去之后按重新排期处理
    const now = Date.now()
    if (scheduleEnded(old) && !scheduleEnded(input) && Date.parse(input.at) < now - SCHEDULE_MISS_MS)
      input.at = nextRunAt({ ...input, clock: old.clock }, now)
    // 时间改了就是重新排期：已执行 / 已跳过的计划回到待执行，之前错过和没启动的记录也不再算数。
    // 按分钟比较：界面上的时间只到分钟，带秒的老数据在弹窗里编辑时不该被当成改了时间
    const rescheduled = !sameMinute(input.at, old.at)
    const item = await store.update(id, {
      ...input,
      // 只改名字这类保存时 at 还是上次推出来的那个（可能正好是夏令时顺延过的），沿用原来记的时分
      clock: !rescheduled && old.clock ? old.clock : scheduleClock(input.at),
      ...(rescheduled
        ? { status: 'pending' as const, missedAt: '', lastError: '', blockedAt: '', blockedReason: '' }
        : {
            status: old.status,
            missedAt: old.missedAt,
            lastError: old.lastError,
            blockedAt: old.blockedAt,
            blockedReason: old.blockedReason,
          }),
      lastRunAt: old.lastRunAt,
      lastTaskId: old.lastTaskId,
    })
    return c.json(item)
  })

  routes.delete('/:id', async (c) => {
    if (!(await store.remove(c.req.param('id')))) return bad(c, t('计划不存在'), 404)
    return c.body(null, 204)
  })

  routes.post('/:id/run', async (c) => {
    const res = await runNow(c.req.param('id'))
    return res ? c.json(res) : bad(c, t('计划不存在'), 404)
  })

  return {
    routes,
    /** 立即执行：路由和单测都走它 */
    runNow,
    /** 轮询一次（单测注入时钟） */
    tick,
    /** 写回运行状态（单测验证「用户改过排期时哪些字段不能写回」） */
    writeBack,
    /** 等所有在途的 Webhook 投递落地（单测和停止时用） */
    settled: () => Promise.all([...pending]).then(() => undefined),
    /** 启动定时轮询，返回停止函数；面板退出时不留下定时器 */
    start() {
      // 启动后先跑一次：上一次进程退出期间到点的计划在这里标成错过，不用等第一个轮询间隔
      void tick().catch((e) => log.warn('schedule', '计划检查出错', { error: (e as Error).message }))
      const timer = setInterval(
        () => void tick().catch((e) => log.warn('schedule', '计划检查出错', { error: (e as Error).message })),
        SCHEDULE_TICK_MS,
      )
      timer.unref()
      return () => clearInterval(timer)
    },
  }
}
