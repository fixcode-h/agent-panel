import type { Task } from '../../shared/schema.ts'
import {
  diagnosisPending,
  helpersWorking,
  planStalled,
  runRunning,
  taskDeleted,
  wrapUpPending,
} from '../../shared/task.ts'
import { isChatMode, nudgeMax } from '../../shared/conv-mode.ts'
import { planProgressKey, shortKey, type DriveBudget } from '../../shared/drive.ts'
import { activePlan, needsFix, openWork, panelWrap, planProgress } from '../../shared/plan.ts'
import { allowEnd, type BeforeEndDecision, type BeforeEndInput } from '../../shared/hooks.ts'
import { hasHeld } from '../exec/delivery.ts'
import { taskLog } from '../task-log.ts'
import { getSettings } from '../settings.ts'
import type { TasksScope } from './scope.ts'
import { isolated } from './helpers.ts'

/** 没列计划时，这条输入以来动手（跑命令、改文件）几次以上才算「可能做了一半」：和收尾自检同一个门槛 */
const WORKED_ACTS = 3
/** 只读的工具（读文件、搜索）几次折算成一次动手：排查类的事以读为主，也要接得住做到一半就停 */
const READS_PER_ACT = 3

/**
 * 对话（顶层对话、子对话）的结束前判断（ADR 0049）：模型准备结束这一轮时 CLI 问到这里，
 * 返回 block 就在同一轮里接着做，不再等这一轮结束后另发一条【面板】提醒。
 *
 * 判断和一轮结束后的提醒（drive.ts 的 nudgePlan / nudgeWrapUp / nudgeNoPlan）是同一套：只看计划、提问、子对话、
 * 后台命令、收尾请求，不读回复文字。次数记在同一个账本（DriveBudget）、用同样的 key，所以钩子拦过的不会再被提醒补一遍，
 * 推满了钩子放行后，提醒那边看到同一个进度已经推满，照常留警告给用户。
 */
