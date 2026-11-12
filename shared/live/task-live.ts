/**
 * 对话的运行时状态（TaskLive）：服务端按进程登记、后台命令、名下子对话算好，和任务记录分开交给页面。
 *
 * 为什么单独一个类型（重构文档第 1、2 条）：以前这些字段（cliAlive、jobs、childrenWorking……）直接叠在 Task 上，
 * 只有列表、详情、推送带，停止、改名这类接口顺手回的任务不带。页面拿到一份 Task 不知道这次带没带，
 * 只好「没带就沿用上一份」（keepLiveFields），不然转圈和「等你处理」会闪；各组件又各拿 status / working / cliAlive 拼状态，
 * 和服务端的 convState 各说各的。现在：
 * - 状态（state）和「等什么」只在服务端经 taskLiveOf 算一次，页面只读它，不再碰 status / working / cliAlive；
 * - 运行时字段只在 TaskLive 里，不进任务记录，也就落不了盘（见 server/tasks/live.ts）。
 */
import { z } from 'zod'
import { TaskJob, type Task } from '../schema.ts'
import { convActive, taskFacts, taskTurnUnread, type TaskFactsInput } from '../task.ts'
import { kindWord, stateKind, type StateKind } from '../task-word.ts'

export const ConvStateSchema = z.enum([
  'running',
  'waiting',
  'needs',
  'failed',
  'stopped',
  'unfinished',
  'wrapup',
  'done',
])

export const TaskLive = z.object({
  /** 对外的状态：侧栏、标题栏、项目首页、标签页、运行区都只认它（见 shared/task.ts 的 convState） */
  state: ConvStateSchema,
  /** 等你处理的是哪一类（state 为 needs 时） */
  need: z.enum(['answer', 'confirm', 'stage', 'action', 'children']).optional(),
  /** 等结果时在等什么（state 为 waiting 时） */
  wait: z.enum(['children', 'helpers', 'background', 'workflow']).optional(),
  /** 交了 Bug 诊断报告等你确认（ADR 0045）：状态仍是执行中，短词写「报告待确认」 */
  report: z.boolean().optional(),
  /**
   * 停在等下一句：这一轮说完了，CLI 还活着在等用户的下一条消息（「等待你的下一条消息」只认它）。
   * 以前各处拿 status === 'running' && cliAlive && !working 自己拼
   */
  next: z.boolean(),
  /**
   * 这个对话现在有活着的 CLI 进程（按真实进程登记算）：
   * 「等待你的下一条消息」、标题流光、侧栏提示只认它，CLI 关了就绝不显示
   */
  cliAlive: z.boolean(),
  /** 还在跑或排队的后台命令：对话这一轮已经说完、命令还在后台跑时，界面靠它在回复上面转圈 */
  jobs: z.array(TaskJob),
  /** 名下还在运行的子对话数（只有顶层对话算，子对话页是 0） */
  childrenWorking: z.number().int().min(0),
  /** 名下有活着的 CLI 进程的子对话数（只有顶层对话算）：不点开也能看出子对话还开着 CLI */
  childrenCli: z.number().int().min(0),
  /** 后代对话里在等用户确认、回答的个数：有它时这个对话也是「等你处理」 */
  childrenNeeds: z.number().int().min(0),
})
export type TaskLive = z.infer<typeof TaskLive>

/** 服务端才知道的那几项：进程登记、后台命令、名下子对话的计数 */
export type LiveRuntime = Pick<TaskLive, 'cliAlive' | 'jobs' | 'childrenWorking' | 'childrenCli' | 'childrenNeeds'>

/** 判定状态要看的任务事实：和 taskFacts 同一份，再加第一条请求的种类（分辨「等你回答」和「等你确认」） */
export type LiveFactsInput = Omit<TaskFactsInput, 'jobs' | 'childrenWorking' | 'childrenNeeds'>

/**
 * 运行时状态的唯一算法：任务记录 + 服务端的运行时事实 → TaskLive。
 * 服务端（server/tasks/live.ts）和演示后端都只调它，页面不自己算
 */
export function taskLiveOf(task: LiveFactsInput, rt: LiveRuntime): TaskLive {
  const facts = { ...task, jobs: rt.jobs, childrenWorking: rt.childrenWorking, childrenNeeds: rt.childrenNeeds }
  const next = rt.cliAlive && task.status === 'running' && !task.working
  return { ...liveKind(facts), next, ...rt }
}

/**
 * 按事实判定的函数（diagnoseTask、taskWord 一类）要的那份输入：任务记录加上 live 里的运行时事实。
 * 页面拿到的任务记录不带这几项，直接传任务会把「在等后台命令 / 子对话」算丢
 */
export const withLiveFacts = <T extends object>(task: T, live: LiveRuntime) => ({
  ...task,
  cliAlive: live.cliAlive,
  jobs: live.jobs,
  childrenWorking: live.childrenWorking,
  childrenNeeds: live.childrenNeeds,
})

/** 状态分类：和 taskWord 同一份事实（shared/task-word.ts），只是不带文字 */
function liveKind(x: TaskFactsInput): StateKind {
  return stateKind({ ...taskFacts(x), request: x.requests?.[0]?.kind })
}

/** 状态短词：标题栏胶囊、侧栏行尾、输入框占位都只显示它 */
export const liveWord = (l: Pick<TaskLive, 'state' | 'need' | 'wait' | 'report'>) => kindWord(l)

/** 列表里的「执行中」（转圈）：自己在执行，或者在等结果。等你处理不转圈，画成提问图标 */
export const liveBusy = (l: Pick<TaskLive, 'state'> | undefined) => l?.state === 'running' || l?.state === 'waiting'

/** 还在运行（不能被回收、失活）：见 convActive */
export const liveActive = (l: Pick<TaskLive, 'state'> | undefined) => !!l && convActive(l.state)

/**
 * 行首要不要画橙点（「这一轮做完、你还没看」）：和 taskDoneDot 同一口径，状态读 live。
 * 未读是上一轮完成时留下的历史事实，对话后来又跑起来时它还在：只有确实停在完成态才画，当前打开的不画
 */
export function liveDoneDot(
  task: Pick<Task, 'turnDoneAt' | 'turnSeenAt'>,
  live: Pick<TaskLive, 'state' | 'jobs'>,
  viewing = false,
) {
  return liveDot(
    live,
    taskTurnUnread({ turnDoneAt: task.turnDoneAt, turnSeenAt: task.turnSeenAt, jobs: live.jobs }),
    viewing,
  )
}

/** 同上，「未读」由调用方给（侧栏会叠上本地刚点开过的那一轮） */
export const liveDot = (live: Pick<TaskLive, 'state'>, unread: boolean, viewing = false) =>
  unread && !viewing && live.state === 'done'

/** 「等结果」时在等什么、名下子对话在等你时也写出来；别的状态是空串（和 taskWaitText 同一口径） */
export const liveWaitText = (l: Pick<TaskLive, 'state' | 'need' | 'wait' | 'report'> | undefined) =>
  l && (l.wait || l.need === 'children') ? liveWord(l) : ''

/**
 * 不落盘的字段：运行时的那几项（以后只在 TaskLive 里）、列表摘要才带的 askedAt、
 * 还有 runner 直接写在内存任务上的 drafting（模型正在写哪个工具的入参）。
 * 写盘前剥掉（server/task-store.ts），旧版本存过的由数据迁移清掉
 */
export const NOT_STORED_FIELDS = [
  'cliAlive',
  'jobs',
  'drafting',
  'childrenWorking',
  'childrenNeeds',
  'childrenCli',
  'askedAt',
] as const
