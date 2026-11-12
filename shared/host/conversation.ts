// 对话之间：子对话的创建、传话、收尾，父对话之间传话，文件认领，结束前判断。
// 从 shared/engine-host.ts 的 EngineHost / Orchestra 两个大接口里按能力拆出来（重构文档第 5 条），
// 新能力加进对应的小接口或新开一个，不再往大接口上加；成员数由 scripts/structure-check.mjs 盯着
import type { BugLevel } from '../bug/diagnosis-schema.ts'
import type { DocsFirstInput } from '../docs-first.ts'
import type { HelperSpec, Orchestra, RouteInput } from '../engine-host.ts'
import type { BeforeEndDecision, BeforeEndInput } from '../hooks.ts'
import type { AskKind } from '../schema.ts'

/** Orchestra 里对话之间的那部分（重构文档第 5 条：按能力拆成小接口，Orchestra 只是它们的组合） */
export interface OrchConversation {
  /** 协调 Agent：能不能创建 / 给子对话发消息 */
  coordinator: boolean
  conversations(): Promise<string>
  /**
   * step：计划里哪一步在等这个子对话，开出去以后它挂成等待中。
   * role：子对话用哪个高级角色（名字），不写用「执行」；route：分诊记录（理解、理由、假设），画成分诊卡
   */
  createConversation(
    title: string,
    message: string,
    files?: string[],
    step?: string,
    extra?: {
      role?: string
      route?: RouteInput
      bug?: boolean
      /** 直接修的用户 Bug（kind: "fix"）：收尾时留简版报告（task.bug.kind 为 fix） */
      fix?: boolean
      /** 一定要改代码：第一次执行前就开好独立分支（Task.editFirst） */
      edits?: boolean
      /** 父对话确认子对话不需要它目录里没提交的改动（独立分支看不到它们） */
      ignoreDirty?: boolean
      /** Bug 的级别初判：子对话的档案从它开始（快速级别根因和方案合成一次确认） */
      level?: BugLevel
      /** 排在哪些子对话之后：它们都合回后面板才启动这个子对话（shared/children/after.ts） */
      after?: string[]
    } & DocsFirstInput,
  ): Promise<{ ok: boolean; id?: string; info: string }>
  sendToConversation(
    id: string,
    message: string,
    step?: string,
    route?: RouteInput,
    /** 把这个子对话正在处理的问题升级成用户报的 Bug（send_to_conversation 写了 kind: "bug"，ADR 0057） */
    bug?: { level?: BugLevel },
  ): Promise<{ ok: boolean; info: string }>
  /** 顶层对话：名下有子对话时收尾它们（finish_child，见 ADR 0005） */
  parentOf: boolean
  finishChild(id: string): Promise<{ ok: boolean; info: string }>
  /** 父对话之间：列出同一项目里的其他父对话、给它们传话 */
  peers: boolean
  listPeers(): Promise<string>
  messagePeer(id: string, text: string): Promise<{ ok: boolean; info: string }>
  /** 子对话（连同它的工作流节点）：和父对话通讯、认领要改的文件；子对话之间不能直接通讯 */
  child: boolean
  /** 子对话和兄弟共用目录、需要认领文件（独立分支里的不用） */
  claims: boolean
  /**
   * 给父对话发消息。waitFix 是被「不是自己改出来的报错」卡住的计划步骤：那一步挂上等父对话通知修复，
   * 子对话接着做别的步骤，父对话安排好修复、发消息回来时面板把它退回进行中（见 releaseParentWait）
   */
  toParent(
    text: string,
    question: boolean,
    options?: string[],
    kind?: AskKind,
    waitFix?: string,
  ): Promise<{ ok: boolean; info: string }>
  claim(paths: string[]): { ok: boolean; info: string }
  release(paths: string[]): { ok: boolean; info: string }
}

