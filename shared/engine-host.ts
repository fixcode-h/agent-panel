/**
 * 执行引擎和宿主之间的类型：EngineHost（宿主要提供的能力）、Orchestra（面板工具）、Agent 调用和结果。
 * 从 engine.ts 拆出来：那边顶到了行数上限，engine-budget.ts 等模块只要类型时不必再反向依赖 engine.ts（以前有类型环）。
 * engine.ts 照旧把这些类型转出，调用方 import 不用改
 */

import type { BugLevel } from './bug-diagnosis-schema.ts'
import type { DiagnosisInput } from './bug-diagnosis.ts'
import type { BugSource } from './bug-quotes.ts'
import type { ReviewTarget } from './clis.ts'
import type { DocRootInfo } from './doc-root.ts'
import type { GateStep, TurnExtra } from './done-evidence.ts'
import type { DocsFirstInput, ModuleDocsLookup } from './docs-first.ts'
import type { ExperienceInput, ProjectExperience } from './experience.ts'
import type { FlowRunHost, RunTools } from './flow-run-orch.ts'
import type { PickedFlow, WorkflowEntry } from './flow-run.ts'
import type { HandoffInput } from './handoff.ts'
import type { BeforeEndDecision, BeforeEndInput } from './hooks.ts'
import type { LessonQuery } from './lessons.ts'
import type { PlanItemInput, WrapUpAnswer } from './plan.ts'
import type { ReviewOverride, TriageItem } from './review-gate.ts'
import type {
  Agent,
  AskKind,
  GlobalLesson,
  NodeTier,
  ParamValues,
  ProjectLesson,
  StopReason,
  Task,
  TaskStep,
  TestStep,
  Workflow,
} from './schema.ts'
import type { Blocker } from './submitted.ts'

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

