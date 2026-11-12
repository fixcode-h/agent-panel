/**
 * 执行引擎和宿主之间的类型：EngineHost（宿主要提供的能力）、Orchestra（面板工具）、Agent 调用和结果。
 * 从 engine.ts 拆出来：那边顶到了行数上限，engine-budget.ts 等模块只要类型时不必再反向依赖 engine.ts（以前有类型环）。
 * engine.ts 照旧把这些类型转出，调用方 import 不用改。
 * EngineHost / Orchestra 只是按能力拆开的小接口（shared/host/）的组合，加新能力时加进小接口或新开一个
 */

import type { ReviewTarget } from '../clis.ts'
import type { DocRootInfo } from '../doc-root.ts'
import type { BeforeEndDecision, BeforeEndInput } from '../hooks.ts'
import type { Agent, NodeTier, ParamValues, StopReason, Task, TaskStep, Workflow } from '../schema.ts'
import type { Blocker } from '../submitted.ts'
import type { BugHost, OrchBug } from '../host/bug.ts'
import type { BuildHost, OrchBuild } from '../host/build.ts'
import type { ConversationHost, OrchConversation } from '../host/conversation.ts'
import type { KnowledgeHost, OrchKnowledge } from '../host/knowledge.ts'
import type { OrchPlan, PlanHost } from '../host/plan.ts'
import type { OrchVcs, VcsHost } from '../host/vcs.ts'

/** stopped：用户停止；halted：别的节点失败了没再继续（续跑时重来）；stalled：子任务卡住被 runner 停掉（runStalled 重试） */
export type FailFlags = { stopped?: boolean; halted?: boolean; reported?: boolean; budget?: boolean; stalled?: boolean }

export type AgentResult = { ok: true; text: string } | ({ ok: false; error: string } & FailFlags)

/** 一轮执行的结果里「没成功」的那几种；导出给单测构造 finish 的入参 */
export type Fail = Extract<AgentResult, { ok: false }>

export interface AgentCall {
  /** 所属节点；追加要求和对话没有节点 */
  step?: TaskStep
  agentId: string
  prompt: string
  /** CLI 会话键：节点用节点 id，对话和追加要求用 Agent id */
  sessionKey: string
  /** 这次调用是在验收（模拟执行据此给出验收结论） */
  reviewing?: boolean
  /** 节点后面有条件连线，要给出「结论：通过 / 不通过」（模拟执行据此给出结论） */
  deciding?: boolean
  /** 会话续不上时（CLI 清理了历史）改用的完整提示；prompt 只是续接用的简短要求时才需要 */
  fresh?: string
  /** 不是普通的一轮：压缩上下文，或者审查代码 */
  op?: { kind: 'compact'; reason?: string } | { kind: 'review'; target: ReviewTarget }
  /** 工作流里的调用：用默认 CLI 的这一档（空表示按 Agent 设的档位）；对话不传，用 Agent 自己的设置 */
  tier?: NodeTier
  /** Agent 参数的值（节点上填的）；不传时对话用任务里选的 */
  params?: ParamValues
  /** 工作流里的调用都带编排工具：派子 Agent、查状态、提问、传话（真实执行交给 CLI 的 MCP） */
  orch?: Orchestra
  /** 预热：打开对话页时先用 --resume 启动，只等下一句，不算一轮、不记输出 */
  prewarm?: boolean
  /**
   * 保活的进程里来了下一条消息：按当前状态重拼对话提示，只返回这条消息和变了的段落（见 shared/prompt-delta.ts）。
   * 不给时 runner 原样交给 CLI
   */
  nextPrompt?: (text: string) => Promise<string>
  /**
   * 这次调用里会话被压缩了（手动压缩、CLI 自己压缩、上下文骤降）：之前发过的规则只剩摘要。
   * 调用方要忘掉「这个会话已经有哪些段落」，下一条消息发完整提示，不能在这一轮结束后又把旧记录写回去
   */
  onCompacted?: () => void
  /** runner 拼好这次的输入后告诉调用方：新会话开头补的角色设定、教训有多少字，是不是改用了 fresh（记进这一轮的输入构成） */
  onInput?: (info: { setup: number; rules: number; fresh: boolean }) => void
  /** 只停这一次调用（终止单个子任务）；整个任务停止仍走宿主的信号 */
  signal?: AbortSignal
  stallRetry?: boolean // 子任务：runner 也查没有响应，卡住到时间停掉这次调用、返回 stalled（helper-summary 的 runStalled）
  /**
   * 这一圈接着上一圈做（子任务、计划交回的结果），不是用户的新要求：
   * 总结下面的改动卡片接着上一圈的终点算，子任务和工作流在空档里改的文件才算得进来
   */
  carry?: boolean
  /**
   * 结束前钩子（ADR 0049）：模型准备结束这一轮时问一次，返回 block 就在同一轮里接着做（CLI 支持时才装）。
   * 只按结构化状态判断（计划、submit_result / submit_verdict 交没交、在不在等结果），不读回复文字
   */
  beforeEnd?: (input: BeforeEndInput) => Promise<BeforeEndDecision>
}

