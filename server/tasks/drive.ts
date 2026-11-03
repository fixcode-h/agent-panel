import { randomUUID } from 'node:crypto'
import { diagnosisPending } from '../../shared/task.ts'
import type { Task } from '../../shared/schema.ts'
import { planStalled, helpersWorking, runRunning, taskDeleted } from '../../shared/task.ts'
import { isChatMode, nudgeMax } from '../../shared/conv-mode.ts'
import { DriveBudget, planProgressKey, shortKey } from '../../shared/drive.ts'
import { taskLog } from '../task-log.ts'
import { makeAlert } from '../../shared/alerts.ts'
import type { TurnInfo } from '../exec/turn-info.ts'
import { hasHeld } from '../exec/delivery.ts'
import { log } from '../log.ts'
import { t } from '../../shared/i18n.ts'
import { activePlan, needsFix, planProgress, openWork } from '../../shared/plan.ts'
import { getSettings } from '../settings.ts'
import type { TasksScope } from './scope.ts'

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
   * 推对话「接着做」的次数：Agent 模式（顶层对话和子对话）同一个进度最多推设置里的 nudgeMax 次（默认 6，
   * 0 表示不自动推），推了还原地不动就停下，最后一次要它说明卡在哪；Chat 页的对话仍只推一次（见 shared/conv-mode.ts、ADR 0037）。
   * 原来同一进度一律只推一次，用户反馈「走一步就停，催一下又走一步」
   */
  const budget = new DriveBudget()
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
  /** 推满之前的最后一次：要它说明卡在哪，不再只说打算 */
  const lastNudge = (nth: number, max: number) =>
    max > 1 && nth >= max
      ? `这是第 ${nth} 次提醒：如果做不下去，就停下来说明卡在哪一步、需要什么才能继续，不要再只说打算。`
      : ''
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
    // 没有计划的对话：这一轮动了手却没列计划，推它把计划列出来再按计划做完（见 nudgeNoPlan）
    if (!activePlan(conv)) return turn ? nudgeNoPlan(conv, turn) : false
    // 次数上限来自设置，Chat 模式仍是 1（见 shared/conv-mode.ts 的 nudgeMax）
    const max = nudgeMax(conv, (await getSettings()).nudgeMax)
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
      // 子对话到了上限要让父对话知道（ADR 0041）。max=0 时一次都没推、planNudged 没记上，
      // children.ts 的 stuckAfterNudge 判断会把「未完成」这封信吞掉，父计划就一直挂着
      if (conv.parentTaskId) await reportChild(conv.id)
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
          '直接调用工具去做，不用先说明；一步做完就用 set_plan 标完成，并在同一条回复里接着调用工具做下一步，直到计划做完。' +
          '确实卡住了就说明卡在哪一步、需要什么才能继续。' +
          lastNudge(nth, max)
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
   * （用户 2026-11-02：避免完全靠计划的怪圈）。只在拿不准时补一句很短的自检，结果看自检那一轮动没动手，不解析文字：
   * - 这一轮跑命令、改文件 PLAN_ACTS 处以上，没有计划：可能做了一半，同一条输入最多自检 2 次；
   * - 新输入后的第一轮一个工具都没调就结束（「我先看一下代码」就停）：自检一次，纯问答多一轮很短的确认。
   * 原来这里推它「先用 set_plan 列计划」，小事也被逼着列计划。
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
    // 没调工具的那种每条输入只自检一次（自检那一轮它确认完成也是没调工具，不能再问）；动了手的最多 2 次，
    // 两种都不超过设置里的提醒次数，设成 0 时一次都不推
    const key = `${silent ? 'check0' : 'check'}:${asked?.id ?? ''}`
    const max = Math.min(silent ? 1 : 2, nudgeMax(conv, (await getSettings()).nudgeMax))
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
        const text =
          '【面板】（收尾自检）这次的事做完了吗？没做完就直接调用工具接着做，不用先说明；' +
          '做完了就用一两句话确认结果，不用列计划。确实卡住了就说明卡在哪、需要什么。'
        const ok = tk.parentTaskId
          ? (await sc.sendToChild(tk.parentTaskId, tk.id, text, 'nudge')).ok
          : await sc.wakeConv(tk.id, text, { panel: 'nudge' }).then(
              () => true,
              () => false,
            )
        say({ action: ok ? 'check' : 'send-failed', kind: silent ? 'no-tools' : 'acts', nth, max })
        if (!ok && conv.parentTaskId) await reportChild(conv.id)
      })().catch((e) => log.warn('task', '收尾自检失败', { task: conv.id, error: (e as Error).message }))
    }, sc.PLAN_NUDGE_MS).unref?.()
    return true
  }

  return { nudgePlan, nudgeState: (id: string) => budget.state(id), resetNudge, noteStop, clearStop }
}
