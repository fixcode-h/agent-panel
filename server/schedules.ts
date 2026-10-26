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
  afterFail,
  afterMiss,
  afterRun,
  alignScheduleAt,
  pickDue,
  sameMinute,
  SCHEDULE_TICK_MS,
  Schedule,
  ScheduleInput,
} from '../shared/schedule.ts'
import { NewTaskInput, type Task } from '../shared/schema.ts'
import { t } from '../shared/i18n.ts'
import { createCollection } from './store.ts'
import { log } from './log.ts'

const bad = (c: Context, error: string, status: 400 | 404 = 400) => c.json({ error }, status)

/** 新建时的运行状态字段：还没跑过 */
const EMPTY_STATE = { status: 'pending' as const, lastRunAt: '', lastTaskId: '', missedAt: '', lastError: '' }

export function schedulesApi(deps: {
  /** 走和页面新建任务完全一样的链路，失败时抛出原因 */
  startChat: (input: NewTaskInput) => Promise<Task>
}) {
  const store = createCollection('schedules.json', Schedule)
  const routes = new Hono()
  /** 上一轮轮询还没做完时不重入：启动一条计划可能慢，重叠起来会把同一条计划启动两次 */
  let ticking = false

  /**
   * 写回运行状态。写之前重新读一次：tick 开头拿到的是快照，启动对话期间用户可能改过排期，
   * 用快照算出来的 at / missedAt 写回去会跟用户的新排期打架。
   * 「改没改排期」和 PUT 用同一个口径（sameMinute）：界面上的时间只到分钟，
   * 用户只改名字、带秒的时间被截成整分时，不能当成换了排期（否则单次的 done 会被丢掉、下一轮又启动一次）。
   */
  async function writeBack(id: string, snapshotAt: string, patch: Partial<Schedule>) {
    const latest = await store.get(id)
    if (!latest) return null
    if (sameMinute(latest.at, snapshotAt)) return store.update(id, patch)
    // 排期被改过：at 和这次错过记录都归用户的新排期管，不能把快照算出来的值写回
    const { at, missedAt, ...rest } = patch
    return store.update(id, rest)
  }

  /** 到点启动对话；失败的原因记进计划，用户下次打开列表就能看到 */
  async function launch(s: Schedule, now: number) {
    try {
      const task = await deps.startChat(
        NewTaskInput.parse({ projectId: s.projectId, mode: 'chat', agentId: s.agentId, prompt: s.prompt }),
      )
      await writeBack(s.id, s.at, afterRun(s, now, task.id))
      log.info('schedule', '计划已启动对话', { schedule: s.id, name: s.name, task: task.id })
      return { schedule: (await store.get(s.id)) ?? s, taskId: task.id }
    } catch (e) {
      const error = (e as Error).message
      // 启动失败也要把时间往后推，否则每次轮询都会重试、一直刷同一条错误
      await writeBack(s.id, s.at, afterFail(s, now, error))
      log.warn('schedule', '计划启动对话失败', { schedule: s.id, name: s.name, error })
      return { schedule: (await store.get(s.id)) ?? s, taskId: '' }
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
      const { run, missed } = pickDue(await store.list(), now)
      for (const s of missed) {
        // 一条写失败不能中断整轮：后面到点的计划还要启动
        await writeBack(s.id, s.at, afterMiss(s, now)).catch((e) =>
          log.warn('schedule', '记录错过时写盘失败', { schedule: s.id, error: (e as Error).message }),
        )
        log.info('schedule', '计划已经错过，不补跑', { schedule: s.id, name: s.name, at: s.at })
      }
      // 一条条启动：startChat 启动后就返回，不会等到对话跑完
      for (const s of run)
        await launch(s, now).catch((e) =>
          log.warn('schedule', '启动计划出错', { schedule: s.id, error: (e as Error).message }),
        )
    } finally {
      ticking = false
    }
  }

  /** 用户点「立即执行」：不改排期（下次时间照旧），只记下这次启动的对话 */
  async function runNow(id: string, now = Date.now()) {
    const s = await store.get(id)
    if (!s) return null
    try {
      const task = await deps.startChat(
        NewTaskInput.parse({ projectId: s.projectId, mode: 'chat', agentId: s.agentId, prompt: s.prompt }),
      )
      const saved = await store.update(id, {
        lastRunAt: new Date(now).toISOString(),
        lastTaskId: task.id,
        lastError: '',
      })
      log.info('schedule', '手动执行计划', { schedule: id, name: s.name, task: task.id })
      return { schedule: saved ?? s, taskId: task.id }
    } catch (e) {
      const error = (e as Error).message
      const saved = await store.update(id, { lastError: error })
      log.warn('schedule', '手动执行计划失败', { schedule: id, name: s.name, error })
      return { schedule: saved ?? s, taskId: '' }
    }
  }

  routes.get('/', async (c) => c.json(await store.list()))

  routes.post('/', async (c) => {
    const p = ScheduleInput.safeParse(await c.req.json().catch(() => null))
    if (!p.success) return bad(c, z.prettifyError(p.error))
    const now = new Date().toISOString()
    // 每周 / 工作日的首次执行也要落在选中的星期：保存前对齐，到点判定（pickDue）和徽标才一致
    const item = await store.create({
      ...p.data,
      at: alignScheduleAt(p.data),
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
    const input = { ...p.data, at: alignScheduleAt(p.data) }
    // 时间改了就是重新排期：已执行 / 已跳过的计划回到待执行，之前错过的记录也不再算数。
    // 按分钟比较：界面上的时间只到分钟，带秒的老数据在弹窗里编辑时不该被当成改了时间
    const rescheduled = !sameMinute(input.at, old.at)
    const item = await store.update(id, {
      ...input,
      ...(rescheduled
        ? { status: 'pending' as const, missedAt: '', lastError: '' }
        : { status: old.status, missedAt: old.missedAt, lastError: old.lastError }),
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
