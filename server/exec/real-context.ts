/** 一轮真实执行的宿主上下文：runner、各个拆出去的模块都按它取任务、设置、回调 */
import type { Agent, CliStatus, Project, Settings, StopReason, Task, Workflow } from '../../shared/schema.ts'
import type { AgentCall, EngineHost } from '../../shared/engine/host.ts'
import type { TurnInfo } from './turn-info.ts'

export interface RealContext {
  task: Task
  agents: Agent[]
  workflows: Workflow[]
  workflow?: Workflow
  project: Project
  settings: Settings
  clis: CliStatus[]
  /** 本轮用户输入 */
  prompt: string
  signal: AbortSignal
  /** 为什么停下这一轮：'user' 是用户按的暂停，其余是顺带结束的动作（见 EngineHost.stopReason） */
  stopReason?: () => StopReason | undefined
  /**
   * 开始保活（CLI 回复完停在等下一句）时通知宿主：宿主按全局上限收掉最久没用的保活会话，
   * 不然页面开着过、又切走的对话会各留一个进程，叠起来就是十几个
   */
  onKeepAlive?: (taskId: string) => void
  /**
   * 对话这一轮真的结束了（CLI 报了这一轮的结果，或者回复完停在等下一句）。
   * 子对话靠它收口父对话计划里等自己的步骤：进程会被保活留着等下一句，run 不会返回，收尾处的回报等不到。
   * tools：这一轮调用过几次工具（顶层对话据此分辨「做到一半停了」和「只是回答了一句话」）
   */
  onTurnEnd?: (turn: TurnInfo) => void
  changed: (flush?: boolean) => void
  newId: () => string
  /** 任务所在目录是否是 git 仓库（决定改动从 git 读还是从工具调用里统计） */
  isGit: boolean
  /** 这一轮不是普通的对话：压缩上下文，或者审查代码 */
  op?: AgentCall['op']
  /** 「继续流程」：见 EngineHost.resume */
  resume?: boolean
  /** 打开对话页时后台用 --resume 启动，只等下一句 */
  prewarm?: boolean
  prewarmFrom?: Task['status']
  prewarmTurnDoneAt?: string
  /** 对话 Agent 启动计划、分派子对话用的项目数据（见 EngineHost） */
  workflowCatalog?: EngineHost['workflowCatalog']
  resolveWorkflow?: EngineHost['resolveWorkflow']
  listConversations?: EngineHost['listConversations']
  createConversation?: EngineHost['createConversation']
  sendToConversation?: EngineHost['sendToConversation']
  /** 父子对话之间的通讯和文件认领（见 EngineHost） */
  rules?: EngineHost['rules']
  goal?: EngineHost['goal']
  takeInbox?: EngineHost['takeInbox']
  messageParent?: EngineHost['messageParent']
  claimFiles?: EngineHost['claimFiles']
  releaseFiles?: EngineHost['releaseFiles']
  /** 子对话点名「禁止子对话执行」的角色时转交父对话（见 ADR 0019） */
  forwardSpawn?: EngineHost['forwardSpawn']
  /** 对话级的 Orchestra：宿主拿它在父对话正在跑时派转交来的子任务 */
  onOrchestra?: EngineHost['onOrchestra']
  /** 对话的结束前判断（ADR 0049，见 server/tasks/before-end.ts） */
  beforeEnd?: EngineHost['beforeEnd']
  childIsolation?: EngineHost['childIsolation']
  worktreeHome?: EngineHost['worktreeHome']
  branch?: EngineHost['branch']
  wrapUp?: EngineHost['wrapUp']
  p4Split?: EngineHost['p4Split']
  cherryPick?: EngineHost['cherryPick']
  submitMerge?: EngineHost['submitMerge']
  isolated?: EngineHost['isolated']
  finishChild?: EngineHost['finishChild']
  /** 父对话名下的工作流运行（server/tasks/flow-runs.ts）：只给项目里的顶层对话 */
  runs?: EngineHost['runs']
  ueBuild?: EngineHost['ueBuild']
  peers?: EngineHost['peers']
  messagePeer?: EngineHost['messagePeer']
  verify?: EngineHost['verify']
  beginEdit?: EngineHost['beginEdit']
  inlineEdit?: EngineHost['inlineEdit']
  runBackground?: EngineHost['runBackground']
  cliTodos?: EngineHost['cliTodos']
  chatMemory?: EngineHost['chatMemory']
  checkBackground?: EngineHost['checkBackground']
  stopBackground?: EngineHost['stopBackground']
  lessons?: EngineHost['lessons']
  experience?: EngineHost['experience']
}
