/**
 * 子对话完成的单向流转：wrapup → plan → pending → complete → report → list，每一步差什么、给用户看的那句话。
 * 从 task.ts 拆出来（文件行数上限），task.ts 原样转出，调用方仍可从 @shared/task 引用。
 * 只在函数里用 task.ts 的判定（convState、childHolds 这些），模块初始化时不取它的值，和 task.ts 互相引用也不会取到未定义
 */
import type { Task } from './schema.ts'
import { t } from './i18n.ts'
import { openPlan } from './plan.ts'
import { pendingAction } from './user-action.ts'
import { helpersWorking } from './task-helpers.ts'
import { childHolds, diagnosisPending, runRunning, type ChildHold } from './task.ts'

/**
 * 子对话完成是一条单向的状态流转，必须按这个先后走，谁都不能跳步（见 advanceChild）：
 * wrapup 这一轮收尾 → plan 计划全做完 → pending 后台命令 / 工作流 / 派出的子任务 / 提问 / 请求都收口
 * → complete 子对话自己置完成 → report 上报父对话 → list 父对话列表按上报的状态刷新。
 *
 * 「父对话点标记完成」「合并成功」都只是发起这一趟流转（见 server/tasks.ts 的 advanceChildTo），
 * 判定和置完成仍然在子对话这一侧，父对话不直接改最终状态。
 */
export type ChildFlowStep = 'wrapup' | 'plan' | 'pending' | 'complete' | 'report' | 'list'

/** 流转的先后：只能从前往后走，中间不能跳过任何一步 */
export const childFlowSteps = [
  'wrapup',
  'plan',
  'pending',
  'complete',
  'report',
  'list',
] as const satisfies readonly ChildFlowStep[]

/** 流转要看的子对话现状：条件和 childHolds 一致，多两个「走到哪一步」的标记 */
export type ChildFlowState = Parameters<typeof childHolds>[0] & {
  /** 子对话这一侧已经把自己置为完成（resolved）：只有它能写这一步 */
  completed?: boolean
  /** 父对话已经收到「子对话已完成」的上报 */
  reported?: boolean
}

/**
 * 子对话的任务状态换成流转要看的现状：服务端判定、置完成和界面显示都从这里取，不要各写一套。
 * merged 传 false 表示独立分支还没合回去；reported 表示父对话已经收到过这次完成的上报。
 */
export function childFlowOf(
  task: Pick<Task, 'status' | 'working' | 'requests' | 'parentAsks' | 'plans' | 'steps'> & {
    runs?: Task['runs']
    resolved?: boolean
    diagnoses?: Task['diagnoses']
    userActions?: Task['userActions']
  },
  x: { background?: number; merged?: boolean; reported?: boolean; parentTest?: boolean } = {},
): ChildFlowState {
  return {
    working: task.working,
    background: x.background,
    workflow: runRunning(task),
    helpers: helpersWorking(task),
    plan: openPlan(task),
    asking: task.parentAsks?.length ?? 0,
    // 诊断报告等确认（ADR 0045）和等确认的请求一样拦着完成
    requests: task.requests.length + (diagnosisPending(task) ? 1 : 0) + (pendingAction(task) ? 1 : 0),
    unmerged: x.merged === false,
    parentTest: x.parentTest,
    completed: task.resolved === true,
    reported: x.reported,
  }
}

/** 某一步自己还差什么（前一步过没过由 stepPassed 管）：空数组表示这一步的条件已经满足 */
export function childStepHolds(x: ChildFlowState, step: ChildFlowStep): ChildHold[] {
  if (step === 'wrapup') return childHolds({ working: x.working })
  if (step === 'plan') return childHolds({ plan: x.plan })
  if (step === 'pending')
    return childHolds({
      background: x.background,
      workflow: x.workflow,
      helpers: x.helpers,
      asking: x.asking,
      requests: x.requests,
      unmerged: x.unmerged,
      // 合回了但父对话的测试还没跑完：不能标完成、不能删分支（ADR 0018）。
      // 只加在 ChildFlowState 上而不传进来，这个 hold 永远不会生效（评审 R1）
      parentTest: x.parentTest,
    })
  // 后三步没有额外条件：走到没走到由 completed / reported 记着，不看别的
  return []
}