/** 交给评审的改动：snapshot 是这一刻的工作区快照（下一轮复看和它比），diff 太长时 diff 为空、完整内容在 file */
export interface ReviewDiff {
  snapshot: string
  stat: string
  diff: string
  file?: string
  /** 二进制文件（表格、插件认领的扩展名）的语义差异，已拼成提示词里的一节；没有就不带（server/exec/review-semantic.ts） */
  semantic?: string
}

/** 分诊记录的输入：派单工具的 route 参数（协调器写的理解、理由、假设） */
export interface RouteInput {
  understanding?: string
  reason?: string
  assumptions?: string
}

/** 派一个子 Agent 的要求 */
export interface HelperSpec {
  title: string
  instructions: string
  /** Agent 的名字或 id；不写用发起的节点的 Agent */
  agent?: string
  /** 默认 CLI 的档位；不写跟发起的节点 */
  tier?: string
  /** 接着之前哪个子任务（id）的会话做：复看的评审接着上一次评审，读过的文档和代码不用再读一遍 */
  resume?: string
  /** 角色参数（例如「测试验收」的 task）：只认角色声明过的 key；resume 时不写沿用上一次的 */
  params?: ParamValues
  /** 派「评审」时的交接单：派它的对话把评审要用的信息整理好交给它，评审不用自己去项目里找（ADR 0013） */
  review?: ReviewBrief
}

/**
 * 评审交接单（ADR 0013）：派评审的对话手里已经有需求、改动的来龙去脉和检查结果，
 * 整理好一次交给评审，评审只看改动的代码，不再自己读模块文档、全仓搜索去还原这些。
 * 第一次评审 goal、checks 必填（复看接着上一次的会话，上下文还在，不用再交）
 */
export interface ReviewBrief {
  /** 这次改动要达成什么、验收标准（有口径的连口径） */
  goal?: string
  /** 改了什么、为什么这样改：按文件或模块一两句 */
  changes?: string
  /** 已经跑过的检查：命令 + 结果 */
  checks?: string
  /** 希望评审重点看的风险点 */
  focus?: string
  /** 判断要用、差异里又看不到的事实：调用方怎么用、上游保证了什么、相关的接口签名，对话从读过的代码里摘 */
  context?: string
  /** 要评审的文件（相对项目根）：只取这些文件的差异；不写取这个对话改过的全部文件 */
  files?: string[]
}

/** 子 Agent 的状态（wait_agents 的结果） */
export interface HelperReport {
  id: string
  title: string
  status: TaskStep['status']
  output?: string
  error?: string
}

/**
 * 交给一次调用的编排工具，绑定在调用它的节点上。工具调用不能等太久（Codex 默认 60 秒就超时），
 * 等子 Agent、等主 Agent 回答都有上限，没等到就先返回，之后再查
 */
/** 一批子任务交回的结果：take() 认领，只有第一次拿得到 */
export interface HelperBatch {
  take: () => string
}