/** EngineHost 里对话之间的那部分 */
export interface ConversationHost {
  /** 子对话列表：协调 Agent 判断这条消息该交给哪个子对话 */
  listConversations?: () => Promise<
    {
      id: string
      title: string
      status: string
      /** 状态（ConvState）：判断原来的子对话还能不能接着做（failed 才允许另建子对话接手） */
      state?: string
      /** 正在执行或排队等着执行：有这样的子对话时父对话自己不改文件 */
      busy?: boolean
      summary: string
      at: string
      /** 这会儿在做什么（正在调的工具、计划做到第几步）：有空就不至于以「没动静」为由猜它卡住了 */
      doing?: string
      /** 在等什么（等用户回答、等后台命令、等子任务）：不是在跑也不是卡住 */
      waiting?: string
      /** 最后有动静的时间：多久没新输出，父对话一眼能看出来 */
      lastActivityAt?: string
      /** 创建时间、是否已经收尾完成：计划按它们对齐等待中的步骤（见 plan.ts 的 linkKids） */
      createdAt?: string
      resolved?: boolean
    }[]
  >
  /** 新建子对话并异步执行，返回后父对话继续；完成后由宿主把结果回报到父对话 */
  createConversation?: (input: {
    title: string
    message: string
    agentId?: string
    /** 父对话划给这个子对话的文件 / 目录：创建时替它认领 */
    files?: string[]
    /** 父对话派来的 Bug（ADR 0045）：子对话修之前要交诊断报告给用户确认 */
    bug?: boolean
    /** 直接修的用户 Bug（kind: "fix"）：收尾时留简版报告（task.bug.kind 为 fix） */
    fix?: boolean
    /** 一定要改代码：第一次执行前就开好独立分支（Task.editFirst） */
    edits?: boolean
    /** 不拦父对话目录里没提交的改动（server/tasks/dirty-parent.ts） */
    ignoreDirty?: boolean
    /** Bug 的级别初判（task.bug.case.level 的初值） */
    level?: BugLevel
    /** 排在哪些子对话之后（Task.waitAfter）：它们都合回后才启动 */
    after?: string[]
  }) => Promise<{ ok: boolean; id?: string; title?: string; info: string }>
  /** 给已有子对话追加消息并异步执行 */
  sendToConversation?: (
    id: string,
    message: string,
    bug?: { level?: BugLevel },
  ) => Promise<{ ok: boolean; info: string }>
  /**
   * 顶层项目对话：收尾名下的子对话（子对话 submit_merge 请求后，父对话调用 finish_child）。
   * 面板合回它的分支、标完它计划的收尾步骤、结束它并删除独立分支（见 ADR 0005）
   */
  finishChild?: (id: string) => Promise<{ ok: boolean; info: string }>
  /** 父对话：同一项目里的其他父对话（顶层对话），building 是它占着的编译（没有为空） */
  peers?: () => Promise<{ id: string; title: string; status: string; busy: boolean; building: string }[]>
  /** 父对话给另一个父对话传话：它正在执行就实时送达，空闲就放进它的收件箱 */
  messagePeer?: (id: string, text: string) => Promise<{ ok: boolean; info: string }>
  /** 父对话：子对话发来、上一轮之后还没读的消息（读一次就清掉） */
  takeInbox?: () => { title: string; text: string }[]
  /** 子对话：给父对话发消息（汇报进展、提问）；question 表示需要父对话决定，kind 区分提问和收尾建议 */
  messageParent?: (
    text: string,
    question: boolean,
    options?: string[],
    kind?: AskKind,
    /** 请父对话安排修复的报错（message_parent 带 wait_fix）：按这个字段判，不从正文开头反推（ADR 0041 第 16 节） */
    fix?: boolean,
  ) => Promise<{ ok: boolean; info: string }>
  /**
   * 子对话点名「只在父对话执行」的角色（runIn: 'parent'）时，把它转交父对话创建子任务（见 ADR 0019）。
   * 同步返回：排进父对话的队列也算交出去了（子对话不等结果）；父对话接不了
   * （当前对话没有父对话、父对话自己也是被派出来的）返回 ok: false，让调用方看到明确原因
   */
  forwardSpawn?: (spec: HelperSpec) => { ok: boolean; info: string; id?: string }
  /**
   * 引擎每次开始调对话 AI / 调完时回调（见 ADR 0019）：
   * 开始调之前传这一轮的 Orchestra，服务端据此把子对话转交来的子任务直接派进来；调完传 undefined 清掉引用。
   * 等子任务结果、跑计划、执行工作流节点这些阶段不在回调范围内——那时派出的子任务结果交不回来，留给下一轮
   */
  onOrchestra?: (orch: Orchestra | undefined) => void
  /**
   * 对话自己的结束前判断（ADR 0049）：计划没做完、子对话请求收尾没处理、没列计划却做了一半时拦住，在同一轮里接着做。
   * 由服务端按计划和等待状态答（server/tasks/before-end.ts）；子任务、节点交没交结果由引擎自己判断，不走这里
   */
  beforeEnd?: (input: BeforeEndInput) => Promise<BeforeEndDecision>
  /** 子对话：认领 / 释放要改的文件（同一父对话下的子对话共用一个目录） */
  claimFiles?: (paths: string[]) => {
    granted: string[]
    held: { path: string; by: string; state?: string }[]
  }
  releaseFiles?: (paths: string[]) => number
  /**
   * 父对话发布的全局规则（「/rule」）：子对话和它的工作流节点每次调用都带上，必须遵守。
   * 父对话自己也带上，分派时提醒子对话
   */
  rules?: string[]
  /** 父对话在对话设置里写的目标：父对话和子对话都看得到 */
  goal?: string
}
