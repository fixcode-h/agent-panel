// runAgent 一次调用里各阶段共享的可变状态（重构文档第 3 条）。
//
// 以前这些是 runAgent 闭包里的二十几个 `let`，内层函数（收事件、等下一句、插话、收尾）各自读写，
// 哪个变量被谁改了只能从头读到尾。现在收进一个显式的对象，拆出去的阶段函数拿到它就知道自己会动哪些状态。
// 谁读谁写见 docs/modules/server-exec/README.md 的「runAgent 的共享状态」。
import type { TaskMessage } from '../../shared/schema.ts'
import type { CliControl } from './invoke.ts'
import type { CliEvent } from './parsers.ts'
import type { Steerer } from './steering.ts'

export interface RunState {
  /** 预热中：输出不记进对话，用户发来第一句（或插话被收下）后变成 false */
  prewarmMode: boolean
  /**
   * 当前这一轮从哪开始：保活时一个进程会连着处理好几条用户消息，mine 里堆着前几轮的回复。
   * 判「这一轮什么都没做」只能看这一轮自己的输出，不然前一轮的正文会把后面的空回合盖住，
   * 用户的消息落进死回合既没回复也没报错。input 是这一轮要处理的要求，空回合重试时重发它
   */
  turnMark: { from: number; touched: number; input: string }
  /** 这一轮的改动卡片已经拍了起点、还没收口 */
  changesOpen: boolean
  /** 正在往里写输出的那条回复；置 undefined 表示之后的输出另起一条 */
  cur: TaskMessage | undefined
  /** CLI 报的这一轮结果（最后一次） */
  result: Extract<CliEvent, { type: 'result' }> | undefined
  /** CLI 报告过窗口后就以它为准，后面没带窗口的用量事件不要改回估计值 */
  reported: boolean
  /** 这一轮收到过用量事件：一个都没收到时统计不可信，要告给用户（不能把 0 当成真没消耗） */
  usageSeen: boolean
  /** 正在思考的那条消息和第一段思考到达的时刻：思考之后来了别的输出，思考就结束了 */
  thinkingOf: { m: TaskMessage; at: number } | undefined
  /** 边跑边刷新 git 改动的节流定时器和「正在读」标记 */
  gitTimer: ReturnType<typeof setTimeout> | undefined
  gitBusy: boolean
  /** CLI 进程已经结束（invokeCli 返回前的 finally 置上） */
  finished: boolean
  /** 这一段的「一轮结束」回调已经发过（见 endTurn） */
  turnEnded: boolean
  /** 重试提示前安静了多久：heard() 清零前记下 */
  quietBefore: number
  /** 补充：交给 CLI 成功后，之后的输出另起一条，排在用户消息后面 */
  steerer: Steerer | undefined
  /** 延迟取走的补充：消息已经显示在对话里，CLI 开始下一次模型请求时再把后面的输出另起一条 */
  steerPending: boolean
  /**
   * 插话收下时 Agent 正说到一半：CLI 让模型把这段话说完才看插话，面板也等这段说完再另起一条。
   * 收下就断开的话，后半句会跑到用户消息下面，一句话被劈成两半（用户报过）
   */
  cutAfter: boolean
  /** CLI 的控制句柄（插话、停下命令） */
  control: CliControl | undefined
  /** 补充排在长命令后面时，到点停下命令的定时器 */
  redirectTimer: ReturnType<typeof setTimeout> | undefined
  /** 模型在这一轮里调用过 wait_user_message：结束时不用再保活一次 */
  toolWaited: boolean
  /** 停在等待上等子任务：CLI 本来就没有输出，不算卡住 */
  waitingHelpers: boolean
  /** 最近一次等到的是送进来的消息（用户 / 面板消息），不是子任务交回的结果 */
  fromUser: boolean
}

export function newRunState(prewarm: boolean, prompt: string): RunState {
  return {
    prewarmMode: prewarm,
    turnMark: { from: 0, touched: 0, input: prompt },
    changesOpen: false,
    cur: undefined,
    result: undefined,
    reported: false,
    usageSeen: false,
    thinkingOf: undefined,
    gitTimer: undefined,
    gitBusy: false,
    finished: false,
    turnEnded: false,
    quietBefore: 0,
    steerer: undefined,
    steerPending: false,
    cutAfter: false,
    control: undefined,
    redirectTimer: undefined,
    toolWaited: false,
    waitingHelpers: false,
    fromUser: false,
  }
}