export interface Orchestra {
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
  /** 父对话能启动工作流（角色开了 canPlan、能分派子对话）：start_workflow 在它名下起一次工作流运行 */
  planning: boolean
  /** 按 id 或名字找能启动的工作流（空是项目默认的）；找不到时 info 列出可选的 */
  pickWorkflow(idOrName: string): { ok: false; info: string } | { ok: true; flow: PickedFlow }
  /** 工作流运行的那几样操作（flow-run-orch.ts）：起、看、补充、调整、代答、终止、合回 */
  runs: RunTools
  /** 项目里的对话有执行计划：set_plan 交整份计划，finish_plan 结束这份计划 */
  plans: boolean
  /** partial：只交变更步骤，其余没写到的步骤留在计划里不动（步骤多时分两批交） */
  setPlan(input: {
    title?: string
    steps?: PlanItemInput[]
    partial?: boolean
    summary?: string
  }): Promise<{ ok: boolean; info: string }>
  finishPlan(summary: string): Promise<{ ok: boolean; info: string }>
  /** 对话（Agent 模式）交代这一轮怎么结束：done / blocked（shared/end-turn.ts）；其余身份没有这个工具 */
  endTurn?: (outcome: string, need: string) => Promise<{ ok: boolean; info: string }>
  /** 等你操作：请用户离开对话去做一件事（shared/user-action.ts）；和 endTurn 同样只给对话 */
  requestUserAction?: (input: Record<string, unknown> | undefined) => { ok: boolean; info: string }
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
      /** 直接修的用户 Bug（kind: "fix"）：收尾时留简版报告（Task.bugFix） */
      fix?: boolean
      /** 一定要改代码：第一次执行前就开好独立分支（Task.editFirst） */
      edits?: boolean
      /** 父对话确认子对话不需要它目录里没提交的改动（独立分支看不到它们） */
      ignoreDirty?: boolean
      /** Bug 的级别初判：子对话的档案从它开始（快速级别根因和方案合成一次确认） */
      level?: BugLevel
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
  /** 调用者的角色挂了能力：可以 use_capability 就地加载它们的做法 */
  capabilities: boolean
  loadCapability(name: string, params?: ParamValues): { ok: boolean; info: string }
  /** 父对话可以就地做微小改动（shared/inline-edit.ts） */
  inlineEdit: boolean
  beginInlineEdit(files: string[], reason: string, route?: RouteInput): Promise<{ ok: boolean; info: string }>
  endInlineEdit(): Promise<{ ok: boolean; info: string }>
  /** 子对话（连同它的工作流节点）：和父对话通讯、认领要改的文件；子对话之间不能直接通讯 */
  child: boolean
  /** 子对话和兄弟共用目录、需要认领文件（独立分支里的不用） */
  claims: boolean
  /** 对话（项目对话、子对话）：长命令交给面板在后台跑，跑完把结果推回这个对话 */
  canBackground: boolean
  runBackground(input: {
    command: string
    name: string
    cwd: string
    exclusive: boolean
    timeoutMinutes?: number
    service?: boolean
    step?: string
  }): Promise<{
    ok: boolean
    info: string
  }>
  /** 后台命令的命令过工具前守卫（runner 装上，见 server/hooks/dispatch.ts 的 commandGuard）：拒绝时返回原因 */
  guardCommand?: (command: string) => Promise<string>
  /**
   * 插件的改文件类工具（McpTool.effect = 'edit'）执行前过工具前守卫（runner 装上，见 server/hooks/dispatch.ts 的 editGuard）：
   * 只读身份、Bug 先诊断、独立分支越界、凭据这些规则以前只认 CLI 自己的改文件工具。拒绝时返回原因
   */
  guardEdit?: (tool: string, paths: string[], input: Record<string, unknown>) => Promise<string>
  checkBackground(id: string): string
  stopBackground(id: string): { ok: boolean; info: string }
  /** 子对话请父对话收尾：独立分支里由父对话合回原分支，共用目录、P4、没有版本管理时由父对话验收（结果推回来） */
  canSubmit: boolean
  /** 子对话在自己的独立分支里（Git worktree）：收尾时面板提交并合回；不在的改动已经在父对话的目录里 */
  isolated: boolean
  /** 要改文件时才开独立分支的对话：还没开，改文件前先调用 begin_edit */
  canBeginEdit: boolean
  beginEdit(): Promise<{ ok: boolean; info: string }>
  submitMerge(
    note: string,
    tests: string,
    build?: boolean,
    handoff?: HandoffInput,
    /** 对最近一次评审每条高级、中级意见的处置（见 shared/review-gate.ts、ADR 0009） */
    triage?: TriageItem[],
    /** 显式放行（用户明确要求「已知问题也合并」）：门禁真的拦下时才生效，记录写在任务上 */
    override?: ReviewOverride,
  ): Promise<{ ok: boolean; info: string }>
  /** UE 项目：子对话向父对话申请编译、父对话向面板占位编译；不是 UE 项目时为空 */
  ueBuild: '' | 'child' | 'parent'
  /** children：父对话替哪些子对话申请（结果也推给它们） */
  requestBuild(note: string, step?: string, children?: string[]): Promise<{ ok: boolean; info: string }>
  /** 顶层对话：名下有子对话时收尾它们（finish_child，见 ADR 0005） */
  parentOf: boolean
  finishChild(id: string): Promise<{ ok: boolean; info: string }>
  /** 父对话之间：列出同一项目里的其他父对话、给它们传话 */
  peers: boolean
  listPeers(): Promise<string>
  messagePeer(id: string, text: string): Promise<{ ok: boolean; info: string }>
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
  /**
   * 这次运行有共享状态（存在 task.runs 里）：工作流运行才有，对话模式没有。
   * 没有时 read_state / write_state 根本不注册，注册了也只会让模型每次都调出「这次运行没有共享状态」
   */
  sharedState: boolean
  /** 本次运行的共享状态：读快照 / 写一个键 */
  readState(): string
  writeState(key: string, value: string): { ok: boolean; info: string }
  /** 项目教训：按文件 / 关键词 / 标签取全文、记一条；不在项目里时没有。子任务只读不记（record 为空）：
   * 它不和用户对话、常并行多只，值得记的交回派它的对话决定，免得各记一条重复、口径不一的 */
  lessons?: {
    find(files: string[], opts?: LessonQuery): Promise<string>
    record?(input: LessonInput): Promise<{ ok: boolean; info: string }>
  }
  /** 项目经验（shared/experience.ts）：按关键词查；设置里关了经验、不在项目里时没有。子任务也能查 */
  experience?: {
    find(query: string, files: string[]): Promise<string>
    list(): Promise<ProjectExperience[]>
    /** 记一条（/learn 命令让 Agent 学一件事）：子任务没有，值得记的交回派它的对话 */
    record?(input: ExperienceInput): Promise<{ ok: boolean; info: string }>
  }
  /** P4 工作区：按文件类型把改动分进各自的 pending（面板执行，不是 P4 项目时没有） */
  p4Split?: EngineHost['p4Split']
  /** 项目设了 cherry-pick 目标：由面板核对后搬（只收这个对话自己的提交 / 改动，见 server/cherry-pick.ts） */
  cherryPick?: EngineHost['cherryPick']
  /** 推送授权（ask_push，见 shared/push-auth.ts）：只有项目推送策略为「问一次」的顶层对话有 */
  askPush?: (input: { branch?: string; summary?: string }) => Promise<{ ok: boolean; info: string }>
  /** Bug 诊断报告（ADR 0045）：父对话派来的 Bug 子对话才有，交了等用户确认方案再改 */
  diagnose?: (input: DiagnosisInput) => { ok: boolean; info: string }
  bugCase?: (input: DiagnosisInput) => { ok: boolean; info: string } // update_bug_case（ADR 0046）
  requestLogs?: (input: DiagnosisInput) => { ok: boolean; info: string } // request_logs：加好日志请用户复现
  /** Chat 模式的跨对话记忆（remember 工具，server/chat-memory.ts）：只有 Chat 页的对话有 */
  remember?: (text: string, forget?: boolean) => Promise<{ ok: boolean; info: string }>
}

