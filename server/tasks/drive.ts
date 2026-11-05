import { randomUUID } from 'node:crypto'
import { diagnosisPending } from '../../shared/task.ts'
import type { Task } from '../../shared/schema.ts'
import { planStalled, helpersWorking, runRunning, taskDeleted, wrapUpPending } from '../../shared/task.ts'
import { isChatMode, nudgeMax } from '../../shared/conv-mode.ts'
import { CHECK_REMINDER, idleReminders, SPIN_MAX, turnEndSince } from '../../shared/end-turn.ts'
import { DriveBudget, planProgressKey, shortKey } from '../../shared/drive.ts'
import { taskLog } from '../task-log.ts'
import { makeAlert } from '../../shared/alerts.ts'
import type { TurnInfo } from '../exec/turn-info.ts'
import { hasHeld } from '../exec/delivery.ts'
import { log } from '../log.ts'
import { t } from '../../shared/i18n.ts'
import { activePlan, needsFix, planProgress, openWork } from '../../shared/plan.ts'
import type { TasksScope } from './scope.ts'
import { createBeforeEnd } from './before-end.ts'

/**
 * 没列计划时，这一轮动手（跑命令、改文件）几次以上才做收尾自检（见 nudgeNoPlan）：三步以上的事才可能做了一半，
 * 改一处再跑一下检查这种小事不推（用户 2026-11-02：计划不要分得太细，合理就好）
 */
const PLAN_ACTS = 3

/**
 * 对话自驱（ADR 0041）：一轮结束时按计划推它接着做（nudgePlan），没计划时拿不准就做收尾自检（nudgeNoPlan）。
 * 顶层对话和子对话共用；每个判断写进对话日志（「计划推进」「收尾自检」），次数账本见 shared/drive.ts 的 DriveBudget。
 * 从 children.ts 拆出来：那个文件快到行数上限，而且自驱属于对话自己，不是子对话生命周期的一部分
 */