export function createBeforeEnd(
  sc: TasksScope,
  d: {
    budget: DriveBudget
    /** 这条输入（用户或父对话最近的一条消息）：次数按它分开数 */
    inputOf: (tk: Task) => string
    /** 被叫停的原因（用户暂停、父对话停下……）；页面切走、闲置回收不算 */
    haltedBy: (tk: Task) => string
    activeChildren: (id: string) => Promise<number>
    /** 推满之前最后一次的那句「做不下去就说明卡在哪」 */
    lastNudge: (nth: number, max: number) => string
  },
) {
  const { budget, inputOf } = d

  /** 在等别人的东西（提问、排队的输入、后台命令、子任务、子对话）：这时结束这一轮是对的，结果会推回来 */
  async function waitingOn(tk: Task): Promise<string> {
    if (d.haltedBy(tk)) return `halted:${d.haltedBy(tk)}`
    if (tk.requests.length || tk.parentAsks?.length || diagnosisPending(tk)) return 'asking'
    if (hasHeld(tk.id) || sc.startQueue.has(tk.id)) return 'input-queued'
    if (sc.background.list(tk.id).some((j) => j.state === 'queued' || j.state === 'running')) return 'background'
    if (helpersWorking(tk) || runRunning(tk)) return 'helpers'
    const wrap = tk.wrapRequest?.state
    if (wrap === 'requested' || wrap === 'merging' || wrap === 'testing') return `wrap:${wrap}`
    return ''
  }

  /** 父对话名下请过收尾、还没处理的子对话（和 nudgeWrapUp 同一个判断） */
  async function wrapWaiting(tk: Task) {
    if (tk.parentTaskId || !tk.projectId) return []
    const kids = (await sc.store.list())
      .filter((k) => k.parentTaskId === tk.id)
      .map((k) => sc.live.get(k.id)?.task ?? k)
    return wrapUpPending(kids).filter((k) => !sc.merging.has(k.id) && !hasHeld(k.id) && !sc.startQueue.has(k.id))
  }

  /**
   * 这条输入以来的工具调用：动手（跑命令、改文件）和只读（读文件、搜索）分开数。
   * 已经自检过（钩子拦过、或一轮结束后提醒过）的，从最近那次自检之后数：确认做完以后没再动手的不再问第二遍
   */
  function workSince(tk: Task, inputId: string) {
    const asked = tk.messages.findIndex((m) => m.id === inputId)
    let checked = -1
    tk.messages.forEach((m, i) => {
      if (i > asked && (m.panel === 'hook' || m.panel === 'nudge')) checked = i
    })
    const at = Math.max(asked, checked)
    let acts = 0
    let reads = 0
    for (const m of at >= 0 ? tk.messages.slice(at + 1) : tk.messages)
      for (const x of m.role === 'agent' ? m.tools : []) {
        if (x.kind === 'run' || x.kind === 'edit') acts++
        else if (x.kind === 'read' || x.kind === 'search') reads++
      }
    return { acts, reads, tools: acts + reads, checked: checked >= 0 }
  }

  const mergeOwed = (tk: Task) => mergeOwedOf(tk, sc.mergeNudged.has(tk.id))

  /** 拦住时在预算里记一次；推满了返回 0 */
  const take = (tk: Task, key: string, max: number) => budget.take(tk.id, key, max, inputOf(tk))

  async function decide(convId: string, input: BeforeEndInput): Promise<BeforeEndDecision> {
    const tk = sc.live.get(convId)?.task ?? (await sc.store.get(convId))
    if (!tk || tk.imported || taskDeleted(tk)) return allowEnd('gone')
    // 预热还没收到用户的消息：这时结束是在停下等下一句，不是没做完（收到消息后 runner 会清掉 prewarming）
    if (tk.prewarming) return allowEnd('prewarm')
    // Chat 页一问一答不拦（用户 2026-11-04 定）
    if (isChatMode(tk)) return allowEnd('chat')
    const busy = await waitingOn(tk)
    if (busy) return allowEnd(busy)
    const max = nudgeMax(tk, (await getSettings()).nudgeMax)

    // 子对话请父对话收尾了、父对话还没处理：先收尾（这时计划那一步写着「等子对话」，按计划会当成在等别人）
    const wrap = await wrapWaiting(tk)
    if (wrap.length) {
      const key = `wrap:${wrap.map((k) => `${k.id}@${k.wrapRequest!.at}`).join(',')}`
      const nth = take(tk, key, max)
      if (!nth) return allowEnd('wrap-exhausted')
      const lines = wrap.map(
        (k) =>
          `- 「${k.title}」（id ${k.id}）：${k.worktree?.state === 'active' ? '合回它的独立分支' : '验收它的改动'}，验证够了就调用 finish_child（id ${k.id}）；要它补的用 send_to_conversation 交回`,
      )
      return {
        block: true,
        why: 'wrap-pending',
        reason:
          `【面板】这些子对话已经请你收尾，它们一直在等你，先处理再结束：\n${lines.join('\n')}\n` +
          '直接调用工具处理，不用先说明；收尾请求里有它的验证结果，核对后决定合回还是交回。' +
          d.lastNudge(nth, max),
      }
    }

    // 子对话做完了、只差请父对话收尾却要结束（用户报过：说一句「现在收尾」就停，没调 submit_merge）：
    // 以前等这一轮结束后由 nudgeMerge 另发一条提醒，现在在同一轮里拦住。只看计划和改动清单，不跑 git
    const merge = mergeOwed(tk)
    if (merge) {
      const nth = take(tk, `merge:${inputOf(tk)}`, 1)
      if (nth) {
        // 一轮结束后的那条提醒不再补发（同一个记号，见 children.ts 的 nudgeMerge）
        sc.mergeNudged.add(tk.id)
        taskLog(tk.id, '结束前钩子：没请收尾，拦住', { why: merge })
        return {
          block: true,
          why: 'merge-owed',
          reason: isolated(tk)
            ? '【面板】你还没请父对话收尾：独立分支里的改动没合回之前不算做完。按「验证」跑通编译和测试，然后直接调用 submit_merge（tests 写上跑了什么、结果如何），父对话会合并、标完成并删除分支；不要自己 git merge。验证没过就修好再交，确实不该合并就说明原因。'
            : '【面板】你还没请父对话验收：改了代码先按「收尾前评审」派评审、逐条处置，按「验证」跑通编译和测试，再直接调用 submit_merge（tests 写上跑了什么、结果如何，handoff 写交接要点）。确实不该交付就说明原因。',
        }
      }
    }

    const plan = activePlan(tk)
    if (plan) {
      // 这一轮还在进行中（working 为真）：按「停下来以后」判断，其余条件和一轮结束后的提醒一样
      if (!planStalled({ ...tk, working: false })) return allowEnd('plan-not-stalled')
      if (await d.activeChildren(tk.id)) return allowEnd('children')
      const key = planProgressKey(plan)
      const nth = take(tk, key, max)
      if (!nth) return allowEnd('plan-exhausted')
      const p = planProgress(tk, plan)
      const left = openWork(tk)
      const failed = left.find(needsFix)
      const next = failed ?? left.find((s) => s.status === 'running') ?? left[0]
      taskLog(tk.id, '结束前钩子：计划没做完，拦住', { done: p.done, total: p.total, key: shortKey(key), nth, max })
      return {
        block: true,
        why: 'plan-open',
        reason:
          `【面板】你的计划才做了 ${p.done}/${p.total}，也没有在等任何结果，先别结束。` +
          (failed
            ? `「${failed.title}」${failed.note}。先查清原因、修好后重做；确实不做了就标成跳过并说明原因，然后接着做计划。`
            : next
              ? `接着做「${next.title}」：`
              : '接着做下一步：') +
          '直接调用工具去做，不用先说明；一步做完就用 set_plan 标完成，接着做下一步，直到计划做完。' +
          '确实卡住了就说明卡在哪一步、需要什么才能继续。' +
          d.lastNudge(nth, max),
      }
    }

    // 没列计划：这条输入以来一个工具都没调就要结束（「我先看一下」就停），或者动了手、可能做了一半，各问一次
    const asked = [...tk.messages].reverse().find((m) => m.role === 'user' && !m.panel)
    if (!asked) return allowEnd('no-input')
    // 这一轮列过、收过计划：按计划那一档算，不再自检
    const last = tk.plans?.at(-1)
    const planAt = last ? [last.createdAt, last.updatedAt ?? '', last.doneAt].sort().at(-1)! : ''
    if (planAt && planAt >= asked.at) return allowEnd('planned')
    if (await d.activeChildren(tk.id)) return allowEnd('children')
    const w = workSince(tk, asked.id)
    // 一个工具都没调就要结束：只在还没自检过时问（自检那一轮确认做完本来就不调工具，不能再问）
    const silent = !w.checked && w.tools === 0
    if (!silent && w.acts + Math.floor(w.reads / READS_PER_ACT) < WORKED_ACTS) return allowEnd('small')
    // 和收尾自检同一个 key：钩子问过的，一轮结束后不会再问一遍
    const key = `${silent ? 'check0' : 'check'}:${asked.id}`
    const nth = take(tk, key, Math.min(silent ? 1 : 2, max))
    if (!nth) return allowEnd('checked')
    taskLog(tk.id, '结束前钩子：没列计划，自检一次', { ...w, nth, again: input.again || undefined })
    return {
      block: true,
      why: silent ? 'check-no-tools' : 'check-worked',
      reason:
        '【面板】（收尾自检）这次的事做完了吗？没做完就直接调用工具接着做，不用先说明；' +
        '做完了就用一两句话确认结果，不用列计划。确实卡住了就说明卡在哪、需要什么。',
    }
  }

  return async (convId: string, input: BeforeEndInput): Promise<BeforeEndDecision> => {
    const r = await decide(convId, input)
    if (!r.block) taskLog(convId, '结束前钩子：放行', { why: r.why, again: input.again || undefined })
    return r
  }
}

/**
 * 子对话该请收尾却还没请：计划只剩收尾那一步（别的都做完了），或者没列计划但改过文件。
 * 已经请过、已经提醒过（nudged）、被收下的不算；返回原因，不该拦返回空。只看计划和改动清单，不跑 git
 */
export function mergeOwedOf(
  tk: Pick<Task, 'parentTaskId' | 'resolved' | 'wrapRequest' | 'plans' | 'steps' | 'changes'>,
  nudged: boolean,
): string {
  if (!tk.parentTaskId || tk.resolved || tk.wrapRequest || nudged) return ''
  const plan = activePlan(tk)
  if (plan) {
    const wrapOpen = plan.steps.some((s) => panelWrap(s.wrapUp) && s.status !== 'done')
    return wrapOpen && !openWork(tk).length ? 'plan-wrap-left' : ''
  }
  return tk.changes.length ? 'changed-no-plan' : ''
}