/** p4_split_changelists 的参数：从哪个 changelist 分、只分哪些文件、每类一句描述 */
export interface P4SplitArgs {
  from?: string
  files?: string[]
  descriptions: Partial<Record<'C++' | 'XLSX' | 'Lua' | 'Other', string>>
}

export interface EngineHost {
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
  /** Bug 诊断报告交上来时取原文：读项目文件、取引入改动的 diff（shared/bug-quotes.ts）；没有就不取快照 */
  bugSource?: BugSource
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
  /**
   * 交给评审的改动（git 仓库才有）：since 是上一轮评审记下的快照，给了就只取那之后的增量。
   * 派「评审」时面板一次把差异带进提示词，评审只看代码，不用自己一个回合一个回合地 git diff、读文件（ADR 0010）
   */
  reviewDiff?: (since?: string, files?: string[]) => Promise<ReviewDiff | null>
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
  /** 项目里可选的工作流目录：父对话按名称、说明、适用场景和节点概览挑一个（ADR 0044） */
  workflowCatalog?: () => WorkflowEntry[]
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
  /**
   * 项目打开了「改了代码要跑过测试步骤才能结束」（Project.requireVerify）：end_turn 记成做完前按这些步骤核对（shared/done-evidence.ts）。
   * 没开时不传，只记完成依据、卡片上标出来
   */
  verifyGate?: { steps: GateStep[] }
  /**
   * 这一轮工具调用之外的完成依据（shared/done-evidence.ts 的 TurnExtra）：插件工具报的改动和验证；
   * 打开了 verifyGate 时还有命令改的文件（工作区快照差）。end_turn(done) 时现取，见 server/exec/turn-extra.ts
   */
  turnExtra?: () => Promise<TurnExtra>
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
    /** 直接修的用户 Bug（kind: "fix"）：收尾时留简版报告（Task.bugFix） */
    fix?: boolean
    /** 一定要改代码：第一次执行前就开好独立分支（Task.editFirst） */
    edits?: boolean
    /** 不拦父对话目录里没提交的改动（server/tasks/dirty-parent.ts） */
    ignoreDirty?: boolean
    /** Bug 的级别初判（Task.bugCase.level 的初值） */
    level?: BugLevel
  }) => Promise<{ ok: boolean; id?: string; title?: string; info: string }>
  /** 给已有子对话追加消息并异步执行 */
  sendToConversation?: (
    id: string,
    message: string,
    bug?: { level?: BugLevel },
  ) => Promise<{ ok: boolean; info: string }>
  /** 工作流运行的操作（父对话用，flow-run-orch.ts）：宿主在父对话名下起运行、补充、调整、终止、合回 */
  runs?: FlowRunHost
  /**
   * 父对话的就地微改动（只有项目顶层对话、角色开了 inlineEdit 时有）：begin 校验护栏并记下基线，
   * end 按真实改动核对、越界时写提示（见 shared/inline-edit.ts）
   */
  inlineEdit?: {
    begin(files: string[], reason: string): Promise<{ ok: boolean; info: string }>
    end(): Promise<{ ok: boolean; info: string }>
  }
  /** 子对话怎么隔离（项目设置里选）：worktree 各自独立分支、在里面验证完合回原分支，claim 共用目录认领文件 */
  childIsolation?: 'claim' | 'worktree'
  /** 父对话所在目录现在的分支：父对话不开独立分支，子对话从这里开、合回这里 */
  branch?: string
  /** 在独立分支里时：分支要合回去的目录（开分支的那个目录，在原分支上）。父对话要推送时先合到这里再推；子对话的完成只管合回这里，与推送无关 */
  worktreeHome?: string
  /**
   * 这个对话的收尾（面板保证它是计划的最后一步，见 plan.ts 的 ensureWrapUp）：
   * merge 子对话的独立分支合回父对话所在的分支，p4 子对话按文件类型分进各自的 pending changelist，
   * push 父对话把分支推到远端；不用收尾的不传，'none' 是明确不推送（去掉计划里还挂着的推送收尾）
   */
  wrapUp?: WrapUpAnswer
  /**
   * 子对话请父对话收尾（不管用哪种版本管理都有）：评审、测试、交接、待回答的提问都在这里校验。
   * 独立分支里的由父对话合回原分支（面板排队试合并，有冲突撤回，结果推回子对话）；其余的由父对话验收后标完成
   */
  submitMerge?: (
    note: string,
    tests: string,
    build?: boolean,
    handoff?: HandoffInput,
    triage?: TriageItem[],
    override?: ReviewOverride,
  ) => Promise<{ ok: boolean; info: string }>
  /**
   * UE 项目的编译归父对话（项目目录里有 .uproject 时才有）。
   * child：子对话不编译，改完向父对话申请；build 为 true 的 submit_merge 合回去后也自动申请。
   * parent：父对话收到申请（或用户要求）后向面板占位编译，面板按编译目录排队：同一目录同一时间只编译一次，
   * 各自 worktree 的目录互不占位；结果推回父对话
   */
  /** 子对话在自己的独立分支（Git worktree）里：分支目录、提交和合回都由面板管 */
  isolated?: boolean
  ueBuild?: {
    role: 'child' | 'parent'
    request: (note: string, children?: string[]) => Promise<{ ok: boolean; info: string; id?: string }>
  }
  /**
   * 顶层项目对话：收尾名下的子对话（子对话 submit_merge 请求后，父对话调用 finish_child）。
   * 面板合回它的分支、标完它计划的收尾步骤、结束它并删除独立分支（见 ADR 0005）
   */
  finishChild?: (id: string) => Promise<{ ok: boolean; info: string }>
  /** 父对话：同一项目里的其他父对话（顶层对话），building 是它占着的编译（没有为空） */
  peers?: () => Promise<{ id: string; title: string; status: string; busy: boolean; building: string }[]>
  /** 父对话给另一个父对话传话：它正在执行就实时送达，空闲就放进它的收件箱 */
  messagePeer?: (id: string, text: string) => Promise<{ ok: boolean; info: string }>
  /**
   * 对话里怎么验证：项目的测试步骤和「按改动大小决定验证范围」开关。
   * 不传时提示里不带这一段（没有项目的聊天、在线演示）
   */
  verify?: {
    steps: TestStep[]
    platform: string
    wslDistro: string
    scaled: boolean
    /**
     * 范围为 parent（全量、合并后由父对话跑）的步骤由谁跑（见 ADR 0018 / 0020）：独立分支的子对话是 child（它不跑），
     * 父对话是 parent（面板自动跑、结果直接回传子对话）。只有 Git 项目、这些步骤真的生效时才传
     */
    parentRun?: 'child' | 'parent'
    /**
     * 这次任务实际改了哪些文件（服务端从 git 改动统计来）：有它就在提示词里直接给出「本轮该跑哪几条 + 命令」，
     * 不再只给规则让 Agent 自己筛
     */
    changedFiles?: string[]
  }
  /**
   * 要改文件时才开独立分支、现在还没开：面板从当前目录建 worktree，这一轮结束后在里面接着做（能跨目录续接的 CLI 带着原会话过去）。
   * 只有对话有（工作流在创建时就建好了）
   */
  beginEdit?: () => Promise<{ ok: boolean; info: string }>
  /** 这一轮的 CLI 自带待办会被面板解析显示（CLI 定义的 todos）：Chat 模式据此决定怎么说计划（shared/chat-prompt.ts） */
  cliTodos?: boolean
  /** Chat 模式的「关于我」和记忆（server/chat-memory.ts）：提示词带上，remember 工具往里记；只有 Chat 页的对话有 */
  chatMemory?: { about: string; items: string[]; remember: NonNullable<Orchestra['remember']> }
  /**
   * 后台命令：面板在这个对话的目录里跑，马上返回编号；跑完把结果推回对话（正在执行就插话，空闲就开新的一轮）。
   * exclusive 的（编译这类）按项目排队，同一时间只跑一个
   */
  runBackground?: (input: {
    command: string
    name: string
    cwd: string
    exclusive: boolean
    timeoutMinutes?: number
    /** 开发服务器、监听这类常驻进程：不催、不挂计划等待，对话不算在等它（server/background.ts 的 BgJob.service） */
    service?: boolean
    /** 发起它的子任务步骤：子任务调用时写它自己的步骤 id，结果推回时据此标注来源 */
    step?: string
  }) => Promise<{
    ok: boolean
    info: string
    /** 后台命令的编号：计划步骤挂等待时用，结果回来按它找到步骤 */
    id?: string
  }>
  /** 查后台命令：不传编号列出这个对话的全部 */
  checkBackground?: (id: string) => string
  /** 停掉这个对话的一条后台命令：对话看出它卡住了时用 */
  stopBackground?: (id: string) => { ok: boolean; info: string }
  /**
   * 父对话发布的全局规则（「/rule」）：子对话和它的工作流节点每次调用都带上，必须遵守。
   * 父对话自己也带上，分派时提醒子对话
   */
  rules?: string[]
  /** 父对话在对话设置里写的目标：父对话和子对话都看得到 */
  goal?: string
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
  /** 子对话：认领 / 释放要改的文件（同一父对话下的子对话共用一个目录） */ claimFiles?: (paths: string[]) => {
    granted: string[]
    held: { path: string; by: string; state?: string }[]
  }
  releaseFiles?: (paths: string[]) => number
  /** 项目教训：按要改的文件查，Agent 被纠正后自己记一条（只有项目里的对话和节点有） */
  lessons?: {
    list: () => Promise<ProjectLesson[]>
    /** 全局教训：只读，Agent 改不了 */
    globals?: () => Promise<GlobalLesson[]>
    record: (input: LessonInput) => Promise<{ ok: boolean; info: string }>
  }
  /** 项目经验：每次查都现读（刚学到的也能查到）；设置里关了经验时宿主不给 */
  experience?: {
    list: () => Promise<ProjectExperience[]>
    record: (input: ExperienceInput) => Promise<{ ok: boolean; info: string }>
  }
  /** P4 工作区（项目里的对话）：按文件类型分 changelist，由面板跑 p4，规则不靠 Agent 自觉 */
  p4Split?: (input: P4SplitArgs) => Promise<{ ok: boolean; info: string }>
  cherryPick?: (input: { commits?: string[]; changelist?: string }) => Promise<{ ok: boolean; info: string }>
  /** 弹推送授权卡等用户点（回答由宿主记进 task.remotePush，不受「提问」开关影响）；停止时 null */
  askPush?: (info: { branch?: string; summary?: string }) => Promise<{ allow: boolean; message?: string } | null>
  moduleDocs?: ModuleDocsLookup // 查模块文档（先建文档再开子对话，shared/docs-first.ts）
}

/** Agent 用 record_lesson 记的一条教训 */
export interface LessonInput {
  title: string
  rule: string
  cause: string
  paths: string[]
  /** 标签：优先用这个项目已有的 */
  tags?: string[]
  /** 改写已有的那条（用户的新要求和它冲突、找到两全的做法时）：那条的 id */
  replaces?: string
  /** 为什么改写 */
  why?: string
}