/** 这一步走完了没有：前一步没走完，这一步不管自己的条件满不满足都算没到 */
function stepPassed(x: ChildFlowState, step: ChildFlowStep): boolean {
  const i = childFlowSteps.indexOf(step)
  if (i > 0 && !stepPassed(x, childFlowSteps[i - 1])) return false
  if (step === 'complete') return !!x.completed
  if (step === 'report') return !!x.reported
  // 父对话的列表是按上报的状态派生出来的：上报了这一步就算过了，列表不会早于上报
  if (step === 'list') return !!x.reported
  return childStepHolds(x, step).length === 0
}

/** 现在卡在哪一步：返回前面几步都走完、自己还没走完的第一步；全部走完返回 null */
export function childFlowAt(x: ChildFlowState): ChildFlowStep | null {
  return childFlowSteps.find((s) => !stepPassed(x, s)) ?? null
}

/** 推进时某一步交回「还不该走」的原因（如独立分支回收失败）：交回后就停在这一步，不往下走 */
export interface ChildFlowStop {
  holds: ChildHold[]
  /** 给用户看的原因；不写就用 childHoldText(holds) */
  info?: string
}

/** 流转要做的三件事：子对话置完成、上报父对话、让父对话列表重取 */
export interface ChildFlowHost {
  /** 第 4 步：子对话这一侧把自己置为完成（回收独立分支也在这里）；交回还差什么就停在这一步 */
  complete(): void | ChildFlowStop | Promise<void | ChildFlowStop>
  /** 第 5 步：把「子对话已完成」上报给父对话 */
  report(): void | Promise<void>
  /** 第 6 步：需要额外通知页面重新取列表时提供；列表本身不在这里改写（只读子对话的状态） */
  list?(): void | Promise<void>
}

export interface ChildFlowRun {
  /** 这次真正做了的步骤，按先后顺序 */
  steps: ChildFlowStep[]
  /** 还没走完的步骤，第一项就是卡住的那一步；空数组表示整条链走完了 */
  left: ChildFlowStep[]
  /** 卡住的原因（见 childHoldText），空数组表示这一侧能做的都做了 */
  holds: ChildHold[]
  /** 卡住的说明，没卡住是空字符串 */
  info: string
}

/**
 * 按 wrapup → plan → pending → complete → report → list 依次推进，前一步没走完就停在原地。
 * 幂等：已经置过完成的不再置一次、已经上报过的不再报一次，重复调用只会从卡住的那一步接着走。
 * 父对话侧的动作（标记完成、合并成功、一轮结束收口）只调用它，不直接写子对话的最终状态。
 */
export async function advanceChild(x: ChildFlowState, host: ChildFlowHost): Promise<ChildFlowRun> {
  const state: ChildFlowState = { ...x }
  const steps: ChildFlowStep[] = []
  const stop = (at: number, holds: ChildHold[], info = ''): ChildFlowRun => ({
    steps,
    left: [...childFlowSteps.slice(at)],
    holds,
    info,
  })
  let i = childFlowSteps.findIndex((s) => !stepPassed(state, s))
  // 全部走完了：重复调用什么都不做
  if (i < 0) return { steps, left: [], holds: [], info: '' }
  for (; i < childFlowSteps.length; i++) {
    const step = childFlowSteps[i]
    // 前三步是「等条件」：不满足就停在原地，把还差什么交回去
    if (step === 'wrapup' || step === 'plan' || step === 'pending') {
      const holds = childStepHolds(state, step)
      if (holds.length) return stop(i, holds, childHoldText(holds))
      continue
    }
    if (step === 'complete') {
      const refused = await host.complete()
      if (refused && refused.holds.length) return stop(i, refused.holds, refused.info ?? childHoldText(refused.holds))
      state.completed = true
    } else if (step === 'report') {
      await host.report()
      state.reported = true
    } else await host.list?.()
    steps.push(step)
  }
  return { steps, left: [], holds: [], info: '' }
}

/** 还差什么才算做完：给用户看的一句话（分支状态行、标记完成的提示共用） */
export function childHoldText(holds: ChildHold[]) {
  const what: Record<ChildHold, string> = {
    working: t('这一轮还在执行'),
    background: t('后台命令还没跑完'),
    workflow: t('工作流还没跑完'),
    helpers: t('派出的子任务还没跑完'),
    plan: t('计划还没做完'),
    asking: t('还有等你回答的提问'),
    requests: t('还有等你确认的请求'),
    unmerged: t('独立分支还没合回原分支'),
    parentTest: t('父对话的测试还没通过'),
  }
  return holds.map((h) => what[h]).join(t('、'))
}