export interface Orchestra extends OrchPlan, OrchConversation, OrchVcs, OrchBuild, OrchKnowledge, OrchBug {
  /** 调用者的节点 id */
  self: string
  /** 这条调用是不是常驻编排器自己的（只有它能起停运行） */
  planner: boolean
  /** 可以直接派的通用 Agent（名字和简介），spawn_agents 里列出来 */
  common: { name: string; description: string }[]
  /** 调用者自己就是子任务：不能再派子任务、不能启动工作流、不能开子对话 */
  helper: boolean
  /** 交结果（submit_result）：只有子任务有 */
  submitResult?: (r: { state: 'done' | 'unfinished' | 'stuck'; summary: string; left: string }) => {
    ok: boolean
    info: string
  }
  /** 交结论（submit_verdict，ADR 0041 第 16 节）：节点和子任务有，对话本身没有 */
  submitVerdict?: (v: { verdict: 'pass' | 'fail'; blockers?: Blocker[] }) => { ok: boolean; info: string }
  /** 能派子任务（spawn_agents / stop_subtask / wait_agents）：子任务和 Chat 模式没有（ADR 0038） */
  canSpawn: boolean
  /** 有并行的节点、子任务可查可传话（get_status / send_message / read_messages）：Chat 模式没有 */
  team: boolean
  /** 对话里派的子任务：这一轮结束后对话停下等它们，结果自动交回，不用模型自己轮询 */
  autoReturn: boolean
  /**
   * 这一批还没交回的子任务：等它们全部结束，把结果作为一条面板消息记进对话；没有要交回的返回 undefined。
   * 同一批只有一个 Promise，多处等拿到的是同一个；结果由 take() 认领，只有第一次认领拿得到，免得交给 CLI 两次。
   * 对话这一轮结束时用 helperGate 等它，等待期间用户照样能聊
   */
  helperBatch(): Promise<HelperBatch> | undefined
  status(): string
  /**
   * 派子任务。step：计划里哪一步在等这批子任务（步骤 id，见 set_plan 返回的计划），
   * 全部结束、结果交回时把这一步标完成，失败或被终止退回进行中并写清原因。
   * local：这批就是给这个对话本地执行的，不再按角色的 runIn 转交父对话（转交后的父对话派发、引擎自己排队的转发用它）
   */
  spawn(
    tasks: HelperSpec[],
    step?: string,
    opts?: { local?: boolean; route?: RouteInput },
  ): {
    ids: string[]
    error?: string
    info?: string
  }
  /** 终止自己派出的子任务（不写 ids 就是全部还没结束的）；why 会写进交回的结果 */
  stopHelpers(ids: string[], why: string): { ok: boolean; info: string }
  /** 只交回还没取过的结果；signal 是这次工具调用（CLI 断开 / 超时时不再算取走） */
  wait(
    ids: string[],
    ms: number,
    signal?: AbortSignal,
  ): Promise<{ done: HelperReport[]; running: HelperReport[]; taken: number }>
  ask(question: string, ms: number): Promise<{ answer?: string; pending?: boolean; error?: string }>
  send(to: string, text: string): Promise<{ ok: boolean; info: string }>
  inbox(): string[]
}