export function createDrive(
  sc: TasksScope,
  deps: { reportChild: (id: string) => Promise<void>; activeChildren: (id: string) => Promise<number> },
) {
  const { reportChild, activeChildren } = deps
  /**
   * 推对话「接着做」的次数账本：Agent 模式不限次数（用户 2026-11-05 定），只计数给状态诊断看；
   * 收住靠 end_turn 交代结束和空转保护（settledByEnd）。Chat 页的对话仍只推一次（见 shared/conv-mode.ts、ADR 0037）
   */
  const budget = new DriveBudget(Infinity)
  /** 一条输入：用户或父对话最近的一条消息（面板自己推的不算） */
  const inputOf = (tk: Task) => [...tk.messages].reverse().find((m) => m.role === 'user' && !m.panel)?.id ?? ''
  /**
   * 用户亲自发了新消息：次数清零（ADR 0041）。用户说「继续」就是给了新的机会，不该被「同一进度推满了」挡住；
   * 父对话、其他对话发来的不清零（外部输入只改计划，计划变了指纹自然会变）
   */
  const resetNudge = (id: string) => {
    budget.reset(id)
    warned.delete(id)
  }
  /** 真推出去时记一次：返回这是这个进度的第几次（从 1 开始），推满了返回 0 */
  const takeNudge = (conv: Task, key: string, max: number): number => {
    const n = budget.take(conv.id, key, max, inputOf(conv))
    // 子对话「推满了还停在原地」的判定（merge.ts 的 stuckAfterNudge）读这个：推满才记，没推满时子对话还在自驱，不报父对话
    if (n && n >= max) sc.planNudged.set(conv.id, key)
    else if (n) sc.planNudged.delete(conv.id)
    return n
  }
  /**
   * 这一轮已经有了结论，不再推（返回 true）：它用 end_turn 交代了做完或卡住，或者连着几次提醒都没动手（空转）。
   * 卡住和空转写一行警告留给用户，子对话上报父对话（planNudged 记上，children.ts 才会按「未完成」报）
   */
  async function settledByEnd(conv: Task, say: (data: Record<string, unknown>) => void): Promise<boolean> {
    const tk = sc.live.get(conv.id)?.task ?? (await sc.store.get(conv.id))
    if (!tk) return false
    const end = turnEndSince(tk)
    const spin = !end && idleReminders(tk.messages) >= SPIN_MAX
    if (end?.outcome === 'done') {
      say({ action: 'none', reason: 'declared' })
      return true
    }
    if (!end && !spin) return false
    say({ action: 'stuck', reason: end ? 'declared-blocked' : 'spin' })
    await warnStopped(
      tk.id,
      end ? `blocked:${end.at}` : `spin:${inputOf(tk)}`,
      end
        ? t('卡住了：{need}', { need: end.need ?? '' })
        : t('面板连着提醒了 {n} 次，它都没动手，也没说做完或卡住：停在这里等你看一下', { n: SPIN_MAX }),
    )
    if (tk.parentTaskId) {
      const plan = activePlan(tk)
      if (plan) sc.planNudged.set(tk.id, planProgressKey(plan))
      await reportChild(tk.id)
    }
    return true
  }
  /**
   * 对话这一轮说完了，计划却没做完、也没在等任何结果（见 planStalled）：常见于模型只回了一句
   * 「先跑类型检查」「我跑 test:failed」就收尾，那次回应里没有任何工具调用，CLI 照常报这一轮结束（用户报过多次）。
   * 子对话这时父对话只会收到一条状态，它在忙别的就没人推；顶层对话就一直停在等下一句。这里由面板马上推它接着做下一步。
   * 同一个进度推几次见 takeNudge（Agent 模式最多设置里的 nudgeMax 次，Chat 页 1 次），推满了还没动静：
   * 子对话照常上报父对话，顶层对话就停在那里等用户。
   * 次数只在真推出去时记（ADR 0041）：刚结束那一下只看还剩不剩次数，等 CLI 停稳复查通过、消息交出去之前才记。
   * 原来刚结束就记，复查时后台结果刚好交进来就静默返回，次数白白用掉，推满后同一进度再也不推（用户 2026-11-02 报）。
   * 每个判断都写进对话日志（「计划推进」），诊断文件里能直接看出为什么推了、为什么没推。
   * 推出去了（或者已经排好稍后推）返回 true
   */
  async function nudgePlan(conv: Task, turn?: TurnInfo): Promise<boolean> {
    // 已经交代了结束（end_turn）或者空转了：不推（Chat 页一问一答不用 end_turn，照旧按计划推一次）
    if (!isChatMode(conv) && (await settledByEnd(conv, (data) => taskLog(conv.id, '计划推进', data)))) return false
    // 没有计划的对话：这一轮没交代结束，问一句做完没有（见 nudgeNoPlan）
    if (!activePlan(conv)) return turn ? nudgeNoPlan(conv, turn) : false
    // Agent 模式不限次数，Chat 模式仍是 1（见 shared/conv-mode.ts 的 nudgeMax）
    const max = nudgeMax(conv)
    /** settled：这一轮已经停稳（进程结束，或者停在保活上等下一句）；刚结束那一下 CLI 还没停到等待上，不看这一项 */
    const stalled = async (settled: boolean) => {
      const tk = sc.live.get(conv.id)?.task ?? (await sc.store.get(conv.id))
      if (!tk || tk.imported || taskDeleted(tk)) return 'gone'
      if (!planStalled(tk)) return stallSkip(tk)
      // 已经停下、失败的不推；页面切走、闲置回收的保活进程是正常说完的一轮，照常推（同 nudgeMerge）
      if (haltedBy(tk)) return `halted:${haltedBy(tk)}`
      if (tk.status === 'failed' || (tk.status === 'stopped' && !reclaimed(tk))) return `status:${tk.status}`
      // 正常说完的一轮：进程结束了（done），或者还停在保活上等下一句（这时 status 仍是 running）。
      // 失败、被停下的不推：那是出错了或用户让它停，要让用户看到再决定
      if (settled && !(tk.status === 'done' || reclaimed(tk) || (tk.status === 'running' && tk.awaitingUser)))
        return tk.working ? 'working' : `status:${tk.status}`
      // 等用户回答、等确认、还有排队要处理的消息、后台命令还在跑：不是停住了
      if (tk.requests.length || tk.parentAsks?.length || diagnosisPending(tk)) return 'asking'
      if (hasHeld(tk.id) || sc.startQueue.has(tk.id)) return 'input-queued'
      if (sc.background.list(tk.id).some((j) => j.state === 'queued' || j.state === 'running')) return 'background'
      const plan = activePlan(tk)!
      return { tk, plan, p: planProgress(tk, plan), key: planProgressKey(plan) }
    }
    const say = (data: Record<string, unknown>) => taskLog(conv.id, '计划推进', data)
    const now = await stalled(false)
    if (typeof now === 'string') {
      say({ action: 'none', reason: now })
      return false
    }
    const progress = { done: now.p.done, total: now.p.total, key: shortKey(now.key) }
    const can = budget.can(conv.id, now.key, max, inputOf(now.tk))
    if (can !== 'ok') {
      const reason = can
      say({ action: 'stuck', reason, ...progress, max })
      // 到了上限（推满或设为 0）计划还没做完：写一行警告留给用户，不让它看起来像做完了。
      // 文案不说「推了几次」：设为 0 时一次都没推
      await warnStopped(
        conv.id,
        now.key,
        t('计划才做了 {done}/{total}，面板不会再自动提醒它了：停在这里等你看一下', {
          done: now.p.done,
          total: now.p.total,
        }),
      )
      // 子对话到了上限就不会再推这个进度了，要让父对话知道（ADR 0041）。max=0 时 takeNudge 从来没执行过、
      // planNudged 还是空的，不先记上，children.ts 的「没推满不报」守卫会把「未完成」这封信吞掉，父计划就一直挂着
      if (conv.parentTaskId) {
        sc.planNudged.set(conv.id, now.key)
        await reportChild(conv.id)
      }
      return false
    }
    // 稍等一下再推：这一轮刚结束时 CLI 还没停到「等下一句」上；等它停稳了再看一次，还停着才推
    setTimeout(() => {
      void (async () => {
        const again = await stalled(true)
        if (typeof again === 'string') {
          // 这期间有输入交进来（后台结果、消息）、开了新一轮：不推、不记次数，等那一轮结束再判
          say({ action: 'cancel', reason: again, ...progress })
          if (conv.parentTaskId) await reportChild(conv.id)
          return
        }
        if (again.key !== now.key) {
          // 还停着，但计划变了（面板收口了等待项这类，没有开新的一轮）：不能就此放弃，按新的进度再判一次
          say({ action: 'reevaluate', reason: 'progress-changed', ...progress })
          if (!(await nudgePlan(again.tk)) && conv.parentTaskId) await reportChild(conv.id)
          return
        }
        const nth = takeNudge(again.tk, now.key, max)
        if (!nth) {
          say({ action: 'stuck', reason: 'exhausted', ...progress, max })
          if (conv.parentTaskId) await reportChild(conv.id)
          return
        }
        const left = openWork(again.tk)
        // 要修的步骤（等的结果没成功、工作流没走完）先处理：不点明的话对话会跳过它往下做，或者干脆停着
        const failed = left.find(needsFix)
        const next = failed ?? left.find((s) => s.status === 'running') ?? left[0]
        const text =
          `【面板】你的计划才做了 ${again.p.done}/${again.p.total}，也没有在等任何结果，这一轮却结束了。` +
          (failed
            ? `「${failed.title}」${failed.note}。先查清原因、修好后重做，不要把它当成失败放着；确实不做了就标成跳过并说明原因，然后接着做计划。`
            : next
              ? `接着做「${next.title}」：`
              : '接着做下一步：') +
          '直接调用工具去做，不用先说明；一步做完就用 set_plan 标完成，并在同一条回复里接着调用工具做下一步，直到计划做完再调用 end_turn（outcome: done）。' +
          '确实做不下去就调用 end_turn（outcome: blocked），need 写卡在哪一步、需要什么。'
        const ok = again.tk.parentTaskId
          ? (await sc.sendToChild(again.tk.parentTaskId, again.tk.id, text, 'nudge')).ok
          : await sc.wakeConv(again.tk.id, text, { panel: 'nudge' }).then(
              () => true,
              () => false,
            )
        say({ action: ok ? 'continue' : 'send-failed', nth, max, ...progress })
        if (!ok && conv.parentTaskId) await reportChild(conv.id)
      })().catch((e) => log.warn('task', '推对话接着做计划失败', { task: conv.id, error: (e as Error).message }))
    }, sc.PLAN_NUDGE_MS).unref?.()
    return true
  }

  /** 保活进程被页面切走、闲置回收收掉的：这一轮是正常说完的，和用户、父对话叫停的不同（见 nudgeMerge 的同一判断） */
  const reclaimed = (tk: Task) => tk.status === 'stopped' && (tk.stopReason === 'presence' || tk.stopReason === 'idle')
  /**
   * 这一轮是被叫停的（用户暂停、父对话停下、收尾、重启……）：不管状态记成什么都不推。
   * 停止和这一轮结束撞在同一刻时状态会记成 done（这一轮已经答完），只看 status 会把刚被停下的对话又推起来
   * （2026-11-02 真实接口测试撞到：父对话停下后子对话被收尾自检拉起来接着跑）。页面切走、闲置回收是正常收掉的，照常推
   */
  const stops = new Map<string, string>()
  /** 停止时记一笔（keepalive.ts 的 stopTask 调）：这次执行收尾后内存里的执行位没了，复查时照样认得出是被叫停的 */
  const noteStop = (id: string, reason: string) => void stops.set(id, reason)
  /** 真正开了新的一轮（继续执行、新消息、推进）：上次的停止不再算数 */
  const clearStop = (id: string) => void stops.delete(id)
  const haltedBy = (tk: Task) => {
    const live = sc.live.get(tk.id)
    const why = stops.get(tk.id) ?? (live?.stop ? live.stopReason : tk.stopReason)
    return why && why !== 'presence' && why !== 'idle' ? why : ''
  }

  /** planStalled 不成立时写进日志的原因：只为排查，判定本身仍以 planStalled 为准 */
  function stallSkip(tk: Task): string {
    if (tk.working) return 'working'
    if (tk.resolved) return 'resolved'
    const wrap = tk.wrapRequest?.state
    if (wrap === 'requested' || wrap === 'merging' || wrap === 'testing') return `wrap:${wrap}`
    const plan = activePlan(tk)
    if (!plan) return 'no-plan'
    const p = planProgress(tk, plan)
    if (p.done >= p.total) return 'plan-done'
    if (p.waiting) return 'step-waiting'
    if (!openWork(tk).length) return 'only-wrapup'
    return 'waits-pending'
  }

  /**
   * 父对话这一轮结束了，名下却有子对话已经请它收尾、还没处理（见 shared/task.ts 的 wrapUpPending）：
   * 推它调用 finish_child 合回，或者用 send_to_conversation 退回要补的。
   * 不推的话父对话计划里那一步写着「等子对话」，planStalled 当它在等别人；子对话又在等父对话收尾，两边就互相等住了
   * （用户 2026-11-03 报：父对话回「改动核对通过……现在合回」就结束了这一轮，没调 finish_child）。
   * 次数和计划推进共用设置里的 nudgeMax，按「这几个收尾请求」记；推满了写一行警告留给用户（独立分支可以在子对话里点合并）。
   * 只管能 finish_child 的项目顶层对话。推出去了（或排好稍后推）返回 true
   */
  async function nudgeWrapUp(conv: Task): Promise<boolean> {
    if (conv.parentTaskId || !conv.projectId || isChatMode(conv)) return false
    const max = nudgeMax(conv)
    const say = (data: Record<string, unknown>) => taskLog(conv.id, '收尾提醒', data)
    // 空转、说了卡住：交给用户（settledByEnd 留警告）。说了做完却还有子对话等着收尾，照样提醒
    const end = turnEndSince(conv)
    if (end?.outcome === 'blocked' || (!end && idleReminders(conv.messages) >= SPIN_MAX)) {
      say({ action: 'none', reason: end ? 'declared-blocked' : 'spin' })
      return false
    }
    const stalled = async (settled: boolean) => {
      const tk = sc.live.get(conv.id)?.task ?? (await sc.store.get(conv.id))
      if (!tk || tk.imported || taskDeleted(tk)) return 'gone'
      if (tk.working) return 'working'
      if (haltedBy(tk)) return `halted:${haltedBy(tk)}`
      if (tk.status === 'failed' || (tk.status === 'stopped' && !reclaimed(tk))) return `status:${tk.status}`
      if (settled && !(tk.status === 'done' || reclaimed(tk) || (tk.status === 'running' && tk.awaitingUser)))
        return `status:${tk.status}`
      if (tk.requests.length || diagnosisPending(tk)) return 'asking'
      if (hasHeld(tk.id) || sc.startQueue.has(tk.id)) return 'input-queued'
      // 父对话自己还有后台命令在跑（多半是替子对话申请的编译）：结果回来会开新的一轮，到时再提醒。
      // 编译期间就催它收尾，它只能回「等编译结果」，次数白白用掉，编译出了结果反而不再提醒（用户 2026-11-04 报）
      if (sc.background.list(tk.id).some((j) => j.state === 'queued' || j.state === 'running')) return 'background'
      const kids = (await sc.store.list())
        .filter((k) => k.parentTaskId === tk.id)
        .map((k) => sc.live.get(k.id)?.task ?? k)
      // 正在合并的、父对话已经交回了话（排着等它开新一轮）的不算没处理
      const waiting = wrapUpPending(kids).filter(
        (k) => !sc.merging.has(k.id) && !hasHeld(k.id) && !sc.startQueue.has(k.id),
      )
      if (!waiting.length) return 'none-pending'
      return { tk, waiting, key: `wrap:${waiting.map((k) => `${k.id}@${k.wrapRequest!.at}`).join(',')}` }
    }
    const now = await stalled(false)
    if (typeof now === 'string') {
      if (now !== 'none-pending') say({ action: 'none', reason: now })
      return false
    }
    const can = budget.can(conv.id, now.key, max, inputOf(now.tk))
    if (can !== 'ok') {
      say({ action: 'stuck', reason: can, max, kids: now.waiting.map((k) => k.id) })
      await warnStopped(
        conv.id,
        now.key,
        t('子对话{list}已经请你收尾，面板提醒了还没处理：发一条消息让它接着收尾，或者进子对话点「合并」', {
          list: now.waiting.map((k) => `「${k.title}」`).join('、'),
        }),
      )
      return false
    }
    setTimeout(() => {
      void (async () => {
        const again = await stalled(true)
        if (typeof again === 'string') {
          say({ action: 'cancel', reason: again })
          return
        }
        const nth = budget.take(conv.id, again.key, max, inputOf(again.tk))
        if (!nth) {
          say({ action: 'stuck', reason: 'exhausted', max })
          return
        }
        const lines = again.waiting.map(
          (k) =>
            `- 「${k.title}」（id ${k.id}）：${k.worktree?.state === 'active' ? '合回它的独立分支' : '验收它的改动'}，验证够了就调用 finish_child（id ${k.id}）；要它补的用 send_to_conversation 交回`,
        )
        const text =
          `【面板】这些子对话已经请你收尾，你这一轮结束了却还没处理，它们一直在等你：\n${lines.join('\n')}\n` +
          '直接调用工具处理，不用先说明；收尾请求里有它的验证结果，核对后决定合回还是交回。'
        const ok = await sc.wakeConv(again.tk.id, text, { panel: 'nudge' }).then(
          () => true,
          () => false,
        )
        say({ action: ok ? 'continue' : 'send-failed', nth, max, kids: again.waiting.map((k) => k.id) })
      })().catch((e) => log.warn('task', '提醒父对话收尾失败', { task: conv.id, error: (e as Error).message }))
    }, sc.PLAN_NUDGE_MS).unref?.()
    return true
  }

  /** 推满了还停着的那一轮：每个进度只写一次警告行（按 nudge 的 key 记） */
  const warned = new Map<string, string>()
  async function warnStopped(id: string, key: string, text: string) {
    if (warned.get(id) === key) return
    warned.set(id, key)
    const tk = sc.live.get(id)?.task ?? (await sc.store.get(id))
    if (!tk) return
    tk.messages.push({
      id: randomUUID(),
      role: 'system',
      agentId: '',
      step: '',
      text,
      tools: [],
      alert: makeAlert('warn', '', 'unfinished'),
      at: new Date().toISOString(),
    })
    const entry = sc.live.get(id)
    if (entry) entry.rev++
    await sc.store.update(id, tk)
    taskLog(id, '计划推进：推满了还停着，留给用户', { key: shortKey(key) })
  }

  /**
   * 收尾自检（ADR 0041 第 3.4 节）：没有面板计划时，不需要计划的事这一轮处理完就算完成，不硬要求列计划
   * （用户 2026-11-02：避免完全靠计划的怪圈）。只在拿不准、又没用 end_turn 交代结束时问一句，结果看动没动手，不解析文字：
   * - 这一轮跑命令、改文件 PLAN_ACTS 处以上：可能做了一半；
   * - 新输入后的第一轮一个工具都没调就结束（「我先看一下代码」就停）：问一次。
   * 2026-11-05 起不限次数：提醒不画进对话，只在状态诊断里记；提醒之后只回了话、没再动手的那一轮不会再问
   * （它不 fresh、也没动手），交代了结束、空转了由 nudgePlan 开头的 settledByEnd 收住。
   * 这一轮列过、收过计划的不推；Chat 页一问一答不推；在等提问、子对话、后台命令的不推
   */
  async function nudgeNoPlan(conv: Task, turn: TurnInfo): Promise<boolean> {
    if (isChatMode(conv)) return false
    // 一条用户（或父对话）消息算一次输入：面板自己推的那条不算（panel）
    const asked = [...conv.messages].reverse().find((m) => m.role === 'user' && !m.panel)
    // 这一轮是不是直接回应这条输入：它之后、这一轮开始之前没有别的消息（后台结果、面板推送开的那一轮不算）
    const fresh =
      !!asked && !!turn.since && !conv.messages.some((m) => m.at > asked.at && m.at < turn.since && m.id !== asked.id)
    const silent = turn.tools === 0 && fresh
    if (!silent && turn.acts < PLAN_ACTS) return false
    // 结束前钩子已经在这一轮里问过（ADR 0049）：它放行的，一轮结束后不再问一遍
    if (asked && conv.messages.some((m) => m.panel === 'hook' && m.at >= asked.at)) return false
    const say = (data: Record<string, unknown>) => taskLog(conv.id, '收尾自检', { ...data, acts: turn.acts })
    const planned = (tk: Task) => {
      const last = tk.plans?.at(-1)
      const at = last ? [last.createdAt, last.updatedAt ?? '', last.doneAt].sort().at(-1)! : ''
      return !!at && !!turn.since && at >= turn.since
    }
    const stalled = async (settled: boolean): Promise<Task | string> => {
      const tk = sc.live.get(conv.id)?.task ?? (await sc.store.get(conv.id))
      if (!tk || tk.imported || taskDeleted(tk)) return 'gone'
      if (tk.working) return 'working'
      if (tk.resolved) return 'resolved'
      if (activePlan(tk) || planned(tk)) return 'planned'
      if (haltedBy(tk)) return `halted:${haltedBy(tk)}`
      if (tk.status === 'failed' || (tk.status === 'stopped' && !reclaimed(tk))) return `status:${tk.status}`
      // 停稳的才推：进程结束了，或者停在保活上等下一句；这期间用户发了消息、开了新一轮就不推
      if (settled && !(tk.status === 'done' || reclaimed(tk) || (tk.status === 'running' && tk.awaitingUser)))
        return `status:${tk.status}`
      if (settled && tk.turnDoneAt !== conv.turnDoneAt) return 'new-turn'
      if (tk.requests.length || tk.parentAsks?.length || diagnosisPending(tk)) return 'asking'
      if (hasHeld(tk.id) || sc.startQueue.has(tk.id)) return 'input-queued'
      if (tk.wrapRequest && tk.wrapRequest.state !== 'failed') return 'wrap'
      if (sc.pendingJobs(tk.id) || helpersWorking(tk) || runRunning(tk) || (await activeChildren(tk.id)))
        return 'waiting'
      return tk
    }
    const first = await stalled(false)
    if (typeof first === 'string') {
      say({ action: 'none', reason: first })
      return false
    }
    // 不限次数：key 只用来计数
    const key = `check:${asked?.id ?? ''}`
    const max = nudgeMax(conv)
    const can = budget.can(conv.id, key, max, inputOf(first))
    if (can !== 'ok') {
      say({ action: 'done', reason: can === 'exhausted' ? 'checked' : can })
      return false
    }
    setTimeout(() => {
      void (async () => {
        const tk = await stalled(true)
        if (typeof tk === 'string') {
          say({ action: 'cancel', reason: tk })
          if (conv.parentTaskId) await reportChild(conv.id)
          return
        }
        const nth = budget.take(conv.id, key, max, inputOf(tk))
        if (!nth) return
        const text = CHECK_REMINDER
        const ok = tk.parentTaskId
          ? (await sc.sendToChild(tk.parentTaskId, tk.id, text, 'nudge')).ok
          : await sc.wakeConv(tk.id, text, { panel: 'nudge' }).then(
              () => true,
              () => false,
            )
        say({ action: ok ? 'check' : 'send-failed', nth })
        if (!ok && conv.parentTaskId) await reportChild(conv.id)
      })().catch((e) => log.warn('task', '收尾自检失败', { task: conv.id, error: (e as Error).message }))
    }, sc.PLAN_NUDGE_MS).unref?.()
    return true
  }

  // 结束前钩子（ADR 0049）：同一套判断、同一个账本，在 CLI 结束这一轮之前就拦住（见 before-end.ts）
  const beforeEnd = createBeforeEnd(sc, { budget, inputOf, haltedBy, activeChildren })

  return {
    nudgePlan,
    nudgeWrapUp,
    beforeEnd,
    nudgeState: (id: string) => budget.state(id),
    resetNudge,
    noteStop,
    clearStop,
  }
}