export interface EngineHost extends PlanHost, ConversationHost, VcsHost, BuildHost, KnowledgeHost, BugHost {
  task: Task
  agents: Agent[]
  /** 所有工作流（节点可以引用其他工作流） */
  workflows: Workflow[]
  workflow?: Workflow
  /** 本轮的用户输入 */
  prompt: string
  /**
   * 项目设置和本机环境里已经确认的授权，写进每次调用的公共部分：
   * 推送策略（ask 第一次问、allow 直接推、deny 一律不推）、这个对话里用户已经做的选择、
   * 以及已经授权可用的外部工具（gh、cloudflared 等，只列已登录的）
   */
  policy?: {
    push: 'ask' | 'allow' | 'deny'
    /** 已有模块文档的索引（协调器定位用，server/module-map.ts 的 moduleIndexText） */
    modules?: string
    /** P4 / SVN 以外的项目的文档根（docs 为空时给，见 shared/doc-root.ts 的 plainDocRootText） */
    docRoot?: string
    /** 项目是 Git 仓库但没配远端：没有地方可推，推送规则改成不推、不问（ask_push 也不给） */
    noRemote?: boolean
    /** 这个对话里用户对推送的回答 */
    answered?: 'allowed' | 'denied'
    /** 已安装并登录的外部工具 */
    tools: string[]
    /** 项目设置的 cherry-pick 目标（见 Project.cherryPick）：vcs 是项目目录的版本管理，按它说清怎么搬 */
    cherryPick?: { vcs: 'git' | 'p4'; target: string }
    /** 项目目录现在用的版本管理：提示词里的命令按它写（P4 项目里不教 git add，见 shared/engine/vcs-text.ts） */
    vcs?: 'git' | 'p4' | 'svn' | 'none'
    docs?: DocRootInfo
  }
  /** 这一轮是「继续流程」，不是新的要求：停在某个节点结论上的流程从那个节点重新检查后接着走 */
  resume?: boolean
  /** 预热：打开对话页时后台启动 CLI，不算一轮；失败时回到 prewarmFrom */
  prewarm?: boolean
  prewarmFrom?: Task['status']
  /** 预热开始前的 turnDoneAt：结束时没变说明没有处理新消息 */
  prewarmTurnDoneAt?: string
  changed: (flush?: boolean) => void
  newId: () => string
  runAgent: (call: AgentCall) => Promise<AgentResult>
  /**
   * 调用停在工具里等别人（wait_agents 等子任务、ask_main 等主 Agent）：宿主让出这次调用的 API 并发名额，
   * 等完再拿回（满了要排队）。不让出的话，占着名额等子任务、子任务又排队等名额，会互相等死。
   * stepId 是在等的那次调用（对话是 @chat）；没有时直接等
   */
  yieldSlot?: <T>(stepId: string, wait: () => Promise<T>) => Promise<T>
  /**
   * 节点完成后等用户确认（节点勾了「完成后等我确认」）：返回用户的决定，停止时返回 null。
   * 没有时（例如在线演示之外的宿主不支持）不等待，直接往下走
   */
  /** ask：只是追问、不算退回，节点回答后仍停在等确认 */
  confirm?: (step: TaskStep, text: string) => Promise<{ allow: boolean; answer?: string; ask?: boolean } | null>
  /** 工作流运行里已经定下的事（决定记录、运行级说明）：每个节点开始时现取，拼进节点的输入 */
  nodeNote?: () => string
  /** 节点结果太长时把完整内容存成文件，返回文件路径，下游节点自己去读；没有时只截断 */
  saveHandoff?: (step: Pick<TaskStep, 'id' | 'title'>, text: string) => Promise<string>
  /** 有节点失败或用户停止后置位：所有层级的流程都不再启动新节点、新一轮验收 */
  halted?: boolean
  /** 把一段话交给正在跑的节点（CLI 支持执行中补充时）；交不了返回 false，改放进它的收件箱 */
  steer?: (stepId: string, text: string) => Promise<boolean>
  /**
   * 对话停下等子任务时，等用户的下一条消息（消息由宿主记进对话），马上开一轮回复它。
   * 不再等（页面离开、停止）返回 null；没有时只等子任务
   */
  waitChat?: (signal: AbortSignal) => Promise<string | null>
  /** 这一轮的停止信号：等子任务时停止任务不再等 */
  signal?: AbortSignal
  /**
   * 停下这一轮的原因（见 StopReason）：'user' 是用户自己按的暂停，
   * 其余是父对话收尾、换 CLI、面板重启这些顺带结束的动作。收尾时读现值的，所以要传函数
   */
  stopReason?: () => StopReason | undefined
  /**
   * 写文件的格式（项目设置优先，没设时跟随全局），写进公共部分让 Agent 照着做；
   * 不传时说明文件不带这一段（在线演示）
   */
  fileFormat?: { encoding: 'utf8' | 'utf8-bom'; eol: 'lf' | 'crlf' }
  /**
   * 项目设置里的搜索排除目录（项目自己填的会补上内置默认，见 search-exclude.ts）：
   * 写进搜索那一段，Agent 直接照着拼 `-g '!目录'`，不靠临场叮嘱
   */
  searchExclude?: string[]
  /**
   * 工作目录是 Git 仓库：rg / git grep / CLI 自带的搜索本来就跳过 .gitignore 里的产物，
   * 搜索段只需补项目自己填的目录，并提醒别加 --no-ignore 把它们又扫回来
   */
  searchInGit?: boolean
  /** 按 id 取工作流和这次运行要用的快照、技能槽；id 为空表示项目的默认工作流 */
  resolveWorkflow?: (
    id: string,
  ) => { workflow: Workflow; workflows: Workflow[]; skillSlots: Record<string, string> } | undefined
}
