/**
 * 执行引擎：按流程图调度节点，真实执行和模拟执行共用。
 *
 * - 从「开始」出发，一个节点的上游全部完成后才执行，没有依赖关系的节点同时执行
 * - 节点可以挂三个流程入口：开始（结果作为初始资料）、验收（不通过就把意见交回节点继续完善）、
 *   结束（结果并入节点输出）；也可以整个节点就是执行另一个流程
 * - 每个节点在 task.steps 里有一条记录，id 是路径（`n1/review.2/n5`），也用作 CLI 会话键；
 *   续跑时已完成的节点直接复用输出
 * - 主 Agent 调度（工作流打开 dispatch 时）：每次执行一个工作流都有一个主 Agent（`@main` 节点，一个续接的会话），
 *   子 Agent 的节点完成后交给它评估（通过 / 退回 / 委派其他工作流 / 停下），条件连线由它选路，流程结束时它整理结果。
 *   调用另一个工作流时那个工作流有自己的主 Agent，挂在发起的节点下面，任务进度里就是主 Agent → 子 Agent 的层级
 * - 节点执行中可以通过编排工具（Orchestra，真实执行由 server/orch-mcp.ts 交给 CLI）派子 Agent 并行处理、
 *   查各 Agent 的状态、向主 Agent 提问、给别的 Agent 传话；派出的子 Agent 挂在节点下面（`n1/sub/h1`）
 *
 * 怎么调用一个 Agent 由宿主决定（server/exec/runner.ts 调用 CLI，shared/runner.ts 生成示例输出）。
 */
import type { HandoffInput } from './handoff.ts'
import type { ReviewTarget } from './clis.ts'
import { commonAgents, includedAgents, mountedAgents, roleKind, loadCapability } from './agent-role.ts'
import { INLINE_EDIT_MAX_FILES, INLINE_EDIT_MAX_LINES, normInlinePaths } from './inline-edit.ts'
import {
  END,
  START,
  type Agent,
  type AlertKind,
  type AskKind,
  type Flow,
  type FlowNode,
  type FlowEdge,
  type FlowRef,
  type NodeStep,
  type NodeTier,
  type ParamValues,
  type GlobalLesson,
  type ProjectLesson,
  type RunMessage,
  type RunStateEntry,
  type StopReason,
  type Task,
  type TaskRoute,
  type TaskRun,
  type TaskStep,
  type TestStep,
  type Workflow,
} from './schema.ts'
import {
  blankStep,
  currentRun,
  entryFlow,
  flowLabel,
  inRun,
  nodeAgent,
  nodeSteps,
  parallelTo,
  planTask,
  preds,
  reachable,
  resolveRef,
  runPrefix,
  stepTree,
  topoOrder,
  topSteps,
  workflowClosure,
  MAIN_STEP,
  dispatches,
  isMainStep,
  mainStep,
  blockedStep,
  reopenFlow,
  taskFlow,
} from './flow.ts'
import {
  dispatchText,
  evaluateEvent,
  firstPlanEvent,
  mainDuties,
  parseDispatch,
  planEvent,
  questionEvent,
  stripDispatch,
  summaryEvent,
  type Dispatch,
} from './dispatch.ts'
import { t } from './i18n.ts'
import { clip } from './text.ts'
import { sentToOther } from './peer-message.ts'
import { makeAlert } from './alerts.ts'
import { promptLangRules, promptLangWord, VERDICT_LINE } from './prompt-lang.ts'
import { searchExcludeFindPrune, searchExcludeGlobs, searchExcludePrompt } from './search-exclude.ts'
import { findLessons, type LessonQuery } from './lessons.ts'
import { TEST_TIME_SUMMARY_RULE, parentRunSteps, verifyBlock } from './test-steps.ts'
import { parseVerdict } from './verdict.ts'
import { REVIEW_SOFT_LIMIT_MIN } from './review-limits.ts'
import type { ReviewOverride, TriageItem } from './review-gate.ts'
import { beginTurn, convStateText, endTurn, pauseStep, stopReasonText, timeAgo, withAttachments } from './task.ts'
import { DEFAULT_WORKFLOW_ID } from './builtin/default.ts'
import { isHelperAgent } from './builtin/core.ts'
import {
  activePlan,
  applyPlan,
  bindRun,
  bindWait,
  endRun,
  finishPlan,
  finishStepNow,
  planNotice,
  planNowText,
  planText,
  runningStepId,
  settleWait,
  ensureChildStep,
  WRAP_UP,
  type PlanItemInput,
  type PlanKid,
  type WrapUpAnswer,
  type WrapUpKind,
} from './plan.ts'

/** 每个父对话交给子对话的话 → 交给了哪个子对话（见 sendToConversation：一条消息只交给一个子对话） */
const handedOff = new WeakMap<object, Map<string, string>>()

/**
 * 这个对话名下的子对话（计划按它对上等待、收口）：set_plan、finish_plan 都按这一份算。
 * 取不到列表时当没有子对话（老版本宿主），不影响计划本身
 */
async function kidsOf(host: EngineHost): Promise<PlanKid[]> {
  const list = host.listConversations ? await host.listConversations().catch(() => []) : []
  return list.map((c) => ({
    id: c.id,
    title: c.title,
    createdAt: c.createdAt ?? '',
    done: !!c.resolved,
    endedAt: c.resolved ? c.at : '',
  }))
}

/** 一个子对话的标题：取不到时返回空串（调用方退到用 id） */
async function kidTitleOf(host: EngineHost, id: string) {
  const list = host.listConversations ? await host.listConversations().catch(() => []) : []
  return list.find((c) => c.id === id)?.title.trim() ?? ''
}

/** 内置「版本控制」角色的来源标记：独立分支里的子对话不派它收尾（见 spawn） */
const VCS_ORIGIN = 'builtin:vcs'

/** 提示词里的流程入口名：提示词正文是给 Agent 的中文指令（只有回复语言跟随设置，见 prompt-lang.ts） */
const SLOT_PROMPT: Record<string, string> = {
  start: '开始',
  review: '验收',
  end: '结束',
  body: '执行',
  step: '步骤',
  sub: '子 Agent',
  call: '委派',
}

/** 节点提示词里节点自己的部分从这里开始，前面是同一个任务里各节点共用的部分 */
export const NODE_PART = '## 当前节点'

export type AgentResult =
  | { ok: true; text: string }
  /** stopped：用户停止；halted：别的节点失败了，这里没再继续（节点保持待执行，续跑时重来） */
  | { ok: false; stopped?: boolean; halted?: boolean; error: string; reported?: boolean; budget?: boolean }
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
  op?: { kind: 'compact' } | { kind: 'review'; target: ReviewTarget }
  /** 工作流里的调用：用默认 CLI 的这一档（空表示按 Agent 设的档位）；对话不传，用 Agent 自己的设置 */
  tier?: NodeTier
  /** Agent 参数的值（节点上填的）；不传时对话用任务里选的 */
  params?: ParamValues
  /** 主 Agent 的调度轮：评估节点、整理最终结果、回答子 Agent 的提问、决定用户新要求怎么处理（模拟执行据此给出示例输出） */
  dispatching?: 'evaluate' | 'summary' | 'answer' | 'plan'
  /** 工作流里的调用都带编排工具：派子 Agent、查状态、提问、传话（真实执行交给 CLI 的 MCP） */
  orch?: Orchestra
  /** 预热：打开对话页时先用 --resume 启动，只等下一句，不算一轮、不记输出 */
  prewarm?: boolean
  /** 只停这一次调用（终止单个子任务）；整个任务停止仍走宿主的信号 */
  signal?: AbortSignal
}

/** 交给评审的改动：snapshot 是这一刻的工作区快照（下一轮复看和它比），diff 太长时 diff 为空、完整内容在 file */
export interface ReviewDiff {
  snapshot: string
  stat: string
  diff: string
  file?: string
}

/** 分诊记录的输入：派单工具的 route 参数（主理写的理解、理由、假设） */
export interface RouteInput {
  understanding?: string
  reason?: string
  assumptions?: string
}

/**
 * 记一条分诊：只记父对话（能分派子对话的顶层对话）的，界面画成分诊卡。
 * 出自哪条消息按最后一条用户消息算（这一轮就是在回应它）
 */
function recordRoute(
  host: EngineHost,
  target: TaskRoute['target'],
  refs: string[],
  label: string,
  route: RouteInput | undefined,
) {
  const { task } = host
  const str = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, 500) : '')
  const ask = [...task.messages].reverse().find((m) => m.role === 'user' && !m.peer)
  task.routes = [
    ...(task.routes ?? []).slice(-499),
    {
      id: host.newId(),
      target,
      refs: refs.slice(0, 20),
      label: label.slice(0, 200),
      understanding: str(route?.understanding),
      reason: str(route?.reason),
      assumptions: str(route?.assumptions),
      messageId: ask?.id ?? '',
      at: now(),
    },
  ]
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

/** 子任务结果交给对话的 CLI。preempt：它正在回复等待期间的用户消息，先放下那条，做完再回去 */
export const helperPrompt = (late: string, preempt = false) =>
  preempt
    ? `【面板】你派出的子任务都结束了。先放下正在回复的这条用户消息，根据下面的结果把派子任务之前的工作做完；` +
      `做完后再回到那条用户消息，接着回复还没回复完的部分。\n\n${late}`
    : `【面板】你派出的子任务都结束了，结果如下：\n\n${late}\n\n请根据这些结果接着做。`

/** 等子任务期间用户发来的消息：马上回复，子任务的结果交回后再接着之前的工作 */
export const sideChatPrompt = (text: string) =>
  '【面板】你派出的子任务还在执行，用户在等待期间发来了消息。请直接回复这条消息，不要停下来等子任务；' +
  '需要用到子任务结果的部分说明会在结果交回后处理。子任务全部交回后面板会把结果交给你，到时先处理结果，' +
  `再回到这里没做完的部分。\n\n用户的消息：\n${text}`

/**
 * 对话等子任务的这段时间：用户照样能聊，消息马上交给 CLI 回复；
 * 这一批全部交回后立刻处理结果（正在回复用户时用插话打断它），处理完再回到被打断的那条消息。
 * 引擎（回复完 CLI 就退出的，Claude Code、Codex）和 runner（CLI 停在面板的等待工具上的）各用一个。
 */
export function helperGate(
  batch: () => Promise<HelperBatch> | undefined,
  /** 把结果插进正在回复用户消息的这一轮；交不进去返回 false，等这一轮结束再交 */
  steer?: (text: string) => Promise<boolean>,
) {
  /** 交回了、但还没交给 CLI 的结果（插话没交进去） */
  let carry = ''
  /** CLI 正在回复等待期间的用户消息 */
  let replying = false
  /** 正在等的这一批：交回后它从编排状态里删掉，没认领前要自己留着 */
  let watching: Promise<HelperBatch> | undefined
  return {
    /**
     * 一轮结束后调：没有要等的子任务返回 undefined；否则等到下一件要做的事，返回交给 CLI 的提示词。
     * listen 等用户的下一条消息（返回 null 表示不再等，比如页面离开了），停止或结果被别处认领了返回空字符串
     */
    wait(signal: AbortSignal, listen?: (signal: AbortSignal) => Promise<string | null>): Promise<string> | undefined {
      replying = false
      if (carry) {
        const late = carry
        carry = ''
        return Promise.resolve(helperPrompt(late))
      }
      const b = watching ?? batch()
      if (!b) return undefined
      watching = b
      return (async () => {
        const ac = new AbortController()
        const stop = () => ac.abort()
        signal.addEventListener('abort', stop, { once: true })
        try {
          const aborted = new Promise<null>((r) => ac.signal.addEventListener('abort', () => r(null), { once: true }))
          // 不再等用户（页面离开了）就只等子任务
          const user = listen
            ? listen(ac.signal).then((text) => (text === null ? new Promise<never>(() => {}) : { user: text }))
            : new Promise<never>(() => {})
          const got = await Promise.race([b.then((x) => ({ back: x })), user, aborted])
          if (!got || signal.aborted) return ''
          if ('back' in got) {
            watching = undefined
            const late = got.back.take()
            return late ? helperPrompt(late) : ''
          }
          replying = true
          // 整批交回时还在回复这条消息：插话打断它，先处理结果；交不进去的等这一轮结束再交
          void b.then(async (x) => {
            if (!replying || !steer) return
            const late = x.take()
            watching = undefined
            if (late && !(await steer(helperPrompt(late, true)))) carry = late
          })
          return sideChatPrompt(got.user)
        } finally {
          signal.removeEventListener('abort', stop)
          ac.abort()
        }
      })()
    },
  }
}

export interface Orchestra {
  /** 调用者的节点 id */
  self: string
  /** 这个工作流有没有主 Agent 调度（没有时不能提问） */
  hasMain: boolean
  /** 这条调用是不是常驻编排器自己的（只有它能起停运行） */
  planner: boolean
  /** 可以直接派的通用 Agent（名字和简介），spawn_agents 里列出来 */
  common: { name: string; description: string }[]
  /** 调用者自己就是子任务：不能再派子任务、不能启动工作流、不能开子对话 */
  helper: boolean
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
  wait(ids: string[], ms: number): Promise<{ done: HelperReport[]; running: HelperReport[] }>
  ask(question: string, ms: number): Promise<{ answer?: string; pending?: boolean; error?: string }>
  send(to: string, text: string): Promise<{ ok: boolean; info: string }>
  inbox(): string[]
  /** 起一次新的运行：节点全部新建，按流程图执行。同一次运行里不能嵌套起运行 */
  run(input: string): { ok: boolean; info: string }
  /** 结束这次运行：没完成的节点不再执行，之后的要求由编排器直接处理 */
  closeRun(): { ok: boolean; info: string }
  /** 对话 Agent：可以把一次工作流运行排到这一轮后面，跑完再继续对话 */
  planning: boolean
  /** step：这次运行是计划里的哪个主步骤（不写就在计划末尾加一步） */
  plan(workflowId: string, input: string, step?: string): { ok: boolean; info: string }
  /** 项目里的对话有执行计划：set_plan 交整份计划，finish_plan 结束这份计划 */
  plans: boolean
  /** partial：只交变更步骤，其余没写到的步骤留在计划里不动（步骤多时分两批交） */
  setPlan(input: { title?: string; steps?: PlanItemInput[]; partial?: boolean }): Promise<{ ok: boolean; info: string }>
  finishPlan(summary: string): Promise<{ ok: boolean; info: string }>
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
    extra?: { role?: string; route?: RouteInput },
  ): Promise<{ ok: boolean; id?: string; info: string }>
  sendToConversation(
    id: string,
    message: string,
    step?: string,
    route?: RouteInput,
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
    step?: string
  }): Promise<{
    ok: boolean
    info: string
  }>
  checkBackground(id: string): string
  stopBackground(id: string): { ok: boolean; info: string }
  /** 独立分支里的子对话：测试跑通就调用，面板合回原分支后子对话算完成（排队，结果推回来） */
  canSubmit: boolean
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
  toParent(text: string, question: boolean, options?: string[], kind?: AskKind): Promise<{ ok: boolean; info: string }>
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
  /** 项目教训：按文件 / 关键词 / 标签取全文、记一条；不在项目里时没有 */
  lessons?: {
    find(files: string[], opts?: LessonQuery): Promise<string>
    record(input: LessonInput): Promise<{ ok: boolean; info: string }>
  }
  /** P4 工作区：按文件类型把改动分进各自的 pending（面板执行，不是 P4 项目时没有） */
  p4Split?: EngineHost['p4Split']
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
    /** 这个对话里用户对推送的回答 */
    answered?: 'allowed' | 'denied'
    /** 已安装并登录的外部工具 */
    tools: string[]
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
  confirm?: (step: TaskStep, text: string) => Promise<{ allow: boolean; answer?: string } | null>
  /** 节点结果太长时把完整内容存成文件，返回文件路径，下游节点自己去读；没有时只截断 */
  saveHandoff?: (step: TaskStep, text: string) => Promise<string>
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
  /** 项目里可选的工作流目录：启动计划时 Agent 按名称、说明和节点概览挑一个 */
  workflowCatalog?: () => { id: string; name: string; description: string; steps: string[] }[]
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
  /** 子对话列表：协调 Agent 判断这条消息该交给哪个子对话 */
  listConversations?: () => Promise<
    {
      id: string
      title: string
      status: string
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
  }) => Promise<{ ok: boolean; id?: string; title?: string; info: string }>
  /** 给已有子对话追加消息并异步执行 */
  sendToConversation?: (id: string, message: string) => Promise<{ ok: boolean; info: string }>
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
  /** 独立分支里的子对话：测试跑通后合回原分支（面板排队试合并，有冲突撤回，结果推回子对话；合进去就算完成） */
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
   * 要改文件时才开独立分支、现在还没开：面板从当前目录建 worktree，这一轮结束后在里面开新会话接着做。
   * 只有对话有（工作流在创建时就建好了）
   */
  beginEdit?: () => Promise<{ ok: boolean; info: string }>
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
  /** 子对话：认领 / 释放要改的文件（同一父对话下的子对话共用一个目录） */ claimFiles?: (paths: string[]) => {
    granted: string[]
    held: { path: string; by: string }[]
  }
  releaseFiles?: (paths: string[]) => number
  /** 项目教训：按要改的文件查，Agent 被纠正后自己记一条（只有项目里的对话和节点有） */
  lessons?: {
    list: () => Promise<ProjectLesson[]>
    /** 全局教训：只读，Agent 改不了 */
    globals?: () => Promise<GlobalLesson[]>
    record: (input: LessonInput) => Promise<{ ok: boolean; info: string }>
  }
  /** P4 工作区（项目里的对话）：按文件类型分 changelist，由面板跑 p4，规则不靠 Agent 自觉 */
  p4Split?: (input: P4SplitArgs) => Promise<{ ok: boolean; info: string }>
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

const MAX_DEPTH = 6
const MAX_OUTPUT = 4000
const now = () => new Date().toISOString()

/** 这次运行的工作流运行记录（新架构按运行隔离共享状态和消息）；旧任务没有 */
function runRecord(task: Task): TaskRun | undefined {
  const run = currentRun(task)
  return (task.runs ?? []).find((r) => r.id === run)
}

/** 这次运行里所有节点共享的键值状态 */
function runState(task: Task): Record<string, RunStateEntry> {
  return runRecord(task)?.state ?? {}
}

/** 交给节点的共享状态快照：并发节点开始前读一次，执行中也可以用 read_state 再读 */
function statePart(task: Task) {
  // 只注入「这一次还在跑的运行」的状态：对话里跑过 start_plan 之后 task.runs 留着上一次运行，
  // 再注入旧状态会误导模型，而对话模式根本没注册 read_state / write_state（提示里也不能提）
  const rec = runRecord(task)
  if (!rec || rec.status !== 'running') return ''
  const entries = Object.entries(rec.state)
  if (!entries.length) return ''
  const lines = entries.slice(0, 50).map(([k, v]) => {
    const who = v.by || '未知节点'
    return `- ${k}（v${v.version}，${who} 写入）：${clip(v.value, 1200)}`
  })
  return `## 共享状态\n这是本次运行里所有节点共同维护的状态，可以用 read_state / write_state 读写；写之前先看版本，别覆盖别人刚写的内容：\n${clip(lines.join('\n'), 12000)}`
}

/** 这次运行的记录：新架构在启动运行时建；旧版工作流任务也在开始执行时补一条，共享状态和消息才有地方存 */
function ensureTaskRun(host: EngineHost, workflow: Workflow, run: number, skillSlots = host.task.skillSlots) {
  const has = host.task.runs.find((r) => r.id === run)
  if (has) return has
  const rec: TaskRun = {
    id: run,
    workflowId: workflow.id,
    workflowName: workflow.name,
    workflows: host.workflows.length ? host.workflows : [workflow],
    skillSlots,
    status: 'running',
    startedAt: now(),
    endedAt: '',
    state: {},
    messages: [],
  }
  host.task.runs.push(rec)
  return rec
}

/** 写共享状态：版本号加一，后写的覆盖先写的 */
function writeRunState(host: EngineHost, by: string, key: string, value: string) {
  const rec = runRecord(host.task)
  if (!rec) return { ok: false, info: '这次运行没有共享状态（可能是旧版对话），直接写在结果里交给下游节点' }
  const k = key.trim().slice(0, 80)
  if (!k) return { ok: false, info: 'key 不能为空' }
  const old = rec.state[k]
  const version = (old?.version ?? 0) + 1
  rec.state[k] = { value: clip(value, 20000), version, by, at: now() }
  host.changed(true)
  return { ok: true, version, info: `已写入「${k}」v${version}` }
}

/** 一次运行的收件箱：没读过的消息，读完记下来，历史仍留在运行记录里 */
function runMail(host: EngineHost, id: string) {
  const rec = runRecord(host.task)
  if (!rec) return []
  const got = rec.messages.filter((m) => m.to === id && !m.read)
  for (const m of got) m.read = true
  if (got.length) host.changed()
  return got.map((m) => m.text)
}

/** 节点之间发消息：并发节点执行中能互相提醒，消息按运行保存，重启后还能看到 */
function sendRunMessage(host: EngineHost, from: string, to: string, text: string) {
  const rec = runRecord(host.task)
  if (!rec) return false
  const msg: RunMessage = { id: host.newId(), from, to, text: clip(text, 20000), read: false, at: now() }
  rec.messages.push(msg)
  host.changed(true)
  return true
}

/** 节点 / 步骤的输出：太长时另存文件，交给下游的结果里写明去哪读 */
async function storeOutput(host: EngineHost, step: TaskStep, text: string) {
  let out = clip(text, MAX_OUTPUT)
  if (text.length > MAX_OUTPUT && host.saveHandoff) {
    const file = await host.saveHandoff(step, text).catch(() => '')
    if (file) out += `\n\n（完整结果有 ${text.length} 字，这里只附了开头。完整内容在文件 ${file}，开始之前请先读完。）`
  }
  return out
}

/** 一次流程调用：在哪个工作流的哪个流程，挂在哪个节点的哪个入口下 */
interface Invocation {
  workflow: Workflow
  flow: Flow
  parentId: string
  slot: TaskStep['slot']
  round: number
  /** 流程的输入：主流程是用户需求，入口流程是发起节点交过来的资料 */
  input: string
  /** 入口流程的发起节点标题 */
  owner?: string
  depth: number
  /** 第几次运行：同一个对话里工作流可以按顺序跑多次，节点 id 按它隔离 */
  run: number
  /** 调度这个流程的主 Agent；同一工作流里的子流程、入口流程沿用发起它的那个 */
  main?: MainCtl
}

/** 一次工作流执行的主 Agent：一个节点、一个续接的会话，调度轮一轮接一轮（同一个会话不能同时跑两轮） */
interface MainCtl {
  step: TaskStep
  workflow: Workflow
  flow: Flow
  chain: Promise<unknown>
  /** 是不是外层还有流程（结果交回上一级，不是直接给用户） */
  nested: boolean
}

type FlowResult = { ok: true; output: string } | Fail

export { parseVerdict }

export function system(host: EngineHost, text: string, step = '', error = false, transient = false, kind?: AlertKind) {
  host.task.messages.push({
    id: host.newId(),
    role: 'system',
    agentId: '',
    step,
    text,
    tools: [],
    ...(error && { error, alert: makeAlert('error', text) }),
    // 不是错误但要提醒的（例如超过自己设的预算上限）：按传入的类别画成一条警告
    ...(!error && kind && { alert: makeAlert('warn', text, kind) }),
    ...(transient && { transient }),
    at: now(),
  })
}

/** 计划 / 工作流启动的那条提示：只是把计划输入又抄了一遍，界面上不显示（用户知道自己让 Agent 干了什么），数据里留着 */
function planStarted(host: EngineHost, text: string, step = '') {
  host.task.messages.push({
    id: host.newId(),
    role: 'system',
    agentId: '',
    step,
    text,
    tools: [],
    planStart: true,
    at: now(),
  })
}

/**
 * 两个上限（工作流设的、计划设的）取更小的非零值：都设了时谁先到都算超。
 * 返回上限值和它是谁设的，文案要说清是哪个上限到了，用户才知道该去哪里改。
 */
export function budgetLimit(
  workflow: number | undefined,
  plan: number,
): { value: number; by: 'workflow' | 'plan' } | null {
  const w = workflow && workflow > 0 ? workflow : 0
  const p = plan && plan > 0 ? plan : 0
  if (!w && !p) return null
  if (!p) return { value: w, by: 'workflow' }
  if (!w) return { value: p, by: 'plan' }
  return w <= p ? { value: w, by: 'workflow' } : { value: p, by: 'plan' }
}

/**
 * 这一轮用掉的花费 / token / 时长超过上限时，返回暂停的说明（导出给单测验证聊天模式也走这套判定）。
 * includeWorkflow：要把工作流设的上限也算进来吗。节点执行路径传 true；
 * chat 路径传 false——工作流预算管的是「这次工作流执行」，对话里跑过一次 start_plan 之后，
 * 任务会一直带着工作流快照（host.workflow 非空），不能让那个上限转头把普通的聊天轮次也停掉。
 */
export function overBudget(host: EngineHost, includeWorkflow = true): string {
  const w = includeWorkflow ? host.workflow : undefined
  const { usage, budgetFrom, budgetTokens, budgetMinutes } = host.task
  const usd = usage.costUsd - (budgetFrom?.usd ?? 0)
  const tokens = usage.inputTokens + usage.outputTokens - (budgetFrom?.tokens ?? 0)
  if (w?.budgetUsd && usd >= w.budgetUsd)
    return t('这次执行已经花了 ${used}，达到工作流设定的上限 ${limit}，已暂停。点「继续执行」会再给一份同样的额度。', {
      used: usd.toFixed(2),
      limit: w.budgetUsd.toFixed(2),
    })
  // token：工作流和计划都设了上限时取小的那个
  const tokenLimit = budgetLimit(w?.budgetTokens, budgetTokens ?? 0)
  if (tokenLimit && tokens >= tokenLimit.value)
    return tokenLimit.by === 'workflow'
      ? t('这次执行已经用了 {used} token，达到工作流设定的上限 {limit}，已暂停。点「继续执行」会再给一份同样的额度。', {
          used: Math.round(tokens).toLocaleString(),
          limit: tokenLimit.value.toLocaleString(),
        })
      : t(
          '这次执行已经用了 {used} token，达到计划设定的上限 {limit}，已暂停。已经产出的内容都保留着，点「继续执行」会重新计。',
          { used: Math.round(tokens).toLocaleString(), limit: tokenLimit.value.toLocaleString() },
        )
  // 时长：从这一轮开始算，旧任务没有开始时刻（at）时按不限处理
  const startedAt = budgetFrom?.at
  if (budgetMinutes && startedAt) {
    const usedMinutes = (Date.now() - startedAt) / 60_000
    if (usedMinutes >= budgetMinutes)
      return t(
        '这次执行已经用了 {used} 分钟，达到计划设定的上限 {limit} 分钟，已暂停。已经产出的内容都保留着，点「继续执行」会重新计时。',
        { used: Math.round(usedMinutes), limit: budgetMinutes },
      )
  }
  return ''
}

function userRequests(task: Task) {
  // 和实际交给 CLI 的一样：文字里的附件引用换成路径，没引用的列在后面
  const users = task.messages
    .filter((m) => m.role === 'user' && !m.step)
    .map((m) => withAttachments(m.prompt || m.text, m.attachments))
  return { original: users[0] ?? '', extra: users.slice(1) }
}

const stepPath = (inv: Invocation, nodeId: string) =>
  inv.parentId
    ? `${inv.parentId}/${inv.slot}${inv.round ? `.${inv.round}` : ''}/${nodeId}`
    : `${runPrefix(inv.run)}${nodeId}`

function ensureStep(host: EngineHost, inv: Invocation, node: FlowNode, index: number): TaskStep {
  const id = stepPath(inv, node.id)
  let step = host.task.steps.find((s) => s.id === id)
  if (!step) {
    // 多步节点：节点记录只负责展示和汇总，执行者按第一步算
    const first = nodeSteps(node)[0]
    step = blankStep({
      id,
      parentId: inv.parentId,
      slot: inv.parentId ? inv.slot : '',
      round: inv.round,
      workflowId: inv.workflow.id,
      flowId: inv.flow.id,
      nodeId: node.id,
      kind: first.kind,
      title: node.title.trim() || t('节点 {n}', { n: index + 1 }),
      agentId: first.kind === 'agent' ? nodeAgent(inv.workflow, first.agentId) : '',
    })
    host.task.steps.push(step)
  }
  return step
}

/** 节点里一步的执行记录：旧节点用节点记录本身，显式步骤用 `<节点>/step/<步骤 id>` */
function ensureUnitStep(
  host: EngineHost,
  inv: Invocation,
  node: FlowNode,
  record: TaskStep,
  unit: NodeStep,
  index: number,
): TaskStep {
  if (!node.steps.length) return record
  const id = `${record.id}/step/${unit.id}`
  let step = host.task.steps.find((s) => s.id === id)
  if (!step) {
    step = blankStep({
      id,
      parentId: record.id,
      slot: 'step',
      workflowId: inv.workflow.id,
      flowId: inv.flow.id,
      nodeId: unit.id,
      kind: unit.kind,
      title: unitTitle(host, inv, unit, index),
      agentId: unit.kind === 'agent' ? nodeAgent(inv.workflow, unit.agentId) : '',
    })
    host.task.steps.push(step)
  }
  return step
}

/** 显式步骤显示的名字：没写标题时用 Agent / 流程的名字 */
function unitTitle(host: EngineHost, inv: Invocation, unit: NodeStep, index: number) {
  if (unit.title.trim()) return unit.title.trim()
  if (unit.kind === 'flow') {
    const target = resolveRef(unit.flow, inv.workflow, host.workflows)
    return target ? t('调用流程「{name}」', { name: flowLabel(target.flow, target.workflow) }) : t('调用流程')
  }
  return (
    host.agents.find((a) => a.id === nodeAgent(inv.workflow, unit.agentId))?.name ?? t('步骤 {n}', { n: index + 1 })
  )
}

/** 节点重跑：显式步骤的所有记录和消息一起删掉，从第一步重新开始 */
function dropNodeSteps(host: EngineHost, step: TaskStep) {
  const drop = new Set(
    stepTree(host.task, step.id)
      .filter((s) => s.id.slice(step.id.length + 1).split('/')[0] === 'step')
      .map((s) => s.id),
  )
  if (!drop.size) return
  // 这些单元记录整条要删掉：它们记着的验收不通过次数、重跑次数先汇总到节点上，不然重跑一次就少算一遍
  const gone = host.task.steps.filter((s) => drop.has(s.id))
  step.reviews = (step.reviews ?? 0) + gone.reduce((n, s) => n + (s.reviews ?? 0), 0)
  step.reruns = (step.reruns ?? 0) + gone.reduce((n, s) => n + (s.reruns ?? 0), 0)
  host.task.steps = host.task.steps.filter((s) => !drop.has(s.id))
  host.task.messages = host.task.messages.filter((m) => !drop.has(m.step))
}

/**
 * 节点重跑时删掉要重新来的子节点和它们的消息：验收、结束，以及验收不通过后的返工轮次（body.N）。
 * 开始流程和第一轮的流程节点已完成的部分可以复用。
 */
function dropRerun(host: EngineHost, step: TaskStep) {
  const drop = new Set(
    stepTree(host.task, step.id)
      .filter((s) => {
        const seg = s.id.slice(step.id.length + 1).split('/')[0]
        return /^(review|end|call)(\.\d+)?$/.test(seg) || /^body\.\d+$/.test(seg) || seg === 'sub'
      })
      .map((s) => s.id),
  )
  if (!drop.size) return
  host.task.steps = host.task.steps.filter((s) => !drop.has(s.id))
  host.task.messages = host.task.messages.filter((m) => !drop.has(m.step))
}

/**
 * 这个项目的搜索排除清单：紧跟在通用约束的「搜索范围」后面，Agent 直接照着拼带排除的命令。
 * 清单来自项目设置（项目填的 + 内置默认），每个项目一份；内置默认总在，所以这一段总会出现
 */
function searchPart(host: EngineHost) {
  const project = { searchExclude: host.searchExclude }
  const line = searchExcludePrompt(project)
  if (!line) return ''
  const extra = searchExcludeGlobs(project, { onlyProject: true })
  // Git 仓库里内置默认清单靠 .gitignore 就挡住了，rg 再列一遍只会误伤真叫 build / out 的源码目录；
  // 最常见的漏网是 Agent 自己加 --no-ignore / -uu，所以明说不要加
  const rg = host.searchInGit
    ? `这是 Git 仓库：rg、\`git grep\` 和 CLI 自带的搜索工具默认已经跳过 .gitignore 里的文件和隐藏目录，不要加 \`--no-ignore\`、\`-u\` / \`-uu\`、\`--hidden\` 把它们扫回来；rg 只需${extra ? `再排除 .gitignore 没覆盖的：\`rg ${extra} <关键字> <目录>\`` : `限定目录：\`rg <关键字> <目录>\``}。`
    : `这里没有 .gitignore 可依赖，rg 要带上整份排除：\`rg ${searchExcludeGlobs(project)} <关键字> <目录>\`。`
  return [
    `## 搜索排除（这个项目）\n${line}。找 Bug 在这一层定位时也用同样的排除。`,
    `- 起点先限定到模块目录（CLI 自带的搜索工具也把路径参数设成模块目录），没命中再逐级扩大。`,
    `- ${rg}`,
    `- \`find\` 不读 .gitignore，必须限深度并剪掉这些目录：\`find <目录> -maxdepth 4 ${searchExcludeFindPrune(project)} -type f -name '<文件名>' -print\`；不要 \`find .\` 或 \`grep -r\` 扫整个仓库。`,
    `- 要看被排除目录里的内容（例如 Saved/Logs 下的日志）时，直接把那个目录当起点去读或搜，不要因此去掉整份排除。`,
  ].join('\n')
}

/**
 * 同一轮执行里的授权情况：项目设置的推送策略、这个对话里用户已经做过的选择、本机已经登录的外部工具。
 * 只写已经具备的能力，没装的、没授权的不要列出来，免得模型去试。
 */
function policyPart(host: EngineHost) {
  const p = host.policy
  if (!p) return ''
  const tools = p.tools.length
    ? `已经授权可用的工具：${p.tools.join('、')}（直接用，不要重新登录）。`
    : '本机没有检测到可用的外部授权工具（例如 gh），需要时请用户先自己登录。'
  // 子对话不碰远端：不论项目设置怎么定，推不推都由父对话决定，问了也只是白问（曾经弹出「要不要推送」的问题）
  if (host.task.parentTaskId)
    return `## 授权情况\n推送：推送、创建 PR、P4 submit、合并到主干由父对话决定，不在你的处理范围内：不执行、不询问用户、也不写进提问、计划步骤或建议。你这一轮的「完成」就是${wrapDone(host.wrapUp, parentRunsIn(host))}${host.wrapUp ? '：这是收尾，面板会自动列成计划的最后一步，不要自己再写一步' : ''}，不要写「等推送 / 等合入其他分支 / 同步远端」，更不因此停下来等。\n${tools}`
  // 「需要推送」要说清是什么时候：技能和角色设定默认都是「本地先行、不主动推送」，
  // 只写一句「可以推送」时模型照样只做本地提交，三个选项的效果就没有区别了
  const wt =
    host.task.worktree?.state === 'active' ? '（在独立分支里工作时按下面「执行目录」那段：独立分支本身不推）' : ''
  const done = '任务做完、验证通过并在本地提交之后'
  // 推送这一步已经由面板列进计划（push 收尾，见 plan.ts 的 wrapUpKind），所以这里不写「你可以推」，
  // 只写「按计划最后那一步做」：另写一遍时模型会自己再补一条「推送到远端」步骤，和面板的收尾撞在一起
  const kind = wrapKind(host)
  const planned = kind
    ? `，会列计划的任务：${WRAP_UP[kind].title}已经在计划的最后一步（面板已经列好，刷新也不会变），照着它做，不要自己再写一条`
    : ''
  const push =
    p.push === 'deny'
      ? '推送：项目设置是「不推送，只做本地提交」。不 push、不建 PR、不 P4 submit，也不问用户要不要推；用户在对话里要求推送时，告诉用户先到项目设置把「推送到远端」改掉（这个项目的 git push 已经被面板拦下）。'
      : p.answered === 'denied'
        ? '推送：这个对话里用户已经拒绝过推送，这次不要再问，也不要推。'
        : p.answered === 'allowed' || p.push === 'allow'
          ? `推送：${p.answered === 'allowed' ? '这个对话里用户已经同意推送' : '项目设置是「允许直接推送」，这就是用户的授权'}，不用再问。${done}${wt}就把当前分支推到它跟踪的远端分支（没有跟踪分支时推到 origin 的同名分支并设上跟踪）${planned}，推完回读确认（git status -sb），结论里写清推到了哪个远端分支。只做普通推送：不强推，被拒（远端有新提交）就停下来报告，不自己 pull / rebase；创建 PR、P4 submit、合并到主干不在这个授权里，用户要求时才做。`
          : `推送：项目设置是「第一次需要推送时问一次」。${done}，用提问工具问用户一次要不要推送（推荐「允许这次推送」和「只做本地提交」），按回答做${wt}；这个对话里之后都按这次的回答，不再重复问。`
  return `## 授权情况\n${push}\n这条是用户在项目设置里定的，比角色设定、技能里「不推送 / 本地先行 / 推送要用户明确授权」的默认写法优先。\n${tools}`
}

/** 这一轮的收尾种类：'none'（明确不推送）当成没有收尾，提示词里不提它 */
function wrapKind(host: EngineHost): WrapUpKind | undefined {
  return host.wrapUp === 'none' ? undefined : host.wrapUp
}

/** 这个对话有没有「合回后由父对话跑」的测试步骤（见 ADR 0018）：说法里要把它算进完成条件 */
const parentRunsIn = (host: EngineHost) =>
  host.verify?.parentRun === 'child' && parentRunSteps(host.verify.steps).length > 0

/** 计划的「做完」是什么：按收尾种类说，没有收尾的（共用父对话目录的 Git 子对话）改完就在父对话的分支上 */
function wrapDone(kind: WrapUpAnswer | undefined, parentRuns = false) {
  if (kind === 'p4') return '改动已按文件类型分进各自的 pending changelist'
  if (kind === 'merge')
    return parentRuns
      ? '改动已合回父对话所在的分支、父对话跑范围为「全量，合并后由父对话跑」的步骤通过（submit_merge 由面板合并）'
      : '改动已合回父对话所在的分支（submit_merge 由面板合并）'
  if (kind === 'push') return '改动已推到远端，结论里写清了推到哪个远端分支'
  return '改动已经在父对话所在的分支上'
}

/**
 * 计划的收尾怎么做：面板把它加成计划的最后一步，这里讲清楚做什么、谁来标完成。
 * P4 的分桶规则写在这里，不靠 project-vcs 技能：对话里的子对话不一定派「版本控制」角色，
 * 没有这段时改动全留在 default 或塞进同一个 changelist
 */
function wrapUpPart(host: EngineHost) {
  const kind = wrapKind(host)
  if (!kind) return ''
  const head = `## 收尾：计划的最后一步
面板会在你的计划最后自动加上「${WRAP_UP[kind].title}」，不用自己写这一步，也别删、别挪到前面（下一条计划里它仍在最后）；前面的步骤做完、验证通过后再做它。`
  if (kind === 'merge')
    return `${head}
做法：调用 submit_merge（tests 写上跑过的编译和测试）。合进去后面板把这一步标完成，你不要自己标；有冲突会推回给你，处理好重新验证后再调用。${
      parentRunsIn(host)
        ? `
项目里有范围为「全量，合并后由父对话跑」的步骤：它们你不用跑，合进去后由父对话在它的目录里跑，结果会回传给你。所以合进去不等于收尾：父对话的测试通过才标完成；失败时面板把报错原文推回来，按它修好再调用 submit_merge（这些步骤会全部重跑）。收尾总结里要有一份「编译 / 测试耗时」，两类执行方都写上。`
        : ''
    }`
  // 推送归 Agent 自己做（面板拿不到 git push 的结果，不像合并那样能替它标完成）：讲清做什么、做完自己标
  if (kind === 'push')
    return `${head}
做法：${WRAP_UP.push.note}。计划里的其他步骤都做完、验证通过、改动已在本地提交之后再推；这一步做完自己用 set_plan 把它标完成，面板不会替你标。在独立分支里时按上面「执行目录」那段先合回原分支，再在原目录推原分支。`
  return `${head}
${p4Rules(host)}做完再把这一步标完成。不 submit、不 revert、不 sync。`
}

/**
 * P4 分 changelist 的规则：项目里的对话都要知道（以前只写给子对话，父对话自己放 CL 时建出过「[C++/Lua] …」），
 * 有 p4_split_changelists 时交给面板分，Agent 只写描述
 */
function p4Rules(host: EngineHost) {
  const head = `这是 P4 工作区，修改前先 p4 edit / add 进 default changelist（限定到具体文件）；edit 前用 p4 fstat -T haveRev,headRev <文件> 看是不是最新版本，本地版本落后（haveRev 小于 headRev）时先告诉用户要同步，你自己不 sync。p4 diff / status / reconcile / fstat 都要带具体文件或任务目录，不对整个工作区跑（大项目会扫几分钟本地文件）；查改了哪些文件用 p4 opened -c，它只问服务器、不扫本地。把改动放进 pending changelist 时按文件类型分开，不能全留在 default，也不能把几类放进同一个（不要建「[C++/Lua] …」这种）：
- [C++]：.c / .cc / .cpp / .cxx / .h / .hh / .hpp / .inl / .ixx / .mm
- [XLSX]（表格）：.xlsx / .xlsm / .xlsb / .xls / .csv
- [Lua]：.lua（只提交源码，不编译成 .luac，也不提交 .luac）
- [Other]：其余要提交的代码、资源和配置
`
  if (host.p4Split)
    return `${head}调用 p4_split_changelists 分：面板按上面的类型建 pending 并挪文件，你只在 descriptions 里给这次有文件的每一类写一句中文描述（约 40 字内，不带标签）。default 里有不属于这次任务的文件时用 files 只列本次的；已经混在一个 pending 里的用 from 写它的编号拆开。本来就在你已有 pending 里的文件留在原处。看它返回的编号和回读结果，`
  return `${head}只建这次真的有文件的类型；本来就在你（当前用户、当前 client）已有 pending 里的文件留在原 changelist，不挪别人的。新建用 p4 change -i 读 UTF-8 临时文件，再 p4 reopen -c <编号> <文件>；描述只写一行「[类型] 中文短句」（约 40 字内）。用 p4 opened -c <编号> 核对每个文件、p4 describe -s 回读确认描述没有乱码，`
}

/** 不是子对话收尾的场合（父对话、工作流节点）：P4 项目里也要按类型分 changelist */
function p4Part(host: EngineHost) {
  if (!host.p4Split || wrapKind(host) === 'p4') return ''
  return `## P4 changelist\n${p4Rules(host)}不 submit、不 revert、不 sync。`
}

/** 对话的目标：用户在父对话设置里写的，父对话按它取舍，子对话知道自己这部分是为了什么 */
function goalPart(host: EngineHost) {
  const goal = host.goal?.trim()
  if (!goal) return ''
  return host.task.parentTaskId
    ? `## 父对话的目标\n${clip(goal, 4000)}\n你做的是其中一部分，取舍时以这个目标为准。`
    : `## 这个对话的目标\n${clip(goal, 4000)}\n判断要不要做、做到哪一步、怎么分派时以这个目标为准。`
}

/** 父对话发布的全局规则：子对话和它的所有节点都要遵守；父对话自己看到的是「你发布的」 */
function rulesPart(host: EngineHost) {
  const rules = (host.rules ?? []).map((r) => r.trim()).filter(Boolean)
  if (!rules.length) return ''
  const list = rules.map((r, i) => `${i + 1}. ${clip(r, 2000)}`).join('\n')
  return host.task.parentTaskId
    ? `## 全局规则（父对话发布，必须遵守）\n${list}\n和其他要求冲突时以这些规则为准；做不到的地方用 message_parent 告诉父对话，不要自己绕过。`
    : `## 这个对话的全局规则\n你和用户在这个对话里发布的规则，所有子对话都会收到并遵守：\n${list}`
}

/** 父对话：上一轮之后子对话发来的消息（汇报、提问），这一轮一起处理 */
function inboxPart(host: EngineHost) {
  const got = host.takeInbox?.() ?? []
  if (!got.length) return ''
  // 「提问」关着时子对话的提问 / 收尾建议不会交给用户，等的是父对话自己的决定
  const ask = host.task.askUser
    ? ''
    : '「提问」关着：子对话的提问和收尾建议都由你决定，用户不会回答。按已有信息选最合理的做法，写清「你替他决定了什么、依据、如果不对怎么改」，缺关键信息也选一个默认方案继续并在结论里标出；不要空着等用户。'
  return `## 子对话发来的消息\n${got.map((m) => `- 「${m.title}」：${clip(m.text, 2000)}`).join('\n')}\n需要回复的用 send_to_conversation 交回给对应的子对话。${ask}`
}

/**
 * 写文件的格式：项目设置在全局设置里定的编码和换行符。
 * 说清楚是为了避免 Windows 上写出的 CRLF / BOM 让脚本在 WSL / Linux 里跑不起来。
 */
function fileFormatPart(host: EngineHost) {
  const f = host.fileFormat
  if (!f) return ''
  const enc = f.encoding === 'utf8-bom' ? 'UTF-8（带 BOM）' : 'UTF-8（不带 BOM）'
  const eol = f.eol === 'crlf' ? 'CRLF（Windows）' : 'LF'
  const tip =
    f.eol === 'lf' && f.encoding === 'utf8'
      ? '这样在 WSL / Linux 里执行带 shebang 的脚本不会报 bad interpreter。'
      : '和项目设置保持一致，不要自己改成别的换行符。'
  return `## 文件格式\n新建或改写的文本文件统一用 ${enc}、换行符 ${eol}。${tip}\n已经有文件的编码和换行符不要批量转换，只改这次任务涉及的内容。`
}

/**
 * 同一个任务里各个节点（包括主 Agent、派出的子 Agent）都一样的开头：需求、工作流说明、通用要求。
 * 放在最前面，按前缀匹配缓存的模型服务（Codex 等）能多命中一段
 */
/**
 * 独立分支里的子对话（连同它的工作流节点）：编译、测试都在自己的分支目录里跑，验证通过后交给面板合回原分支。
 * 分支目录是新检出的，没有依赖和编译产物，不说的话 Agent 会以为环境坏了
 */
function buildPart(host: EngineHost) {
  // UE 项目的子对话不编译：「在分支里编译测试」那一段换成申请编译
  if (host.ueBuild) return uePart(host)
  if (!host.submitMerge) return ''
  return `## 在独立分支里验证，再请父对话收尾
编译、测试都在你这个独立分支的目录里跑，不用交给别人：合并就是验收，合进去的代码就算验收通过，所以能在你这里做的测试都在合并之前、在这里做完。
- 这个目录是新检出的，没有依赖和编译产物：第一次编译、测试前按项目的方式装好依赖（例如 npm ci），装出来的东西不要提交。
- 只剩合回时调用 submit_merge 请父对话收尾：计划其余步骤都做完、后台命令都结束、没有等回答的提问、按下面的「验证」跑通，tests 写上跑了哪些编译、测试和结果，handoff 按模板写交接要点（关键文件和模块必填，以后再交给你时上下文大就只带这份摘要，写清哪里的代码、哪些文档、做了什么决定）。面板把改动提交到你的分支，父对话合回原分支（父对话所在的分支）、把计划最后的收尾步骤标完成、结束这个子对话并删除独立分支。调用后结束这一轮。
- 验证没跑通不要调用，先修好；做完却不调用的，面板会提醒你。父对话合不进去（冲突）或者觉得验证不够时会退回给你，按它说的处理好再调用。合并结果推回来之前不说完成。不要推送这个分支（面板会拦下，git push 报 remote-agent-panel-no-push），也不要自己去原目录合并。`
}

/**
 * UE 项目的编译归父对话：UBT / UHT、Editor、DDC 是整台机器共用的，几个子对话各编各的只会互相抢锁、
 * 撑满机器。子对话只改代码、做不用编译的检查，编译向父对话申请；父对话也不随手编译，
 * 收到申请才向面板占位，面板按编译目录排队（同一目录同一时间只编译一次，各自 worktree 的目录互不占位）
 */
function uePart(host: EngineHost) {
  const ue = host.ueBuild
  if (!ue) return ''
  if (ue.role === 'parent')
    return `## UE 编译按申请占位执行
这是 UE 项目：编译只在父对话这一层发起，子对话不编译（上面说子对话自己编译测试的地方，在这个项目里都以这里为准）。你也不随手编译：
- 只在收到子对话的编译申请（消息里写着「编译申请」）或用户要求时，调用 request_build 向面板申请编译。几个申请先后到了就合成一次，note 写清为了哪些子对话、哪些改动，children 写上这些子对话的 id（结果面板会直接推给它们）。
- 编译是占位的资源：面板按编译目录排队，同一目录同一时间只编译一次。同一目录里别的父对话占着时，你的申请排在后面，面板会告诉你占着的是谁，也会告诉对方你在等；各自在独立 worktree 里的不互相占位。不要用 run_background 或直接执行 Build.bat、UBT、UHT、Editor 来绕过排队。
- 编译结果会推回给你，也直接推给 children 里的子对话：失败时它们自己修好再申请；报错落在没申请的子对话的改动上时，用 send_to_conversation 交给它。
- 同一项目里还有别的父对话时：用 list_peers 看它们在做什么、谁占着编译；要协调（例如你要等它的编译、它要改你这边也在改的公共文件）用 message_peer 传话，不要替它做决定。`
  return `## UE 编译交给父对话申请
这是 UE 项目：编译（Build.bat、UBT、UHT）、Cook、启动 Editor 都不在子对话里做，面板也会拦下这类后台命令。你只改代码，做不需要编译的检查（Lua 语法、静态检查、对照调用方自查），编译向父对话申请：
${
  host.submitMerge
    ? `- 你在独立分支里，这个目录编不了 UE（没有中间产物、大文件没检出）：检查完调用 submit_merge 请父对话收尾，tests 写上做了哪些检查，并写明「UE 编译交父对话」，handoff 按模板写交接要点；build 保持 true，父对话合回后在它的目录里编译。只改文档、注释、配置说明这类不影响编译的内容时 build 写 false。
- 合回去不等于编译通过：编译报错时会交回给你，修好后再 submit_merge 一次。`
    : `- 改完、检查完调用 request_build 向父对话申请编译，note 写清改了哪些模块和文件、需要编哪个目标；然后结束这一轮，编译结果面板会直接推给你。
- 编译报错就修好再申请一次；编译通过才算这次改动验证过。`
}
- 不要因为没编译就说做不完：你的完成标准是改动和检查都交代清楚、编译申请已经发出。`
}

/** 对话自己改代码时的验证范围：小改动跑快速检查就收尾，省掉完整测试的时间 */
function verifyPart(host: EngineHost) {
  const v = host.verify
  if (!v) return ''
  const block = verifyBlock(v.steps, {
    platform: v.platform,
    wslDistro: v.wslDistro,
    scaled: v.scaled,
    parentRun: v.parentRun,
    changedFiles: v.changedFiles,
  })
  // 收尾总结里的耗时统计：只对独立分支的子对话提，它才是写收尾总结的那个。
  // 项目配了测试步骤就要求（不限于范围为 parent 的）：它自己跑的那几步也有后台命令的真实耗时
  const timed = v.parentRun === 'child' && v.steps.some((x) => x.enabled)
  return timed
    ? `${block}

${TEST_TIME_SUMMARY_RULE}`
    : block
}

/** 要改文件时才开独立分支：不说清楚的话模型会直接在原目录里改，隔离就落空了 */
function editPart(host: EngineHost) {
  if (!host.beginEdit) return ''
  return `## 改文件前先开独立分支
这个对话设成了在独立分支里改文件，现在你还在原目录里：看代码、回答问题、跑只读的命令都可以直接做，但不要在这里改、新建或删除任何文件，也不要跑会写文件的命令。
- 确定要改文件时先调用 begin_edit，面板从当前目录开一个独立分支。
- 调用成功后用一两句写下已经查到的情况和打算怎么改，然后马上结束这一轮；面板会在独立分支的目录里开新会话，带上这段对话接着改。
- 只是回答问题、出方案时不用调用。`
}

/** 能用后台命令时说清楚什么时候用：不说的话模型照样同步跑长命令，一直卡着 */
function backgroundPart(host: EngineHost) {
  if (!host.runBackground) return ''
  return `## 长命令放到后台
预计超过一分钟的命令（完整测试、端到端测试、长时间的检查、编译）用 run_background 交给面板在后台跑，它马上返回，结果跑完会自动推回给你：
- 等结果的时候接着做不依赖它的事：读代码、写文档、改和这条命令无关的文件。不要改这条命令要检查的文件，改了结果就不算数（面板会标出期间被改过）。
- 编译、打包这类会抢文件锁的命令把 exclusive 设为 true，面板按项目排队，同一时间只跑一个。
- 面板一直盯着它直到真正结束：成功、失败、被停止、超过限时都会把结果推回来；十分钟没有任何输出、或者跑了很久（15 分钟起，之后间隔翻倍）也会提醒你看一眼。按命令正常要多久写 timeout_minutes（写宽一些），不写默认两小时。手上没有别的事时直接结束这一轮，对话会停在「等结果」，结果到了接着处理；不要反复调用 check_background 轮询，也不要用 sleep 干等。
- 结果推回来先核对用时和输出是不是合理；提醒你没输出时用 check_background 看一眼，确认卡住就用 stop_background 停掉、查清原因再重跑。
- 不要在前台用 sleep 等待（等 CI、等部署、等别的进程）：前台命令跑着时用户发来的消息要等它结束才能处理。要等就把等待和检查写成一条命令交给 run_background，或者直接结束这一轮、告诉用户你在等什么。
- 几秒就能跑完的命令照常直接执行。`
}

/**
 * 对话的执行计划：当前计划和维护规则。项目里的对话（父、子都有）每一轮都带上，
 * 计划的规则由面板在 set_plan 里兜底（完成的锁死、做完收起），这里讲清楚什么时候列、怎么更新、等待怎么挂
 */
function planPart(host: EngineHost, coordinator: boolean) {
  const { task } = host
  if (!task.projectId) return ''
  const kind = wrapKind(host)
  const cur = activePlan(task)
  const nowMs = Date.now()
  const now = cur ? `当前计划：\n${planText(task, cur)}` : '现在没有进行中的计划。'
  // ADR 0020：每轮都把「当前第几步、多久没更新、下一步」正面摆在前面；滞后 / 新输入没处理时再插一条提醒
  const check = [planNowText(task, nowMs), planNotice(task, nowMs)].filter(Boolean).join('\n')
  return `## 执行计划
${now}
${check ? `\n${check}\n` : ''}
- 需要好几步才能做完的事（改代码、排查问题、跨模块、要测试验证），分析梳理完先用 set_plan 列出计划再动手；一问一答、一两行的小改动不用列。
- 最多两层：主步骤写要交付的一件事，子步骤写这件事里的具体动作。步骤名写做什么，不写怎么想的。某个主步骤要按工作流执行时调用 start_plan 并带上它的 step，工作流的节点就是它的子步骤，不用自己写。
- **动手前先把这一步标成「进行中」**（set_plan 带它的 id + status），一份计划里同时只能有一个进行中；**做完立刻**在同一批动作里把它标完成、再把下一步标进行中。不要连着做完几步再一起更新，也不要在计划里还有进行中的步骤时去做别的步骤的事。
- 什么算完成一步：改完代码并且跑通这一步该跑的检查（这一步涉及多项时，跑完它该跑的那几项）；只是起了个子任务、跑完一条命令、写了一段说明，都不算完成。
- **要等结果的用「等待中」，不要用「进行中」**：调用 run_background${coordinator ? ' / create_conversation / send_to_conversation' : ''} 时带上 step，面板会把那一步标成等待中，你立刻接着做计划的下一步，不要干等或轮询。结果推回来时先处理那一步：成功面板会标完成，失败会标成「失败」并带上原因（需要你重做或明确跳过）。跑十几分钟的命令、等子对话时那一步本来就该是等待中。
- **新输入先判计划**：这一轮的输入带了新要求（用户新消息、父对话转达、子对话 / 后台结果里带了新任务）时，第一件事是判断现有计划要不要改——要改就立刻 set_plan 再动手；不改就用一句话说明为什么不变，再继续。
- **增量还是重开**：同一件事的细化、加一步、插一步、调顺序、改步骤名、作废某一步 → 用 set_plan 带已有步骤 id、partial: true 只交变更项（默认做法）；目标本身变了（换方向、需求被推翻、方案整体换掉）、剩下的步骤大部分作废、或者用户明确说「重新做 / 换个方案 / 别按刚才那个来」→ 先 finish_plan 结束这份计划，再用 set_plan 带新 title 开一份新的（旧计划和耗时留在「以前的计划」里）。只加内容却整份重开、或者换了方向还在旧计划上打补丁，都不行。
- 每次 set_plan 交整份列表时，已有的步骤带上 id；步骤一多（10 条以上）就分两批交：一批带上 partial 为 true 只写要变的步骤（带 id），其余没写到的步骤留在计划里不动，免得一次拼一大段 JSON 拼错。
- 完成的步骤不再重开：后来的内容哪怕和它完全一样，也新加一步去做。
- 用户中途加了内容：先判断它该放进计划的哪一步——属于还没完成的步骤就并进那一步（加子步骤），不属于就在合适的位置新加主步骤，然后按计划接着做。同一件事不要另开一份计划。
- 计划的步骤全部完成后调用 finish_plan 结束这份计划（不需要写总结）；之后再有新内容，用 set_plan 开一份新的计划（写 title）。这一轮该给用户的结论照常写——那是回复内容，不是计划总结。
${
  kind
    ? `- 计划的最后一步「${WRAP_UP[kind].title}」由面板加在最后，别删、别挪到前面，也不要自己再写一条重复的收尾步骤（见下面「收尾：计划的最后一步」）。
`
    : ''
}- 不要用 CLI 自带的待办 / 计划工具（TodoWrite、update_plan 这类）记计划，用 set_plan，用户在面板的计划窗口里看进度。${
    coordinator
      ? `
- 你是父对话：分析只做到判断这件事属于哪个模块、该交给哪个子对话为止，具体定位和修改交给子对话，把你查到的模块、文件和线索一起交过去。交给子对话的每件事是计划里的一个主步骤，带 step 挂成等待中；用户随时发来的新消息马上答复或分派，不要因为在等子对话让用户等。`
      : ''
  }`
}

function commonPart(host: EngineHost, w?: Workflow, chat = false) {
  const { original, extra } = userRequests(host.task)
  return [
    `## 用户需求\n${original}`,
    // 放在前面：同一个任务里各个节点提示词的开头都一样，按前缀匹配缓存的模型服务能多命中一段
    promptLangRules(),
    extra.length ? `## 用户的补充要求\n${extra.map((t) => `- ${t}`).join('\n')}` : '',
    w?.document.trim() ? `## 工作流说明\n${w.document.trim()}` : '',
    // 对话（含它派出的子任务）用不到共享状态：对话里跑过 start_plan 后 task.runs 会留着上一次运行，
    // 注入旧状态会让模型去调根本没注册的 read_state / write_state
    chat ? '' : statePart(host.task),
    policyPart(host),
    goalPart(host),
    rulesPart(host),
    searchPart(host),
    buildPart(host),
    fileFormatPart(host),
    `## 通用要求\n完成后用${promptLangWord()}简要总结：做了什么、改了哪些文件、有没有遗留问题。\n` +
      // 一次输出太长时，模型服务的连接容易中途断开，整个节点白做
      '写很长的文件时分几次写：先写开头一部分，再分段追加或编辑补上，每次不超过约 300 行；不要一次输出整个大文件。\n' +
      // 用户明确要求：所有命令静默跑。弹出来的窗口既把结果带走（对话拿不到输出），也打断用户手上的事
      '所有命令都在当前会话里静默执行，不要新开命令行或终端窗口（start、cmd /k、Start-Process、wt、open -a Terminal 这类），除非用户明确要求打开窗口。',
  ]
}

/**
 * 评审代码改动的子任务用的开头（ADR 0013）：只留需求、语言、用户补充、目标和必须遵守的规则。
 * 工作流说明、搜索排除、编译收尾、授权和文件格式都是写给动手的角色的，评审拿到只会去搜项目、跑检查
 */
function reviewCommonPart(host: EngineHost) {
  const { original, extra } = userRequests(host.task)
  return [
    `## 用户需求\n${original}`,
    promptLangRules(),
    extra.length ? `## 用户的补充要求\n${extra.map((t) => `- ${t}`).join('\n')}` : '',
    goalPart(host),
    rulesPart(host),
  ]
}

function unitPrompt(
  host: EngineHost,
  inv: Invocation,
  node: FlowNode,
  unit: NodeStep,
  step: TaskStep,
  input: string,
  start: string,
  deciding: boolean,
  multi: boolean,
) {
  const name = (id: string) => host.agents.find((a) => a.id === id)?.name ?? '主 Agent'
  const siblings = parallelTo(inv.flow, node.id)
  const reviewing = inv.slot === 'review'
  const target = (id: string) =>
    id === END ? '结束' : `「${inv.flow.nodes.find((n) => n.id === id)?.title || '未命名节点'}」`
  const branches = inv.flow.edges.filter((e) => e.from === node.id && e.when)
  const route = (w: 'pass' | 'fail') =>
    branches
      .filter((e) => e.when === w)
      .map((e) => target(e.to))
      .join('、')
  // 顺序按「越稳定越靠前」排：同一个任务里各个节点都一样的（需求、工作流说明、通用要求）放在最前面，
  // 节点自己的（标题、要做的事、上游结果）放在后面。按前缀匹配缓存的模型服务（Codex 等）这样能多命中一段
  return [
    ...commonPart(host, inv.workflow),
    `${NODE_PART}\n你正在执行工作流「${inv.workflow.name}」里流程「${flowLabel(inv.flow, inv.workflow)}」的节点：${multi ? `${node.title.trim() || step.title} · ` : ''}${step.title}` +
      (inv.owner
        ? `\n这个流程是节点「${inv.owner}」的${SLOT_PROMPT[inv.slot]}流程${reviewing ? `（第 ${inv.round} 轮验收）` : ''}。`
        : ''),
    unit.instructions.trim() ? `## 本${multi ? '步' : '节点'}要做的事\n${unit.instructions.trim()}` : '',
    start ? `## 开始流程的结果（作为本节点的初始资料）\n${start}` : '',
    input ? `## 输入\n${input}` : '',
    siblings.length
      ? `## 同时进行的节点\n下面这些节点可能和你同时执行，不要做它们的工作，也尽量不要改同一个文件：\n${siblings
          .map((s) => {
            const first = nodeSteps(s)[0]
            return `- ${s.title || '未命名节点'}（${first.kind === 'flow' ? '调用流程' : name(nodeAgent(inv.workflow, first.agentId))}）`
          })
          .join('\n')}`
      : '',
    `## 要求\n只完成本${multi ? '步' : '节点'}「${step.title}」，不要做其他${multi ? '步骤' : '节点'}的工作。`,
    reviewing ? `你在验收上面「输入」里的结果。逐条检查，不通过时列出必须修改的地方。最后${VERDICT_LINE.review}。` : '',
    deciding
      ? `## 结论\n后面的流程按你的结论走${route('pass') ? `：通过时接着做${route('pass')}` : ''}${route('fail') ? `；不通过时接着做${route('fail')}` : ''}。完成后最后${VERDICT_LINE.branch}。`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

/**
 * 上一轮同一个节点的 CLI 会话：验收流程第 N 轮接第 N-1 轮，流程节点返工（body.2、body.3…）接上一轮（第一轮是 body）。
 * 其他情况（第一轮、开始和结束流程）返回空
 */
function prevRoundSession(host: EngineHost, inv: Invocation, kind: NodeStep['kind'], nodeId: string, stepId?: string) {
  if (!inv.parentId || kind !== 'agent') return ''
  // 返工轮次从 2 开始编号，第一轮是 0（路径里不带轮次）
  const prev =
    inv.slot === 'review' && inv.round > 1
      ? inv.round - 1
      : inv.slot === 'body' && inv.round >= 2
        ? inv.round === 2
          ? 0
          : inv.round - 1
        : -1
  if (prev < 0) return ''
  const base = stepPath({ ...inv, round: prev }, nodeId)
  return host.task.sessions[stepId ? `${base}/step/${stepId}` : base] ?? ''
}

/** 续接上一轮会话时的提示：只交这一轮的输入，其余要求上一轮已经给过 */
function nextRoundPrompt(inv: Invocation, step: TaskStep, input: string) {
  const what =
    inv.slot === 'review'
      ? `这是第 ${inv.round} 轮验收：被验收的节点按上一轮的意见修改过了，下面是修改后的结果。请在上一轮检查的基础上重新逐条验收，确认上一轮提出的问题都已解决、没有引入新的问题。最后${VERDICT_LINE.review}。`
      : `上一轮的结果需要修改，下面是这一轮的输入。请在你上一轮工作的基础上继续完善本节点「${step.title}」，完成后同样简要总结。`
  return [what, input ? `## 输入\n${input}` : ''].filter(Boolean).join('\n\n')
}

/** 执行一个节点：有显式步骤时逐步串行，旧节点仍走原来的单执行者逻辑 */
async function runNode(
  host: EngineHost,
  inv: Invocation,
  node: FlowNode,
  index: number,
  outputs: Map<string, { title: string; text: string }>,
): Promise<FlowResult> {
  if (node.steps.length) return runNodeSteps(host, inv, node, index, outputs)
  return runNodeSingle(host, inv, node, index, outputs)
}

/** 执行一个单执行者节点（含开始、验收、结束入口） */
async function runNodeSingle(
  host: EngineHost,
  inv: Invocation,
  node: FlowNode,
  index: number,
  outputs: Map<string, { title: string; text: string }>,
): Promise<FlowResult> {
  const step = ensureStep(host, inv, node, index)
  if (step.status === 'done') return { ok: true, output: step.output }
  if (host.halted) return { ok: false, halted: true, error: '' }
  // 上次执行到一半被打断、CLI 会话还在：续接会话接着做，不从头再来
  const half = step.interrupted
  const resumeHalf = half && !!host.task.sessions[step.id] && node.kind === 'agent'
  step.interrupted = false
  if (!resumeHalf) {
    dropRerun(host, step)
    // 上一遍跑完了（不是被打断续接）这里又跑一遍：记成返工，重新执行时 rounds 会清零，不记就看不出来跑过两次
    if (!half && step.endedAt) step.reruns = (step.reruns ?? 0) + 1
    // 重新执行：耗时和等待从头算；续接时接着之前做的时间累加
    step.spentMs = 0
    step.waitMs = 0
  }
  step.status = 'running'
  step.startedAt = now()
  step.endedAt = ''
  step.verdict = ''
  step.rounds = 0
  host.changed(true)

  const ups = preds(inv.flow, node.id)
  const upstream = ups
    .filter((p) => p !== START)
    .map((p) => outputs.get(p))
    .filter(Boolean)
    .map((o) => `### ${o!.title}\n${o!.text || '（没有文字输出）'}`)
  // 节点开始前别的 Agent 发给它的消息（主 Agent 的指示、其他子 Agent 的传话）
  const mail = takeMail(host, step.id)
  const input = [
    ups.includes(START) && inv.input ? inv.input : '',
    upstream.length ? `上游节点的结果：\n\n${upstream.join('\n\n')}` : '',
    mail.length ? `## 收到的消息\n${mail.map((m) => `- ${m}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
  const sub = (ref: FlowRef | null, slot: TaskStep['slot'], round: number, subInput: string) =>
    runRef(host, inv, ref, { parentId: step.id, slot, round, input: subInput, owner: step.title })

  const fail = (r: Fail): FlowResult => {
    step.status = r.stopped || r.halted ? 'pending' : 'failed'
    // 被停止时已经做了一部分，记下来，继续执行时续接会话
    step.interrupted = !!r.stopped && !!host.task.sessions[step.id]
    if (r.stopped || r.halted) pauseStep(step)
    step.endedAt = now()
    // 错误写进出错的节点里，打开节点就能看到；外层节点和整个任务的结尾只提一句，不重复整段
    if (!r.stopped && !r.halted && !r.reported) {
      system(host, r.error || t('执行失败'), step.id, true)
      r = { ...r, reported: true }
    }
    host.changed(true)
    return r
  }

  // 开始流程
  let start = ''
  if (node.hooks.start) {
    const r = await sub(
      node.hooks.start,
      'start',
      0,
      [`节点「${step.title}」准备开始。`, node.instructions.trim(), input].filter(Boolean).join('\n\n'),
    )
    if (!r.ok)
      return fail({
        ...r,
        error: r.stopped ? r.error : t('「{title}」的开始流程失败：{error}', { title: step.title, error: r.error }),
      })
    start = r.output
  }

  // 预算：这一轮的花费或 token 超过工作流设定的上限就暂停，免得验收来回循环一直烧钱
  const over = overBudget(host)
  if (over) return fail({ ok: false, stopped: true, budget: true, error: over })

  // 后面有条件连线：按结论选路。有主 Agent 评估时由主 Agent 选，否则要求节点自己给出结论
  const branchy = inv.flow.edges.some((e) => e.from === node.id && e.when)
  const evaluates = mainEvaluates(inv, node, branchy)
  const deciding = node.kind === 'agent' && branchy && !evaluates
  const orch = makeOrchestra(host, { workflow: inv.workflow, main: inv.main, tier: node.tier }, step)

  // 节点本身；返工时 round 往上加（流程节点的返工按 round 区分子节点）
  let bodyRound = 1
  const body = async (round: number, extra: string): Promise<AgentResult> => {
    if (node.kind === 'flow') {
      const r = await sub(
        node.flow,
        'body',
        round,
        [input, start ? `开始流程的结果：\n${start}` : '', extra].filter(Boolean).join('\n\n'),
      )
      return r.ok ? { ok: true, text: r.output } : r
    }
    if (!step.agentId)
      return { ok: false, error: t('「{title}」没有可执行的角色，请先给工作流选择主角色', { title: step.title }) }
    const full = unitPrompt(
      host,
      inv,
      node,
      nodeSteps(node)[0],
      step,
      input,
      start,
      deciding && inv.slot !== 'review',
      false,
    )
    // 验收的第 2 轮起、流程节点返工的子节点：续接上一轮同一个节点的会话，只交这一轮的新输入。
    // 上一轮读过的代码、给过的意见都在会话里，整段历史能命中缓存；不续接的话每轮都从头读一遍
    const prev =
      round === 0 && !resumeHalf && !host.task.sessions[step.id] ? prevRoundSession(host, inv, node.kind, node.id) : ''
    if (prev) {
      host.task.sessions[step.id] = prev
      // 会话按目录存：借来的这条会话也要带上它原来是在哪个目录里开的，
      // 不然换了目录续接时会在 CLI 里撞「会话在别的项目里」（见 runner.ts 的 sessionMoved）
      const dirs = host.task.sessionDirs ?? {}
      const at = Object.entries(dirs).find(([k]) => host.task.sessions[k] === prev)?.[1]
      if (at) dirs[step.id] = at
    }
    const cont =
      round === 0 && resumeHalf
        ? `上次执行到一半被中断了（停止或面板重启）。请检查已经做了哪些，从中断的地方接着完成本节点「${step.title}」的工作，完成后同样简要总结。`
        : prev
          ? nextRoundPrompt(inv, step, input)
          : ''
    const tail = deciding && (extra || cont) ? `\n\n最后同样${VERDICT_LINE.branch}。` : ''
    const call = (prompt: string) =>
      host.runAgent({
        step,
        agentId: step.agentId,
        prompt,
        fresh: extra || cont ? [full, extra].filter(Boolean).join('\n\n') : undefined,
        sessionKey: step.id,
        reviewing: inv.slot === 'review',
        deciding,
        tier: node.tier,
        params: node.params,
        orch,
      })
    let r = await call((extra || cont || full) + tail)
    // 失败自动重试（CLI 断线、偶发错误）：续接同一个会话，让它检查做到哪了接着做
    for (let i = 0; i < node.retries && !r.ok && !r.stopped && !r.halted && !r.budget && !host.halted; i++) {
      system(
        host,
        t('「{title}」执行失败，自动重试（第 {n} 次）：{error}', {
          title: step.title,
          n: i + 1,
          error: clip(r.error, 300),
        }),
        step.id,
      )
      host.changed(true)
      r = await call(
        `上一次执行失败了：${clip(r.error, 1000)}\n\n请检查已经做了哪些，接着完成本节点「${step.title}」的工作，完成后同样简要总结。${tail}`,
      )
    }
    if (!r.ok) return r
    // 节点派出去的子 Agent 是它工作的一部分：等它们都结束；它自己没取回的结果并进节点的输出
    const late = await settleHelpers(host, step)
    return late ? { ok: true, text: `${r.text}\n\n## 子 Agent 的结果\n${late}` } : r
  }
  const rework = (agentText: string, flowText: string) => body(++bodyRound, node.kind === 'flow' ? flowText : agentText)
  let r = await body(0, '')
  if (!r.ok) return fail(r)
  let text = r.text

  // 验收：不通过就把意见交回节点，每次最多 maxRounds 轮；用户退回后重新验收，轮次接着编号
  let reviewRound = 0
  const review = async (): Promise<Fail | null> => {
    if (!node.hooks.review) return null
    for (let n = 1; ; n++) {
      const round = ++reviewRound
      const rv = await sub(
        node.hooks.review,
        'review',
        round,
        `被验收的节点：${step.title}\n\n## 这个节点要做的事\n${node.instructions.trim() || '（没有写）'}\n\n## 它的结果\n${text || '（没有文字输出）'}`,
      )
      if (!rv.ok)
        return {
          ...rv,
          error: rv.stopped
            ? rv.error
            : t('「{title}」的验收流程失败：{error}', { title: step.title, error: rv.error }),
        }
      const verdict = parseVerdict(rv.output)
      step.rounds = round
      step.verdict = verdict === 'fail' ? 'fail' : 'pass'
      if (!verdict)
        system(host, t('「{title}」的验收流程没有写「验收结论」，按通过处理。', { title: step.title }), step.id)
      host.changed(true)
      if (verdict !== 'fail') return null
      // 不通过、要带着意见重做这一轮：单独累加，重新执行节点时 rounds 会清零，从 rounds 反推会少算
      step.reviews = (step.reviews ?? 0) + 1
      if (host.halted) return { ok: false, halted: true, error: '' }
      if (n >= node.hooks.maxRounds)
        return {
          ok: false,
          error: t('「{title}」验收 {round} 轮仍未通过。最后一轮的意见：\n{feedback}', {
            title: step.title,
            round: n,
            feedback: clip(rv.output, 1500),
          }),
        }
      system(
        host,
        t('「{title}」第 {round} 轮验收未通过，已把意见交回节点继续完善。', { title: step.title, round }),
        step.id,
      )
      const again = overBudget(host)
      if (again) return { ok: false, stopped: true, budget: true, error: again }
      const fb = await rework(
        `验收没有通过（第 ${round} 轮）。验收意见：\n${rv.output}\n\n请按意见继续完善本节点「${step.title}」的工作，完成后同样简要总结。`,
        `上一轮的结果没有通过验收，意见：\n${rv.output}`,
      )
      if (!fb.ok) return fb
      text = fb.text
    }
  }

  for (;;) {
    const rf = await review()
    if (rf) return fail(rf)
    // 完成后等用户确认：通过就往下走；退回时带着意见返工，再验收、再确认
    if (!node.hooks.confirm || !host.confirm) break
    if (host.halted) return fail({ ok: false, halted: true, error: '' })
    const c = await host.confirm(step, text)
    if (!c) return fail({ ok: false, stopped: true, error: t('已停止') })
    if (c.allow) break
    const fb = await rework(
      `用户看了结果，要求修改：\n${c.answer || '（没有写具体意见）'}\n\n请按要求继续完善本节点「${step.title}」的工作，完成后同样简要总结。`,
      `用户看了上一轮的结果，要求修改：\n${c.answer || '（没有写具体意见）'}`,
    )
    if (!fb.ok) return fail(fb)
    text = fb.text
  }

  // 主 Agent 评估：通过（可以选分支、交代后续）、退回修改、委派另一个工作流、停下
  if (evaluates) {
    const main = inv.main!
    let reworks = 0
    let delegations = 0
    let extra = ''
    const agentName =
      node.kind === 'flow' ? t('调用流程') : (host.agents.find((a) => a.id === step.agentId)?.name ?? '')
    for (let n = 1; ; n++) {
      if (host.halted) return fail({ ok: false, halted: true, error: '' })
      const ev = await mainTurn(
        host,
        main,
        'evaluate',
        evaluateEvent({
          title: step.title,
          agent: agentName,
          instructions: node.instructions,
          result: clip(text, 8000),
          round: n,
          reworksLeft: node.hooks.maxRounds - reworks,
          branches: branchy
            ? { pass: branchTargets(inv, node, 'pass'), fail: branchTargets(inv, node, 'fail') }
            : undefined,
          extra,
        }),
      )
      if (!ev.ok)
        return fail(
          ev.stopped || ev.halted
            ? ev
            : { ...ev, error: t('主角色评估「{title}」失败：{error}', { title: step.title, error: ev.error }) },
        )
      let d: Dispatch | null = parseDispatch(ev.text)
      if (!d) {
        system(host, t('主角色没有写调度决定，「{title}」按通过处理。', { title: step.title }), step.id)
        d = { action: 'continue' }
      }
      // 退回次数用完、委派来回太多次：只能继续或停下
      if (d.action === 'rework' && reworks >= node.hooks.maxRounds)
        return fail({
          ok: false,
          error: t('主角色退回「{title}」{n} 次后仍不满意：{feedback}', {
            title: step.title,
            n: reworks,
            feedback: clip(d.feedback, 1500),
          }),
        })
      if (d.action === 'delegate' && (delegations >= MAX_DELEGATIONS || n > node.hooks.maxRounds + MAX_DELEGATIONS + 2))
        d = { action: 'continue' }
      system(host, dispatchText(d, step.title), step.id)
      host.changed(true)
      if (d.action === 'stop') return fail({ ok: false, error: dispatchText(d, step.title), reported: true })
      if (d.action === 'rework') {
        reworks++
        const fb = await rework(
          `主 Agent 评估后要求修改：\n${d.feedback || '（没有写具体意见）'}\n\n请按意见继续完善本节点「${step.title}」的工作，完成后同样简要总结。`,
          `主 Agent 评估上一轮的结果后要求修改：\n${d.feedback || '（没有写具体意见）'}`,
        )
        if (!fb.ok) return fail(fb)
        text = fb.text
        extra = ''
        continue
      }
      if (d.action === 'delegate') {
        const want = d.workflow
        const target = host.workflows.find((w) => w.id === want) ?? host.workflows.find((w) => w.name === want)
        if (!target || target.id === inv.workflow.id) {
          extra = `### 委派没有执行\n找不到可以委派的工作流「${want}」，请直接决定。`
          continue
        }
        delegations++
        const r = await sub(
          { kind: 'workflow', id: target.id },
          'call',
          delegations,
          [
            d.input || `处理和节点「${step.title}」相关的事`,
            `## 节点「${step.title}」的结果\n${clip(text, 6000)}`,
          ].join('\n\n'),
        )
        if (!r.ok)
          return fail({
            ...r,
            error: r.stopped
              ? r.error
              : t('「{title}」委派的工作流「{name}」失败：{error}', {
                  title: step.title,
                  name: target.name,
                  error: r.error,
                }),
          })
        extra = `### 委派给工作流「${target.name}」的结果\n${clip(r.output, 6000)}`
        continue
      }
      const ok = d.action === 'continue' ? d : undefined
      if (branchy) step.branch = ok?.branch ?? 'pass'
      if (ok?.note) text = `${text}\n\n主 Agent 的交代：${ok.note}`
      break
    }
  }

  // 条件连线按节点的结论选路；没写结论时按通过处理
  if (deciding) {
    const v = parseVerdict(text)
    step.branch = v === 'fail' ? 'fail' : 'pass'
    if (!v) system(host, t('「{title}」没有写「结论」，按通过处理。', { title: step.title }), step.id)
  }

  // 结束流程
  if (node.hooks.end) {
    if (host.halted) return fail({ ok: false, halted: true, error: '' })
    const e = await sub(
      node.hooks.end,
      'end',
      0,
      `节点「${step.title}」已完成，它的结果：\n${text || '（没有文字输出）'}`,
    )
    if (!e.ok)
      return fail({
        ...e,
        error: e.stopped ? e.error : t('「{title}」的结束流程失败：{error}', { title: step.title, error: e.error }),
      })
    if (e.output) text = `${text}\n\n结束流程的结果：\n${e.output}`
  }

  step.output = clip(text, MAX_OUTPUT)
  // 架构方案、测试的失败清单经常比交接上限长：完整内容存成文件，交给下游的结果里写明去哪读
  if (text.length > MAX_OUTPUT && host.saveHandoff) {
    const file = await host.saveHandoff(step, text).catch(() => '')
    if (file)
      step.output += `\n\n（完整结果有 ${text.length} 字，这里只附了开头。完整内容在文件 ${file}，开始之前请先读完。）`
  }
  step.status = 'done'
  step.endedAt = now()
  host.changed(true)
  return { ok: true, output: step.output }
}

/**
 * 执行一个多步骤节点：节点记录只做汇总，每一步一条 `slot=step` 记录和一个独立的会话，
 * 上一步的输出作为下一步的输入，任一步失败就停下
 */
async function runNodeSteps(
  host: EngineHost,
  inv: Invocation,
  node: FlowNode,
  index: number,
  outputs: Map<string, { title: string; text: string }>,
): Promise<FlowResult> {
  const step = ensureStep(host, inv, node, index)
  if (step.status === 'done') return { ok: true, output: step.output }
  if (host.halted) return { ok: false, halted: true, error: '' }
  // 被打断过：保留已完成的步骤，只续接没做完的；否则整个节点重跑
  const resume = step.interrupted
  step.interrupted = false
  if (!resume) {
    dropNodeSteps(host, step)
    // 同 runNodeSingle：上一遍跑完过又从头来一遍，记成返工
    if (step.endedAt) step.reruns = (step.reruns ?? 0) + 1
    step.spentMs = 0
    step.waitMs = 0
  }
  step.status = 'running'
  step.startedAt = now()
  step.endedAt = ''
  step.verdict = ''
  step.rounds = 0
  host.changed(true)

  const ups = preds(inv.flow, node.id)
  const upstream = ups
    .filter((p) => p !== START)
    .map((p) => outputs.get(p))
    .filter(Boolean)
    .map((o) => `### ${o!.title}\n${o!.text || '（没有文字输出）'}`)
  const mail = takeMail(host, step.id)
  const input = [
    ups.includes(START) && inv.input ? inv.input : '',
    upstream.length ? `上游节点的结果：\n\n${upstream.join('\n\n')}` : '',
    mail.length ? `## 收到的消息\n${mail.map((m) => `- ${m}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')

  const fail = (r: Fail, at?: TaskStep): FlowResult => {
    const target = at && at !== step ? at : undefined
    if (target) {
      target.status = r.stopped || r.halted ? 'pending' : 'failed'
      target.interrupted = !!r.stopped && !!host.task.sessions[target.id]
      if (r.stopped || r.halted) pauseStep(target)
      target.endedAt = now()
    }
    step.status = r.stopped || r.halted ? 'pending' : 'failed'
    // 被打断过的多步节点保留已完成的步骤，续跑时不重跑
    step.interrupted = !!r.stopped
    if (r.stopped || r.halted) pauseStep(step)
    step.endedAt = now()
    if (!r.stopped && !r.halted && !r.reported) {
      system(host, r.error || t('执行失败'), (target ?? step).id, true)
      r = { ...r, reported: true }
    }
    host.changed(true)
    return r
  }

  // 节点级开始流程：结果作为第一步的初始资料
  let start = ''
  if (node.hooks.start) {
    const r = await runRef(host, inv, node.hooks.start, {
      parentId: step.id,
      slot: 'start',
      round: 0,
      input: [`节点「${step.title}」准备开始。`, node.instructions.trim(), input].filter(Boolean).join('\n\n'),
      owner: step.title,
    })
    if (!r.ok)
      return fail({
        ...r,
        error: r.stopped ? r.error : t('「{title}」的开始流程失败：{error}', { title: step.title, error: r.error }),
      })
    start = r.output
  }

  const over = overBudget(host)
  if (over) return fail({ ok: false, stopped: true, budget: true, error: over })

  const units = node.steps
  const branchy = inv.flow.edges.some((e) => e.from === node.id && e.when)
  const evaluates = mainEvaluatesUnits(inv, units, branchy)
  const deciding = branchy && !evaluates && units[units.length - 1].kind === 'agent'

  const records: TaskStep[] = []
  const texts: string[] = []
  const halves: boolean[] = []
  const bodyRounds = units.map(() => 1)
  const recordOf = (i: number) => {
    records[i] ??= ensureUnitStep(host, inv, node, step, units[i], i)
    return records[i]
  }
  const prepare = (i: number): 'skip' | 'go' => {
    const unit = units[i]
    const r = recordOf(i)
    if (r.status === 'done') {
      texts[i] = r.output
      return 'skip'
    }
    const half = r.interrupted && !!host.task.sessions[r.id] && unit.kind === 'agent'
    halves[i] = half
    r.interrupted = false
    if (!half) {
      dropRerun(host, r)
      // 这一步上一遍跑完过又从头来：和节点级一样记成返工，验证步骤在节点内重跑才算得出来
      if (r.endedAt) r.reruns = (r.reruns ?? 0) + 1
      r.spentMs = 0
      r.waitMs = 0
    }
    r.status = 'running'
    r.startedAt = now()
    r.endedAt = ''
    r.verdict = ''
    r.rounds = 0
    r.output = ''
    host.changed(true)
    return 'go'
  }
  const body = async (i: number, round: number, extra: string): Promise<AgentResult> => {
    const unit = units[i]
    const r = recordOf(i)
    const before = i === 0 ? input : records[i - 1]?.output || texts[i - 1] || ''
    if (unit.kind === 'flow') {
      const res = await runRef(host, inv, unit.flow, {
        parentId: r.id,
        slot: 'body',
        round,
        input: [before, i === 0 && start ? `开始流程的结果：\n${start}` : '', extra].filter(Boolean).join('\n\n'),
        owner: r.title,
      })
      return res.ok ? { ok: true, text: res.output } : res
    }
    if (!r.agentId)
      return { ok: false, error: t('「{title}」没有可执行的角色，请先给工作流选择主角色', { title: r.title }) }
    const decidingHere = deciding && i === units.length - 1 && inv.slot !== 'review'
    const full = unitPrompt(host, inv, node, unit, r, before, i === 0 ? start : '', decidingHere, true)
    const prev =
      round === 0 && !halves[i] && !host.task.sessions[r.id]
        ? prevRoundSession(host, inv, unit.kind, node.id, unit.id)
        : ''
    if (prev) host.task.sessions[r.id] = prev
    const cont =
      round === 0 && halves[i]
        ? `上次执行到一半被中断了（停止或面板重启）。请检查已经做了哪些，从中断的地方接着完成这一步「${r.title}」的工作，完成后同样简要总结。`
        : prev
          ? nextRoundPrompt(inv, r, before)
          : ''
    const tail = decidingHere && (extra || cont) ? `\n\n最后同样${VERDICT_LINE.branch}。` : ''
    const call = (prompt: string) =>
      host.runAgent({
        step: r,
        agentId: r.agentId,
        prompt,
        fresh: extra || cont ? [full, extra].filter(Boolean).join('\n\n') : undefined,
        sessionKey: r.id,
        reviewing: inv.slot === 'review',
        deciding: decidingHere,
        tier: unit.tier,
        params: unit.params,
        orch: makeOrchestra(host, { workflow: inv.workflow, main: inv.main, tier: unit.tier }, r),
      })
    let res = await call((extra || cont || full) + tail)
    // 失败自动重试（CLI 断线、偶发错误）：续接这一步自己的会话
    for (let n = 0; n < unit.retries && !res.ok && !res.stopped && !res.halted && !res.budget && !host.halted; n++) {
      system(
        host,
        t('「{title}」执行失败，自动重试（第 {n} 次）：{error}', {
          title: r.title,
          n: n + 1,
          error: clip(res.error, 300),
        }),
        r.id,
      )
      host.changed(true)
      res = await call(
        `上一次执行失败了：${clip(res.error, 1000)}\n\n请检查已经做了哪些，接着完成这一步「${r.title}」的工作，完成后同样简要总结。${tail}`,
      )
    }
    if (!res.ok) return res
    const late = await settleHelpers(host, r)
    return late ? { ok: true, text: `${res.text}\n\n## 子 Agent 的结果\n${late}` } : res
  }

  const reworkText = (i: number, agentText: string, flowText: string) =>
    body(i, ++bodyRounds[i], units[i].kind === 'flow' ? flowText : agentText)

  /** 这一步的验收：不通过就带着意见重做这一步，轮次独立 */
  const reviewUnit = async (i: number): Promise<Fail | null> => {
    const unit = units[i]
    const r = recordOf(i)
    if (!unit.review) return null
    for (let n = 1; ; n++) {
      const round = ++r.rounds
      const rv = await runRef(host, inv, unit.review, {
        parentId: r.id,
        slot: 'review',
        round,
        input: `被验收的节点：${r.title}\n\n## 这一步要做的事\n${unit.instructions.trim() || '（没有写）'}\n\n## 它的结果\n${texts[i] || '（没有文字输出）'}`,
        owner: r.title,
      })
      if (!rv.ok)
        return {
          ...rv,
          error: rv.stopped ? rv.error : t('「{title}」的验收流程失败：{error}', { title: r.title, error: rv.error }),
        }
      const verdict = parseVerdict(rv.output)
      r.rounds = round
      r.verdict = verdict === 'fail' ? 'fail' : 'pass'
      if (!verdict) system(host, t('「{title}」的验收流程没有写「验收结论」，按通过处理。', { title: r.title }), r.id)
      host.changed(true)
      if (verdict !== 'fail') return null
      // 同 runNodeSingle：验收不通过要重做的次数单独累加
      r.reviews = (r.reviews ?? 0) + 1
      if (host.halted) return { ok: false, halted: true, error: '' }
      if (n >= unit.maxRounds)
        return {
          ok: false,
          error: t('「{title}」验收 {round} 轮仍未通过。最后一轮的意见：\n{feedback}', {
            title: r.title,
            round: n,
            feedback: clip(rv.output, 1500),
          }),
        }
      system(host, t('「{title}」第 {round} 轮验收未通过，已把意见交回节点继续完善。', { title: r.title, round }), r.id)
      const again = overBudget(host)
      if (again) return { ok: false, stopped: true, budget: true, error: again }
      const fb = await reworkText(
        i,
        `验收没有通过（第 ${round} 轮）。验收意见：\n${rv.output}\n\n请按意见继续完善这一步「${r.title}」的工作，完成后同样简要总结。`,
        `上一轮的结果没有通过验收，意见：\n${rv.output}`,
      )
      if (!fb.ok) return fb
      texts[i] = fb.text
    }
  }

  /** 这一步完成后等用户确认：退回时只重做这一步 */
  const confirmUnit = async (i: number): Promise<Fail | 'rework' | null> => {
    const unit = units[i]
    const r = recordOf(i)
    if (!unit.confirm || !host.confirm) return null
    if (host.halted) return { ok: false, halted: true, error: '' }
    const c = await host.confirm(r, texts[i])
    if (!c) return { ok: false, stopped: true, error: t('已停止') }
    if (c.allow) return null
    const fb = await reworkText(
      i,
      `用户看了结果，要求修改：\n${c.answer || '（没有写具体意见）'}\n\n请按要求继续完善这一步「${r.title}」的工作，完成后同样简要总结。`,
      `用户看了上一轮的结果，要求修改：\n${c.answer || '（没有写具体意见）'}`,
    )
    if (!fb.ok) return fb
    texts[i] = fb.text
    return 'rework'
  }
  // 按顺序执行；某一步失败或停止，后面的步骤不再启动
  for (let i = 0; i < units.length; i++) {
    if (prepare(i) === 'skip') continue
    if (host.halted) return fail({ ok: false, halted: true, error: '' }, recordOf(i))
    const b = overBudget(host)
    if (b) return fail({ ok: false, stopped: true, budget: true, error: b }, recordOf(i))
    const r = await body(i, 0, '')
    if (!r.ok) return fail(r, recordOf(i))
    texts[i] = r.text
    for (;;) {
      const rf = await reviewUnit(i)
      if (rf) return fail(rf, recordOf(i))
      const cf = await confirmUnit(i)
      if (cf && cf !== 'rework') return fail(cf, recordOf(i))
      if (cf === 'rework') continue
      break
    }
    const rec = recordOf(i)
    rec.output = await storeOutput(host, rec, texts[i])
    rec.status = 'done'
    rec.endedAt = now()
    host.changed(true)
  }

  const last = units.length - 1
  let text = texts[last] ?? ''

  // 主 Agent 评估：用最后一步的结果，退回时只重做最后一步
  if (evaluates) {
    const main = inv.main!
    let reworks = 0
    let delegations = 0
    let extra = ''
    const agentName =
      units[last].kind === 'flow'
        ? t('调用流程')
        : (host.agents.find((a) => a.id === recordOf(last).agentId)?.name ?? '')
    for (let n = 1; ; n++) {
      if (host.halted) return fail({ ok: false, halted: true, error: '' }, recordOf(last))
      const ev = await mainTurn(
        host,
        main,
        'evaluate',
        evaluateEvent({
          title: step.title,
          agent: agentName,
          instructions: units[last].instructions,
          result: clip(text, 8000),
          round: n,
          reworksLeft: units[last].maxRounds - reworks,
          branches: branchy
            ? { pass: branchTargets(inv, node, 'pass'), fail: branchTargets(inv, node, 'fail') }
            : undefined,
          extra,
        }),
      )
      if (!ev.ok)
        return fail(
          ev.stopped || ev.halted
            ? ev
            : { ...ev, error: t('主角色评估「{title}」失败：{error}', { title: step.title, error: ev.error }) },
          recordOf(last),
        )
      let d: Dispatch | null = parseDispatch(ev.text)
      if (!d) {
        system(host, t('主角色没有写调度决定，「{title}」按通过处理。', { title: step.title }), step.id)
        d = { action: 'continue' }
      }
      // 退回次数用完、委派来回太多次：只能继续或停下
      if (d.action === 'rework' && reworks >= units[last].maxRounds)
        return fail(
          {
            ok: false,
            error: t('主角色退回「{title}」{n} 次后仍不满意：{feedback}', {
              title: step.title,
              n: reworks,
              feedback: clip(d.feedback, 1500),
            }),
          },
          recordOf(last),
        )
      if (
        d.action === 'delegate' &&
        (delegations >= MAX_DELEGATIONS || n > units[last].maxRounds + MAX_DELEGATIONS + 2)
      )
        d = { action: 'continue' }
      system(host, dispatchText(d, step.title), step.id)
      host.changed(true)
      if (d.action === 'stop')
        return fail({ ok: false, error: dispatchText(d, step.title), reported: true }, recordOf(last))
      if (d.action === 'rework') {
        reworks++
        const fb = await reworkText(
          last,
          `主 Agent 评估后要求修改：\n${d.feedback || '（没有写具体意见）'}\n\n请按意见继续完善这一步「${step.title}」的工作，完成后同样简要总结。`,
          `主 Agent 评估上一轮的结果后要求修改：\n${d.feedback || '（没有写具体意见）'}`,
        )
        if (!fb.ok) return fail(fb, recordOf(last))
        texts[last] = fb.text
        text = fb.text
        const rec = recordOf(last)
        rec.output = await storeOutput(host, rec, fb.text)
        rec.status = 'done'
        rec.endedAt = now()
        extra = ''
        continue
      }
      if (d.action === 'delegate') {
        const want = d.workflow
        const target = host.workflows.find((w) => w.id === want) ?? host.workflows.find((w) => w.name === want)
        if (!target || target.id === inv.workflow.id) {
          extra = `### 委派没有执行\n找不到可以委派的工作流「${want}」，请直接决定。`
          continue
        }
        delegations++
        const r = await runRef(
          host,
          inv,
          { kind: 'workflow', id: target.id },
          {
            parentId: step.id,
            slot: 'call',
            round: delegations,
            input: [
              d.input || `处理和节点「${step.title}」相关的事`,
              `## 节点「${step.title}」的结果\n${clip(text, 6000)}`,
            ].join('\n\n'),
            owner: step.title,
          },
        )
        if (!r.ok)
          return fail(
            {
              ...r,
              error: r.stopped
                ? r.error
                : t('「{title}」委派的工作流「{name}」失败：{error}', {
                    title: step.title,
                    name: target.name,
                    error: r.error,
                  }),
            },
            recordOf(last),
          )
        extra = `### 委派给工作流「${target.name}」的结果\n${clip(r.output, 6000)}`
        continue
      }
      const ok = d.action === 'continue' ? d : undefined
      if (branchy) step.branch = ok?.branch ?? 'pass'
      if (ok?.note) text = `${text}\n\n主 Agent 的交代：${ok.note}`
      break
    }
  }

  // 条件连线按节点的结论选路；没写结论时按通过处理
  if (deciding) {
    const v = parseVerdict(text)
    step.branch = v === 'fail' ? 'fail' : 'pass'
    if (!v) system(host, t('「{title}」没有写「结论」，按通过处理。', { title: step.title }), step.id)
  }

  // 结束流程接收最后一步的输出
  if (node.hooks.end) {
    if (host.halted) return fail({ ok: false, halted: true, error: '' })
    const e = await runRef(host, inv, node.hooks.end, {
      parentId: step.id,
      slot: 'end',
      round: 0,
      input: `节点「${step.title}」已完成，它的结果：\n${text || '（没有文字输出）'}`,
      owner: step.title,
    })
    if (!e.ok)
      return fail({
        ...e,
        error: e.stopped ? e.error : t('「{title}」的结束流程失败：{error}', { title: step.title, error: e.error }),
      })
    if (e.output) text = `${text}\n\n结束流程的结果：\n${e.output}`
  }

  step.output = await storeOutput(host, step, text)
  step.status = 'done'
  step.endedAt = now()
  host.changed(true)
  return { ok: true, output: step.output }
}

/** 执行引用的流程 */
async function runRef(
  host: EngineHost,
  from: Invocation,
  ref: FlowRef | null,
  o: Pick<Invocation, 'parentId' | 'slot' | 'round' | 'input' | 'owner'>,
): Promise<FlowResult> {
  const target = resolveRef(ref, from.workflow, host.workflows)
  if (!target) return { ok: false, error: t('引用的流程不存在，可能已被删除') }
  if (from.depth >= MAX_DEPTH)
    return { ok: false, error: t('流程嵌套超过 {max} 层，请检查是否循环引用', { max: MAX_DEPTH }) }
  const inv: Invocation = {
    ...o,
    workflow: target.workflow,
    flow: target.flow,
    depth: from.depth + 1,
    run: from.run,
    main: from.main,
  }
  if (target.workflow.id === from.workflow.id) return runFlow(host, inv)
  // 另一个工作流：流程节点调用它、主 Agent 委派给它时，它有自己的主 Agent（挂在发起的节点下面）。
  // 开始 / 验收 / 结束入口只要它的结果（验收要的是「验收结论」），不另开主 Agent
  inv.main =
    (o.slot === 'body' || o.slot === 'call') && dispatches(target.workflow, target.flow)
      ? openMain(host, inv)
      : undefined
  return runInvocation(host, inv)
}

// ---- 主 Agent 调度 ----

/** 一个工作流的一次执行最多委派几次 */
const MAX_DELEGATIONS = 2

/**
 * 这个节点完成后要不要交给主 Agent 评估：子 Agent 做的节点、调用另一个工作流的节点、后面有条件连线的节点。
 * 主 Agent 自己做的节点不再评估自己；验收、开始、结束入口里的节点属于发起节点的验证，也不评估；
 * 带验收流程、完成后等用户确认的节点已经有人把关，也不评估（有条件连线时仍由主 Agent 选路）
 */
function mainEvaluates(inv: Invocation, node: FlowNode, branchy: boolean) {
  if (!inv.main || inv.main.workflow.id !== inv.workflow.id) return false
  if (inv.slot !== '' && inv.slot !== 'body' && inv.slot !== 'call') return false
  if (branchy) return true
  // 已经有验收流程把过关、或者你亲自确认过的节点，主 Agent 不再评估一遍：省一轮，也不和验收意见打架
  if (node.hooks.review || node.hooks.confirm) return false
  if (node.kind === 'flow') return node.flow?.kind === 'workflow'
  return nodeAgent(inv.workflow, node.agentId) !== inv.workflow.mainAgentId
}

/** 多步节点要不要交给主 Agent 评估：任何一步配了验收 / 确认就不再重复评估 */
function mainEvaluatesUnits(inv: Invocation, units: NodeStep[], branchy: boolean) {
  if (!inv.main || inv.main.workflow.id !== inv.workflow.id) return false
  if (inv.slot !== '' && inv.slot !== 'body' && inv.slot !== 'call') return false
  if (branchy) return true
  if (units.some((u) => u.review || u.confirm)) return false
  const last = units[units.length - 1]
  if (last.kind === 'flow') return last.flow?.kind === 'workflow'
  return nodeAgent(inv.workflow, last.agentId) !== inv.workflow.mainAgentId
}

/** 条件连线通向的节点名：「A」、「B」 */
function branchTargets(inv: Invocation, node: FlowNode, when: 'pass' | 'fail') {
  return inv.flow.edges
    .filter((e) => e.from === node.id && e.when === when)
    .map((e) => (e.to === END ? '结束' : `「${inv.flow.nodes.find((n) => n.id === e.to)?.title || '未命名节点'}」`))
    .join('、')
}

/** 这次执行的主 Agent 节点：常驻编排器（`@main`），一个对话只有一个，历次运行都用它 */
function openMain(host: EngineHost, inv: Omit<Invocation, 'main'>): MainCtl {
  const id = inv.parentId ? stepPath(inv as Invocation, MAIN_STEP) : MAIN_STEP
  let step = host.task.steps.find((s) => s.id === id)
  if (!step) {
    step = blankStep({
      id,
      parentId: inv.parentId,
      slot: inv.parentId ? inv.slot : '',
      round: inv.round,
      workflowId: inv.workflow.id,
      flowId: inv.flow.id,
      kind: 'main',
      title: inv.parentId ? t('主角色 · {name}', { name: inv.workflow.name }) : t('主角色'),
      agentId: inv.workflow.mainAgentId,
    })
    host.task.steps.push(step)
  }
  // 常驻：不因为一轮调度结束就标成完成，下一条要求回来还是它
  step.status = 'running'
  step.interrupted = false
  if (!step.startedAt) step.startedAt = now()
  step.endedAt = ''
  return { step, workflow: inv.workflow, flow: inv.flow, chain: Promise.resolve(), nested: !!inv.parentId }
}

/** 主 Agent 第一轮（或会话续不上时）的完整提示：共用的开头 + 它的职责和流程概览 */
function mainFull(host: EngineHost, main: MainCtl) {
  const others = host.workflows.filter((w) => w.id !== main.workflow.id && w.id !== DEFAULT_WORKFLOW_ID)
  return [
    ...commonPart(host, main.workflow),
    `${NODE_PART}\n${mainDuties(main.workflow, main.flow, host.agents, others)}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

/**
 * 主 Agent 的一轮调度：续接它的会话只交这次的事件（评估、汇总、回答提问），第一轮带上完整提示。
 * 同一个会话不能同时跑两轮，按到达顺序排队
 */
function mainTurn(
  host: EngineHost,
  main: MainCtl,
  kind: NonNullable<AgentCall['dispatching']>,
  event: string,
): Promise<AgentResult> {
  const go = async (): Promise<AgentResult> => {
    if (host.halted && kind !== 'answer') return { ok: false, halted: true, error: '' }
    const mail = takeMail(host, main.step.id)
    const ev = mail.length ? `${event}\n\n## 收到的消息\n${mail.map((m) => `- ${m}`).join('\n')}` : event
    const full = `${mainFull(host, main)}\n\n${ev}`
    const resumed = !!host.task.sessions[main.step.id]
    main.step.rounds++
    host.changed(true)
    return host.runAgent({
      step: main.step,
      agentId: main.step.agentId,
      prompt: resumed ? ev : full,
      fresh: resumed ? full : undefined,
      sessionKey: main.step.id,
      tier: main.workflow.mainTier ?? '',
      dispatching: kind,
      orch: makeOrchestra(host, { workflow: main.workflow, main, tier: main.workflow.mainTier ?? '' }, main.step),
    })
  }
  const p = main.chain.then(go, go)
  main.chain = p.catch(() => undefined)
  return p
}

/** 执行一个带主 Agent 的流程：节点都完成后由主 Agent 整理结果，作为这个流程的输出 */
async function runInvocation(host: EngineHost, inv: Invocation): Promise<FlowResult> {
  const main = inv.main
  const r = await runFlow(host, inv)
  if (!main) return r
  if (!r.ok) {
    if (!r.stopped && !r.halted) {
      main.step.status = 'failed'
      main.step.endedAt = now()
    }
    return r
  }
  // 这一轮已经整理过了（例如主 Agent 自己起停的运行）
  if (main.step.status === 'done') return { ok: true, output: main.step.output }
  const results = topoOrder(inv.flow)
    .map((n) => host.task.steps.find((s) => s.id === stepPath(inv, n.id)))
    .filter((s): s is TaskStep => s?.status === 'done')
    .map((s) => ({ title: s.title, text: s.output }))
  const s = await mainTurn(host, main, 'summary', summaryEvent(results, main.nested))
  if (!s.ok) {
    if (s.stopped || s.halted) return s
    const error = t('主角色整理结果失败：{error}', { error: s.error })
    main.step.status = 'failed'
    main.step.endedAt = now()
    system(host, error, main.step.id, true)
    host.changed(true)
    return { ok: false, error, reported: true }
  }
  const text = stripDispatch(s.text).trim() || r.output
  main.step.output = clip(text, MAX_OUTPUT)
  // 最外层的编排器常驻：这一轮只是把结果整理给用户，不结束它，下一条要求回来还是同一个会话；
  // 嵌套的（委派给另一个工作流）属于那次调用，照常结束
  if (main.nested) {
    main.step.status = 'done'
    main.step.endedAt = now()
  } else main.step.status = 'running'
  host.changed(true)
  return { ok: true, output: main.step.output }
}

// ---- 编排工具：派子 Agent、查状态、提问、传话 ----

/** 同时在跑的派出的子 Agent 最多几个（整个任务），多的排队 */
const MAX_HELPERS_RUNNING = 6
/** 一个节点最多派几个子 Agent */
const MAX_HELPERS_PER_STEP = 12
/** resume 对不上时报错里列出的最近子任务数：够模型认出正确 id，多了反而是干扰 */
const MAX_RESUME_IDS = 8

/** resume 报错里列子任务的写法：和终止子任务的列表（stop_helpers）同一写法 */
const helperLabel = (s: TaskStep) => `${s.id}｜${s.title}`

/**
 * resume 该接着哪条子任务：先按全等找，再按 id 的路径段结尾找。
 * 模型常把「a/step/s1/sub/h1」写成「sub/h1」，只按全等比就整批被拒、重试一次白花一轮；
 * 结尾必须落在「/」上，「xsub/h1」也算不上；能对上多条时不猜，交给调用方报候选。
 */
const resumeTarget = (mine: TaskStep[], id: string) => {
  const exact = mine.find((s) => s.id === id)
  const picked = exact ? [exact] : mine.filter((s) => s.id.endsWith(`/${id}`))
  return { prev: picked.length === 1 ? picked[0] : undefined, picked }
}

interface OrchState {
  /** 节点 id → 还没读的消息 */
  mail: Map<string, string[]>
  /** 子 Agent 的节点 id → 执行它的 Promise */
  helpers: Map<string, Promise<void>>
  /** 子 Agent 失败的原因 */
  errors: Map<string, string>
  /** 结果已经交回给派它的节点的子 Agent */
  delivered: Set<string>
  /** 对话 / 节点 id → 正在等的这一批子任务 */
  batches: Map<string, Promise<HelperBatch>>
  running: number
  queue: (() => void)[]
}
const orchStates = new WeakMap<EngineHost, OrchState>()

/**
 * 正在跑、在排队的子任务：任务 id + 子任务 id → 终止它用的开关。
 * 界面上的终止按钮（服务端的路由）和对话的 stop_subtask 工具都走 stopHelper，只停这一个，不动对话本身
 */
const helperStops = new Map<string, AbortController>()
const helperKey = (taskId: string, stepId: string) => `${taskId}\n${stepId}`

/** 终止一个子任务：还在跑就结束它的 CLI，还在排队就不再开始。why 写进交回给对话的结果；没找到返回 false */
export function stopHelper(taskId: string, stepId: string, why: string) {
  const ac = helperStops.get(helperKey(taskId, stepId))
  if (!ac || ac.signal.aborted) return false
  ac.abort(why)
  return true
}
/** 这个对话已经 use_capability 加载过的能力（按调用者 + 能力 + 参数）：重复加载只回一句，不再整段返回 */
const loadedCaps = new WeakMap<EngineHost, Set<string>>()

function orchState(host: EngineHost): OrchState {
  let st = orchStates.get(host)
  if (!st) {
    st = {
      mail: new Map(),
      helpers: new Map(),
      errors: new Map(),
      delivered: new Set(),
      batches: new Map(),
      running: 0,
      queue: [],
    }
    orchStates.set(host, st)
  }
  return st
}

/** 取走发给这个节点的消息：新架构从运行记录里取，旧任务用内存信箱 */
function takeMail(host: EngineHost, id: string) {
  const st = orchState(host)
  const got = st.mail.get(id) ?? []
  st.mail.delete(id)
  return [...got, ...runMail(host, id)]
}
function putMail(host: EngineHost, id: string, text: string) {
  // 新架构每次运行有自己的记录：写进去，重启后还在，界面上也能看到
  if (sendRunMessage(host, '', id, text)) return
  const st = orchState(host)
  st.mail.set(id, [...(st.mail.get(id) ?? []), text])
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const STATUS_TEXT: Record<string, string> = {
  pending: '待执行',
  running: '执行中',
  done: '完成',
  failed: '失败',
  skipped: '跳过',
}

function helperReport(host: EngineHost, s: TaskStep): HelperReport {
  const st = orchState(host)
  return {
    id: s.id,
    title: s.title,
    status: s.status,
    ...(s.status === 'done' ? { output: s.output } : {}),
    ...(st.errors.get(s.id) ? { error: st.errors.get(s.id) } : {}),
  }
}

const REVIEW_SOFT_LIMIT_MS = REVIEW_SOFT_LIMIT_MIN * 60_000
const REVIEW_WRAP_NOTE = `【面板提醒】评审已经进行了 ${REVIEW_SOFT_LIMIT_MIN} 分钟：停止再读代码，按目前已确认的意见马上交卷（第一行验收结论、第二行必须处置）；没来得及确认的标「可能」，没看完的文件单列「没看完」。`

/** 这个角色是不是在评审代码改动（必备角色「评审」、评审对象是代码改动）；评审方案或结论的不算 */
function reviewsCode(agent: Agent | undefined) {
  if (agent?.origin !== 'builtin:reviewer') return false
  const target = agent.params.find((p) => p.key === 'target')?.default
  return !target || target === '代码改动'
}

/** 派评审代码时交接单缺了必填的，返回要补什么；不缺返回空 */
function briefMissing(spec: HelperSpec) {
  const b = spec.review
  const lack = [!b?.goal?.trim() && 'goal（需求和验收标准）', !b?.checks?.trim() && 'checks（跑过的检查：命令 + 结果）']
  return lack.filter(Boolean).join('、')
}

/** 交接单写进评审的提示词：对话整理好的就是评审要用的全部背景 */
function briefPart(b: ReviewBrief | undefined) {
  if (!b) return ''
  const rows = [
    ['要达成什么、验收标准', b.goal],
    ['改了什么、为什么', b.changes],
    ['已经跑过的检查', b.checks],
    ['重点看', b.focus],
    ['差异里看不到的背景', b.context],
  ].filter((r): r is [string, string] => !!r[1]?.trim())
  if (!rows.length) return ''
  return `## 评审交接单（派你的对话整理）\n这就是评审要用的背景，不用再去读模块文档、搜项目还原它们。\n\n${rows.map(([k, v]) => `### ${k}\n${v.trim()}`).join('\n\n')}`
}

/**
 * 派的是「评审」时，面板把要评审的改动一次带进提示词（ADR 0010、0013）：接着上一轮评审的会话就只带那之后的增量；
 * 交接单写了 files 的只取那几个文件。读不到（不是 git 仓库、git 出错）时不带，评审照它的角色设定自己取 diff
 */
async function reviewPart(host: EngineHost, step: TaskStep, spec: HelperSpec) {
  const agent = host.agents.find((a) => a.id === step.agentId)
  if (agent?.origin !== 'builtin:reviewer') return ''
  const brief = briefPart(spec.review)
  if (!host.reviewDiff) return brief
  const key = step.session || ''
  const prev = key
    ? host.task.steps.filter((s) => s !== step && (s.session || s.id) === key && s.snapshot).at(-1)
    : undefined
  const files = (spec.review?.files ?? []).map((f) => f.trim()).filter(Boolean)
  const d = await host.reviewDiff(prev?.snapshot, files.length ? files : undefined).catch(() => null)
  if (!d) return brief
  step.snapshot = d.snapshot
  const what = prev ? '上一轮评审之后的增量' : '这次的全部改动（和任务开始时比）'
  if (!d.stat) return [brief, `## 要评审的改动\n${what}：没有改动。`].filter(Boolean).join('\n\n')
  const body = d.diff
    ? `\`\`\`diff\n${d.diff}\n\`\`\``
    : d.file
      ? `差异太长，没有放进来：完整差异在文件 ${d.file}，先读它。`
      : '差异太长，没有放进来：按上面的文件列表自己取 diff。'
  const part = `## 要评审的改动\n面板已经取好了${what}，不用再自己 git diff。每处改动前后带几行没改的代码，只是帮你看懂改动接在哪里：**只评以 + / - 开头的行**，上下文里没改的代码不评。锁文件、压缩产物这类生成的文件只在列表里，不用评。\n\n改动文件：\n\`\`\`\n${d.stat}\n\`\`\`\n\n${body}`
  return [brief, part].filter(Boolean).join('\n\n')
}

/** 子任务真的结束了（不是还在排队或跑着）：状态定了，或者还没开工但已经没在跑 */
function helperOver(host: EngineHost, k: TaskStep) {
  const st = orchState(host)
  return k.status !== 'running' && (k.status !== 'pending' || !st.helpers.has(k.id))
}

/**
 * 子任务都结束了：把计划里等它们的那一步收口（kind: 'helper'，见 spawn 的 step）。
 * 成功标完成、失败或终止退回进行中并写清原因；子任务还没结束的不动它。
 *
 * 按「计划里还挂着的 helper 等待」遍历，不只看这一批刚交回的子任务：模型在老会话里调过 wait_agents 时，
 * 那些子任务已经被取走（delivered 已 set），这一批就轮不到它们——点名的那一步会永远停在等待中
 */
export function settleHelperWaits(host: EngineHost) {
  const { task } = host
  // 只看在用的这份计划：settleWait 也按 activePlan 找步骤，旧计划里残留的等待项永远收不了口，
  // 每次交回结果都把那些死项重扫一遍没意义
  const plan = activePlan(task)
  const waiting = new Set(
    (plan?.steps ?? []).flatMap((s) => [s, ...s.children]).flatMap((x) => x.waits.filter((w) => w.kind === 'helper')),
  )
  const hit: { title: string; done: boolean }[] = []
  // 集合已经按 kind === 'helper' 筛过，这里只看还没收口的
  for (const w of waiting)
    if (w.state === 'waiting') {
      const kid = task.steps.find((s) => s.id === w.ref)
      if (kid && helperOver(host, kid)) hit.push(...settleWait(task, 'helper', w.ref, kid.status === 'done'))
    }
  if (hit.length) host.changed(true)
  return hit
}

/** 子任务没做完时交回结果里带的一句：重试要在原来的子任务里接着做，不另派一个 */
const RETRY_HINT = (id: string) =>
  `（要重试就调用 spawn_agents，resume 写「${id}」：在原来这个子任务里接着做，不要另派一个新的）`

/** 节点结束前等它派出的子 Agent 都结束，返回它没取回的结果（并进节点的输出） */
async function settleHelpers(host: EngineHost, step: TaskStep) {
  const st = orchState(host)
  const kids = () => host.task.steps.filter((s) => s.parentId === step.id && s.slot === 'sub')
  // 等的这段时间里对话可能又派了几个（用户插进来聊的那一轮）：它们算进同一批，一起交回
  for (let n = -1; n !== kids().length; ) {
    n = kids().length
    await Promise.all(kids().map((k) => st.helpers.get(k.id) ?? Promise.resolve()))
  }
  const late = kids().filter((k) => !st.delivered.has(k.id) && st.helpers.has(k.id))
  for (const k of late) st.delivered.add(k.id)
  // 计划里等这些子任务的步骤跟着收口：成功标完成，失败/被终止退回进行中
  settleHelperWaits(host)
  return late
    .map((k) =>
      k.status === 'done'
        ? `### ${k.title}\n${k.output || '（没有文字输出）'}`
        : (k.status === 'skipped' && st.errors.get(k.id)
            ? `### ${k.title}\n（${clip(st.errors.get(k.id)!, 300)}）`
            : `### ${k.title}\n（${STATUS_TEXT[k.status] ?? k.status}${st.errors.get(k.id) ? `：${clip(st.errors.get(k.id)!, 300)}` : ''}）`) +
          `\n${RETRY_HINT(k.id)}`,
    )
    .join('\n\n')
}

/** 任务里各个 Agent 的状态，按层级缩进，给 get_status 用 */
function statusTree(host: EngineHost, self: string) {
  const { task } = host
  const name = (id: string) => host.agents.find((a) => a.id === id)?.name ?? ''
  const lines: string[] = []
  const ids = new Set(task.steps.map((s) => s.id))
  // 对话里派的子 Agent 挂在 @chat 下，@chat 自己不是 steps 里的一条：父节点不在的步骤也当作顶层列出来，
  // 否则对话里派出的子 Agent 一个都查不到（get_status 显示「还没有节点」）
  const roots = task.steps.filter((s) => !s.parentId || !ids.has(s.parentId))
  const kidsOf = (pid: string) => task.steps.filter((s) => s.parentId === pid)
  const walk = (list: TaskStep[], depth: number) => {
    // 主 Agent 排在它调度的节点前面
    for (const s of [...list].sort((a, b) => Number(isMainStep(b)) - Number(isMainStep(a)))) {
      if (lines.length >= 80) return
      const label = s.parentId && !isMainStep(s) ? `${SLOT_PROMPT[s.slot] ?? ''} · ${s.title}` : s.title
      const who = name(s.agentId)
      const out = s.status === 'done' && s.output ? `：${clip(s.output.replace(/\s+/g, ' '), 100)}` : ''
      lines.push(
        `${'  '.repeat(depth)}- ${s.id}｜${label}${who ? `（${who}）` : ''}${s.id === self ? '【你】' : ''}：${STATUS_TEXT[s.status] ?? s.status}${out}`,
      )
      walk(kidsOf(s.id), depth + 1)
    }
  }
  walk(roots, 0)
  return lines.join('\n') || '（还没有节点）'
}

/**
 * 编排器通过 run_workflow 工具要求的运行：工具调用不能在里面直接跑整个流程（会和当前这一轮套在一起），
 * 先记下来，等这一轮结束、回到引擎的主循环时再起
 */
const pendingRuns = new WeakMap<EngineHost, string[]>()

function askRun(host: EngineHost, input: string) {
  pendingRuns.set(host, [...(pendingRuns.get(host) ?? []), input])
}

function takePendingRun(host: EngineHost) {
  const list = pendingRuns.get(host)
  if (!list?.length) return ''
  pendingRuns.delete(host)
  return list.join('\n\n')
}

/** 对话 Agent 要求的计划运行：工具调用只记下来，等这一轮 CLI 结束后由引擎同步跑完再继续对话 */
interface PlannedRun {
  workflowId: string
  input: string
  /** 计划里的哪个主步骤；空表示在计划末尾加一步 */
  step?: string
}
const pendingPlans = new WeakMap<EngineHost, PlannedRun[]>()

function askPlan(host: EngineHost, plan: PlannedRun) {
  pendingPlans.set(host, [...(pendingPlans.get(host) ?? []), plan])
}

function takePendingPlans(host: EngineHost) {
  const list = pendingPlans.get(host)
  pendingPlans.delete(host)
  return list ?? []
}

/** 编排工具，绑定在调用它的节点上（主 Agent 的调度轮也有一份） */
function makeOrchestra(
  host: EngineHost,
  ctx: {
    workflow?: Workflow
    main?: MainCtl
    tier: NodeTier
    chat?: boolean
    planning?: boolean
    coordinator?: boolean
    /** 调用者是派出去的子任务：只做并行的收集、核实、出计划，不能再往外派 */
    helper?: boolean
  },
  self: TaskStep,
): Orchestra {
  const st = orchState(host)
  const { task } = host
  const helper = !!ctx.helper
  // 调用者自己的角色：挂了哪些能力、能不能就地改动都看它（节点、子任务用的是基本角色，没有挂载）
  const selfAgent = self.agentId ? host.agents.find((a) => a.id === self.agentId) : undefined
  // 能力由 Agent 配置决定：canPlan 才能启动计划，canDelegate 才能分派子对话。
  // 旧的常驻编排器（@main）还能看到，但它们不会出现在新对话里。子任务一样都没有
  const planner = !helper && (!!ctx.planning || (isMainStep(self) && !self.parentId))
  const coordinator = !helper && !!ctx.coordinator
  // 对话的工具调用不属于任何节点：系统消息不挂 step，免得被当成一次运行的节点输出
  const where = self.id === CHAT_STEP ? '' : self.id
  const findStep = (key: string) => {
    const k = key.trim()
    if (/^(main|@main|主 ?Agent)$/i.test(k)) return ctx.main?.step
    return (
      task.steps.find((s) => s.id === k) ??
      task.steps.find((s) => s.title === k && s.status === 'running') ??
      task.steps.find((s) => s.title === k)
    )
  }
  return {
    self: self.id,
    hasMain: !!ctx.main,
    planner,
    common: commonAgents(host.agents)
      .filter((a) => a.id !== self.agentId && !(host.submitMerge && a.origin === VCS_ORIGIN))
      .map((a) => ({ name: a.name, description: a.description })),
    helper,
    autoReturn: !!ctx.chat && !helper,
    // 对话（含它派出的子任务）用不到共享状态：对话里跑过 start_plan 之后 task.runs 会残留上一次运行，
    // 只看 runs 会把工具又注册回来，读到的还是上一次运行的 state
    sharedState: !ctx.chat && !!runRecord(task),
    helperBatch() {
      const going = st.batches.get(self.id)
      if (going) return going
      const kids = () => task.steps.filter((s) => s.parentId === self.id && s.slot === 'sub')
      if (!kids().some((k) => !st.delivered.has(k.id) && st.helpers.has(k.id))) return undefined
      const batch = settleHelpers(host, self).then((late): HelperBatch => {
        st.batches.delete(self.id)
        if (late) {
          // 交回的结果记成面板消息：对话里显示成 AI 回复里的一行，不当作用户说的话
          task.messages.push({
            id: host.newId(),
            role: 'system',
            agentId: '',
            step: where,
            text: late,
            tools: [],
            panel: 'helpers',
            at: now(),
          })
          host.changed(true)
        }
        let left = late
        return {
          take: () => {
            const got = left
            left = ''
            return got
          },
        }
      })
      st.batches.set(self.id, batch)
      return batch
    },
    run(input) {
      if (helper) return { ok: false, info: '子任务不能启动工作流，只做派给你的这一件事' }
      if (ctx.chat) return { ok: false, info: '对话里用 start_plan 启动工作流' }
      if (!planner) return { ok: false, info: '只有编排器能起运行，节点里按流程走' }
      const run = currentRun(task)
      if (task.steps.some((s) => !s.parentId && inRun(s.id, run) && s.status === 'running' && !isMainStep(s)))
        return { ok: false, info: '这次运行还有节点在执行，等它走完再起新的运行' }
      askRun(host, input)
      system(host, t('主角色起了新的一次运行：{input}', { input: clip(input || t('按流程图再走一遍'), 300) }), where)
      host.changed(true)
      return { ok: true, info: '这一轮结束后会按流程图跑一次新的运行，节点全部新建' }
    },
    closeRun() {
      if (ctx.chat) return { ok: false, info: '对话里没有进行中的运行可以结束' }
      if (!planner) return { ok: false, info: '只有编排器能结束运行' }
      const run = currentRun(task)
      for (const s of task.steps)
        if (!s.parentId && inRun(s.id, run) && s.status !== 'done' && s.status !== 'skipped') s.status = 'skipped'
      task.flowClosed = true
      return { ok: true, info: '这次运行已经结束，没完成的节点不再执行' }
    },
    planning: !!ctx.planning,
    plan(workflowId, input, step) {
      if (helper) return { ok: false, info: '子任务不能启动工作流，只做派给你的这一件事' }
      if (!ctx.chat) return { ok: false, info: '节点里不能启动计划，按流程执行' }
      if (!ctx.planning)
        return { ok: false, info: '这个 Agent 没有开启「按工作流执行计划」的能力，直接在当前对话里执行' }
      if (task.steps.some((s) => !s.parentId && inRun(s.id, currentRun(task)) && s.status === 'running'))
        return { ok: false, info: '上一次计划还在执行，等它结束再启动新的' }
      askPlan(host, { workflowId: workflowId.trim(), input: input.trim(), step: step?.trim() })
      const wf = workflowId ? task.runs.flatMap((r) => r.workflows).find((w) => w.id === workflowId) : undefined
      const label = wf?.name || workflowId || '默认工作流'
      planStarted(
        host,
        t('开始执行计划（{name}）：{input}', { name: label, input: clip(input || t('按工作流走一遍'), 300) }),
        where,
      )
      host.changed(true)
      return { ok: true, info: '这一轮结束后会同步跑完这次计划，再把结果交回对话' }
    },
    plans: !!ctx.chat && !helper && !!task.projectId,
    async setPlan(input) {
      if (!ctx.chat || helper || !task.projectId) return { ok: false, info: '只有项目里的对话有执行计划' }
      const r = applyPlan(task, input, undefined, host.wrapUp, await kidsOf(host))
      if (r.ok) host.changed(true)
      return r
    },
    async finishPlan(summary) {
      if (!ctx.chat || helper || !task.projectId) return { ok: false, info: '只有项目里的对话有执行计划' }
      const r = finishPlan(task, summary, undefined, await kidsOf(host))
      if (r.ok) host.changed(true)
      return r
    },
    coordinator,
    async conversations() {
      if (!coordinator || !host.listConversations) return '（这个对话不能分派子对话）'
      const list = await host.listConversations()
      if (!list.length) return '（还没有子对话）'
      return list
        .map((c) =>
          [
            `- ${c.id}｜${c.title}｜${c.status}`,
            c.summary ? `：${clip(c.summary, 200)}` : '',
            // 在等什么、最后有动静多久了：「是不是卡住了」靠这两项回答，不再让人拿分支时间戳猜
            c.waiting ? `｜${c.waiting}` : '',
            c.doing ? `｜在做：${c.doing}` : '',
            c.lastActivityAt ? `｜最后活动 ${timeAgo(c.lastActivityAt)}` : `｜最近 ${timeAgo(c.at)}`,
          ].join(''),
        )
        .join('\n')
    },
    async createConversation(title, message, files, step, extra) {
      if (!coordinator || !host.createConversation) return { ok: false, info: '这个对话不能创建子对话' }
      if (task.inlineEdit)
        return { ok: false, info: '就地改动还没结束：先改完、提交，调用 end_inline_edit 收尾，再派子对话' }
      if (!message.trim()) return { ok: false, info: 'message 不能为空' }
      // 标题由父对话的 Agent 分析需求后给出，不拿用户原话截断凑数
      if (!title.trim())
        return { ok: false, info: 'title 不能为空：先分析这条需求，起一个能区分任务的短标题，再调用一次' }
      // 子对话失败、被中断后要重试：在原来那个子对话里接着做（用户 2026-10-25 定的），不另起一个「（重试）」
      const again = await retryTarget(host, title)
      if (again)
        return {
          ok: false,
          info: `子对话「${again.title}」（id ${again.id}）${again.status}：重试不要新建子对话，用 send_to_conversation 交回给它（id ${again.id}），它在原来的会话里接着做，已经做完的不用重做。`,
        }
      // 子对话的角色：点名的必须是启用的高级角色（子对话是负责人，要能调度能力），不写由宿主用「执行」
      const roleName = extra?.role?.trim()
      const role = roleName
        ? host.agents.find((a) => a.enabled && (a.name === roleName || a.id === roleName))
        : undefined
      if (roleName && (!role || roleKind(role) !== 'advanced')) {
        const names = host.agents
          .filter((a) => a.enabled && roleKind(a) === 'advanced' && !a.canDelegate)
          .map((a) => `「${a.name}」`)
          .join('、')
        return {
          ok: false,
          info: `role 写的「${roleName}」不是可用的高级角色${names ? `：可以写 ${names}` : ''}；不写就用「执行」`,
        }
      }
      const r = await host.createConversation({
        title: title.trim(),
        message,
        files,
        ...(role && { agentId: role.id }),
      })
      if (r.ok && r.id) recordRoute(host, 'child', [r.id], title.trim(), extra?.route)
      // 不另记系统消息：对话里这次工具调用本身显示成「新建子对话 标题」
      // 没指定步骤就挂到计划里能对上的一步；对不上（或者计划已经结束）由 ensureChildStep 自动补一步，
      // 不然这一步一标完成，父对话的计划就「已完成」了，子对话却还没合回（用户报过：一堆子对话在跑、计划面板还停在旧状态）
      const at = r.ok && r.id ? step?.trim() || ensureChildStep(task, r.id, title) : ''
      const wait = r.ok && r.id && at ? bindWait(task, at, { kind: 'child', ref: r.id, label: title.trim() }) : ''
      if (r.ok) host.changed(true)
      return { ok: r.ok, id: r.id, info: [r.info, wait].filter(Boolean).join('\n') }
    },
    async sendToConversation(id, message, step, route) {
      if (!coordinator || !host.sendToConversation) return { ok: false, info: '这个对话不能给子对话发消息' }
      if (!message.trim()) return { ok: false, info: 'message 不能为空' }
      // 一条消息只交给一个子对话（用户 2026-10-24 定的）：同一段话逐个转给几个子对话，
      // 父对话里刷出一排一模一样的「发送消息」，几个子对话还会各改各的同一处
      // 并行发出的几次调用可能还没记进对话：这一轮已经交出去的也记在内存里一起查
      const handed = handedOff.get(task) ?? new Map<string, string>()
      handedOff.set(task, handed)
      const prev = handed.get(message.trim())
      const other = (prev !== id.trim() ? prev : undefined) ?? sentToOther(task, id.trim(), message)
      if (other)
        return {
          ok: false,
          info: `这段话已经交给了子对话 ${other}，一条消息只交给一个子对话：选最相关的那一个交，别的子对话不用重复发。`,
        }
      handed.set(message.trim(), id.trim())
      const r = await host.sendToConversation(id.trim(), message)
      if (!r.ok) handed.delete(message.trim())
      // 标题从子对话列表里取：补步骤时用它当标题（只看 id 的话计划里会出现「子对话：c1」这种没信息量的标题）
      const kidTitle = r.ok ? await kidTitleOf(host, id.trim()) : ''
      const at = r.ok ? step?.trim() || ensureChildStep(task, id.trim(), kidTitle) : ''
      const wait = r.ok && at ? bindWait(task, at, { kind: 'child', ref: id.trim(), label: kidTitle || id.trim() }) : ''
      if (r.ok) recordRoute(host, 'resend', [id.trim()], kidTitle || id.trim(), route)
      if (r.ok) host.changed(true)
      return wait ? { ok: r.ok, info: `${r.info}\n${wait}` } : r
    },
    // 挂了能力的高级角色就地用能力：取能力的完整做法（子任务只做派给它的那件事，不加载别的能力）
    capabilities: !helper && !!selfAgent && mountedAgents(selfAgent, host.agents).length > 0,
    loadCapability(name, params) {
      if (helper || !selfAgent) return { ok: false, info: '这里没有挂载的能力' }
      if (!name.trim()) return { ok: false, info: 'name 不能为空：写能力的名字（见角色设定里「你挂载的能力」）' }
      const r = loadCapability(selfAgent, host.agents, name, task.params ?? {}, task.skillSlots ?? {}, params ?? {})
      if (!r.ok) return { ok: false, info: r.text }
      // 同一个会话里已经加载过、参数也没变的不再整段返回：上下文里已经有了，重复贴只占地方
      const key = `${self.id}\u0000${name.trim()}\u0000${JSON.stringify(params ?? {})}`
      const seen = loadedCaps.get(host) ?? new Set<string>()
      loadedCaps.set(host, seen)
      if (seen.has(key)) return { ok: true, info: `「${name.trim()}」这一轮已经加载过，做法见上文` }
      seen.add(key)
      return { ok: true, info: r.text }
    },
    inlineEdit: coordinator && !!host.inlineEdit && selfAgent?.inlineEdit === 'tiny',
    async beginInlineEdit(files, reason, route) {
      if (!coordinator || !host.inlineEdit || selfAgent?.inlineEdit !== 'tiny')
        return { ok: false, info: '这个对话不能就地改文件：把改动交给子对话（create_conversation）' }
      const r = await host.inlineEdit.begin(normInlinePaths(files), reason.trim())
      if (r.ok) recordRoute(host, 'inline-edit', normInlinePaths(files), reason.trim(), route)
      host.changed(true)
      return r
    },
    async endInlineEdit() {
      if (!host.inlineEdit) return { ok: false, info: '这个对话没有就地改动' }
      const r = await host.inlineEdit.end()
      host.changed(true)
      return r
    },
    // 子任务的结果只交回派它的对话，不直接和父对话通讯、不认领文件（推回的结果由同一个对话处理）
    child: !helper && !!task.parentTaskId && !!host.messageParent,
    claims: !helper && !!host.claimFiles,
    // 子任务也能用后台命令：命今跑在同一个对话的目录里、结果也推回同一个对话，只是记录上带自己的步骤 id，
    // 运行区据此按「子任务 + 命令名」单独列出（见 web/src/components/tasks/RunningNow.tsx）
    canBackground: !!host.runBackground,
    async runBackground(input) {
      if (!host.runBackground) return { ok: false, info: '这里不能用后台命令，直接执行' }
      if (!input.command.trim()) return { ok: false, info: 'command 是空的' }
      const { step, ...job } = input
      // 归属：调用时点名的步骤优先；子任务没点名就记它自己的步骤 id（运行区据此区分两种来源）；
      // 父对话没点名就挂到当前进行的那一步上——以前不带 step 的长命令在计划里完全看不见，计划还停在上一步
      const owner = step?.trim() || (helper ? self.id : runningStepId(task))
      const r = await host.runBackground(owner ? { ...job, step: owner } : job)
      // 计划里的步骤挂上「等这条命令」：子任务的步骤不在计划里（它是 slot='sub' 的步骤），不挂
      const wait =
        !helper && r.ok && r.id && owner
          ? bindWait(task, owner, { kind: 'background', ref: r.id, label: job.name })
          : ''
      if (r.ok) host.changed(true)
      return { ok: r.ok, info: [r.info, wait].filter(Boolean).join('\n') }
    },
    checkBackground(id) {
      return host.checkBackground ? host.checkBackground(id.trim()) : '这里没有后台命令'
    },
    stopBackground(id) {
      return host.stopBackground ? host.stopBackground(id.trim()) : { ok: false, info: '这里没有后台命令' }
    },
    canSubmit: !helper && !!host.submitMerge,
    // 只有对话自己能开：派出去的子角色、计划里的节点中途换目录，会和对话本身对不上
    canBeginEdit: !!host.beginEdit && !!ctx.chat && !self.parentId,
    async beginEdit() {
      if (!host.beginEdit || !ctx.chat || self.parentId) return { ok: false, info: '这个对话不用开独立分支，直接改' }
      const r = await host.beginEdit()
      if (r.ok) host.changed(true)
      return r
    },
    async submitMerge(note, tests, build, handoff, triage, override) {
      if (!host.submitMerge) return { ok: false, info: '你没有独立分支，改动已经在原目录里，不用合并' }
      const r = await host.submitMerge(note.trim(), tests.trim(), build, handoff, triage, override)
      if (r.ok) host.changed(true)
      return r
    },
    ueBuild: !helper && ctx.chat && host.ueBuild ? host.ueBuild.role : '',
    async requestBuild(note, step, children) {
      if (helper || !ctx.chat || !host.ueBuild) return { ok: false, info: '这里不用申请编译' }
      if (!note.trim()) return { ok: false, info: '写清为什么要编译：哪些改动、哪些子对话申请的' }
      const r = await host.ueBuild.request(note.trim(), children)
      const wait = r.ok && r.id && step ? bindWait(task, step, { kind: 'background', ref: r.id, label: '编译' }) : ''
      if (r.ok) host.changed(true)
      return { ok: r.ok, info: [r.info, wait].filter(Boolean).join('\n') }
    },
    parentOf: !helper && !!ctx.chat && !!host.finishChild,
    async finishChild(id) {
      if (helper || !ctx.chat || !host.finishChild) return { ok: false, info: '这个对话没有子对话可以收尾' }
      // 就地改动期间不合回子对话：合并和就地改动搅在同一个工作区里，改动算不清、也可能互相覆盖
      if (task.inlineEdit)
        return { ok: false, info: '你在就地改动：先改完、提交，调用 end_inline_edit 收尾，再收尾子对话' }
      if (!id) return { ok: false, info: 'id 是空的：写子对话的 id（收尾请求里有）' }
      const r = await host.finishChild(id)
      host.changed(true)
      return r
    },
    peers: !helper && !!ctx.chat && !!host.peers,
    async listPeers() {
      if (!host.peers) return '（这个对话不能联系其他父对话）'
      const list = await host.peers()
      if (!list.length) return '（这个项目里没有别的父对话）'
      return list
        .map(
          (p) =>
            `- ${p.id}｜${p.title}｜${p.busy ? '执行中' : p.status}${p.building ? `｜占着编译：${p.building}` : ''}`,
        )
        .join('\n')
    },
    async messagePeer(id, text) {
      if (!host.messagePeer) return { ok: false, info: '这个对话不能联系其他父对话' }
      if (!text.trim()) return { ok: false, info: 'text 不能为空' }
      return host.messagePeer(id.trim(), text.trim())
    },
    async toParent(text, question, options, kind) {
      if (!host.messageParent) return { ok: false, info: '这个对话没有父对话' }
      if (!text.trim()) return { ok: false, info: 'text 不能为空' }
      return host.messageParent(text.trim(), question, options, kind)
    },
    claim(paths) {
      if (!host.claimFiles) return { ok: false, info: '这个对话不需要认领文件' }
      const list = paths.map((p) => p.trim()).filter(Boolean)
      if (!list.length) return { ok: false, info: 'paths 是空的：写要改的文件或目录（相对项目根）' }
      const r = host.claimFiles(list)
      const lines = [
        r.granted.length ? `已认领：${r.granted.join('、')}` : '',
        r.held.length
          ? `被其他子对话占着（不要改）：${r.held.map((h) => `${h.path}（「${h.by}」）`).join('、')}。先做别的部分，过一会儿再认领；绕不开就用 message_parent 请父对话协调。`
          : '',
      ]
      return { ok: !r.held.length, info: lines.filter(Boolean).join('\n') }
    },
    release(paths) {
      if (!host.releaseFiles) return { ok: false, info: '这个对话不需要认领文件' }
      const n = host.releaseFiles(paths.map((p) => p.trim()).filter(Boolean))
      return { ok: true, info: n ? `已释放 ${n} 条认领` : '没有要释放的认领' }
    },
    readState() {
      const entries = Object.entries(runState(task))
      if (!entries.length) return '（共享状态还是空的）'
      return entries
        .map(([k, v]) => `- ${k}（v${v.version}，${v.by || '未知节点'} 写入，${v.at}）：\n${clip(v.value, 4000)}`)
        .join('\n\n')
    },
    writeState: (key, value) => writeRunState(host, self.id, key, value),
    lessons: host.lessons
      ? {
          find: async (files, opts) =>
            findLessons(await host.lessons!.list(), files, (await host.lessons!.globals?.()) ?? [], opts),
          record: (input) => host.lessons!.record(input),
        }
      : undefined,
    p4Split: host.p4Split,
    status: () => statusTree(host, self.id),
    spawn(tasks, step, opts) {
      if (helper) return { ids: [], error: '子任务里不能再派子任务，请自己完成' }
      const list = tasks.filter((x) => x && (x.title?.trim() || x.instructions?.trim()))
      if (!list.length) return { ids: [], error: 'tasks 是空的：每个子任务要写 title 和 instructions' }
      const mine = task.steps.filter((s) => s.parentId === self.id && s.slot === 'sub')
      const have = mine.length
      if (host.halted) return { ids: [], error: '任务已经停止或有节点失败，不再派新的子 Agent' }
      // 子任务默认用必备角色「子任务」；点名要「测试验收」「文档」这类通用角色时用点名的
      const helperRole = host.agents.find((a) => isHelperAgent(a) && a.enabled)
      // 独立分支里的子对话：提交和合回只走 submit_merge。派「版本控制」去收尾，它会照角色设定自己提交、
      // 甚至自己去合并，面板的收尾步骤一直等不到 submit_merge，子对话就卡在最后一步
      if (host.submitMerge) {
        const vcs = list.find((x) => {
          const want = x.agent?.trim()
          return want && host.agents.some((a) => a.origin === VCS_ORIGIN && (a.id === want || a.name === want))
        })
        if (vcs)
          return {
            ids: [],
            error:
              '你在独立分支里，不用派「版本控制」：提交和合回都由面板做。验证跑通后你自己调用 submit_merge（面板把改动提交到你的分支，父对话合回原分支），不要自己或让子任务 git commit / merge。只想核对改动范围就自己看 git status / git diff。',
          }
      }
      // 点名的角色必须真的存在：找不到时不能落到默认「子任务」，那和复看降级成子任务一样——
      // 派出去的角色和调用方以为的不一样，提示词也跟着换，而交回的结果看不出走了样
      const available = commonAgents(host.agents)
        .map((a) => `「${a.name}」`)
        .join('、')
      for (const spec of list) {
        const want = spec.agent?.trim()
        if (want && !host.agents.some((a) => a.id === want || a.name === want))
          return {
            ids: [],
            error: `agent 写的「${want}」不是已有的角色${available ? `：可以点名 ${available}` : ''}。角色名写错了、或者它已经被删掉或改名：用 get_status 看现在有哪些角色，确认后重新派`,
          }
      }
      // 调用者是挂了能力的高级角色：挂载上定的用法管住怎么用它们（角色分层，见 shared/agent-role.ts 的 mountMode）。
      // 设成「就地用」的不派出：派出去是另一套冷启动的上下文，等于绕开了挂载的约定，也白花一次注入
      const mounts = selfAgent ? mountedAgents(selfAgent, host.agents) : []
      const mountOf = (want: string | undefined) =>
        want ? mounts.find((m) => m.agent.id === want || m.agent.name === want) : undefined
      for (const spec of list) {
        const m = mountOf(spec.agent?.trim())
        if (m?.mode === 'inline' && !spec.resume?.trim())
          return {
            ids: [],
            error: `「${m.agent.name}」在你这里挂成了就地用：调用 use_capability（name 写「${m.agent.name}」）取它的做法，在当前对话里自己做，不派子任务`,
          }
      }
      // 只在父对话执行的角色（runIn: 'parent'，或挂载上定成「转交父对话」）：子对话里点名它时不在这里建，
      // 转交父对话创建（见 ADR 0019）。判定放引擎里：对话、工作流节点、start_plan、计划面板定时任务的 spawn 都走这里，放 orch-mcp 会漏
      const local = list.filter((spec) => {
        if (opts?.local || !host.task.parentTaskId) return true
        const want = spec.agent?.trim()
        if (mountOf(want)?.mode === 'parent') return false
        return !want || host.agents.find((a) => a.id === want || a.name === want)?.runIn !== 'parent'
      })
      // 转交出去的不占这个节点的名额，也不给这个对话的收尾添等待：结果在父对话那边
      // 对话会一直聊下去：上限只算还没结束的，做完的不占名额
      const busy =
        self.id === CHAT_STEP ? mine.filter((s) => s.status === 'running' || s.status === 'pending').length : have
      if (busy + local.length > MAX_HELPERS_PER_STEP)
        return { ids: [], error: `一个节点最多同时派 ${MAX_HELPERS_PER_STEP} 个子任务，已经派了 ${busy} 个` }
      const handed: { spec: HelperSpec; id?: string }[] = []
      const handFailed: string[] = []
      for (const spec of list) {
        if (local.includes(spec)) continue
        // 转交出去的是父对话里新建的子任务，接不上这个对话里原来的会话
        if (spec.resume?.trim()) {
          handFailed.push(`「${spec.title}」不能接着原来的子任务：转交父对话创建的是新任务，去掉 resume 再派`)
          continue
        }
        try {
          if (!host.forwardSpawn) {
            handFailed.push(`「${spec.title}」不能在这里执行：这个角色禁止子对话执行，而当前环境没有父对话可以转交`)
            continue
          }
          const r = host.forwardSpawn({ ...spec, resume: undefined })
          if (r.ok) handed.push({ spec, id: r.id })
          else handFailed.push(`「${spec.title}」没能转交父对话：${r.info}`)
        } catch (e) {
          handFailed.push(`「${spec.title}」转交父对话时出错：${(e as Error).message}`)
        }
      }
      // 一批全是转交的：本地不建子任务，点名的步骤立即标完成（等父对话那边的结果会把子对话卡住）
      const stepAt = !helper && ctx.chat ? step?.trim() : ''
      if (!local.length) {
        if (!handed.length) return { ids: [], error: handFailed.join('\n') || '没有可以派的子任务' }
        const lines = handed.map((h) =>
          t('已转交父对话创建「{title}」{id}', {
            title: h.spec.title,
            id: h.id ? t('（id: {id}）', { id: h.id }) : '',
          }),
        )
        // 一批里还有没交出去的（例如带 resume 的转交被拒）：不标完成、返回 error——
        // 否则模型拿到「没报错 + 步骤已完成」就以为整批都派出去了，少做的那件永远没人补。
        // 但已经交出去的那几件仍要写成系统记录：子对话的收尾总结要能说明这件事（见 ADR 0019）
        const all = handFailed.length === 0
        const done = all && stepAt ? finishStepNow(task, stepAt, t('已转交父对话')) : ''
        system(host, t('「{title}」{note}', { title: self.title, note: lines.join('\n') }), where)
        host.changed(true)
        if (!all) return { ids: [], error: [...lines, ...handFailed].join('\n') }
        return { ids: [], info: [lines.join('\n'), done].filter(Boolean).join('\n') }
      }
      // 接着之前的子任务：同一个会话同一时间只能跑一轮，还在跑的、同一批里两个都要接的都拒绝
      const resumed = new Map<HelperSpec, TaskStep>()
      for (const spec of local) {
        const id = spec.resume?.trim()
        if (!id) continue
        const target = resumeTarget(mine, id)
        if (!target.prev) {
          if (target.picked.length)
            return {
              ids: [],
              error: `resume 写的「${id}」能对上多个子任务，不猜，写全 id 再派：${target.picked.map(helperLabel).join('、')}`,
            }
          const recent = mine.slice(-MAX_RESUME_IDS)
          const more = mine.length > recent.length ? `（共 ${mine.length} 个，只列最近 ${recent.length} 个）` : ''
          const listed = recent.length ? `\n你派过的子任务${more}：${recent.map(helperLabel).join('、')}` : ''
          return {
            ids: [],
            error: `resume 写的「${id}」不是你派过的子任务（用 spawn_agents 返回的 id）${listed}`,
          }
        }
        const prev = target.prev
        const key = prev.session || prev.id
        const busyKey = mine.some(
          (s) =>
            (s.session || s.id) === key &&
            (s.status === 'running' || (s.status === 'pending' && !s.interrupted && st.helpers.has(s.id))),
        )
        if (busyKey) return { ids: [], error: `「${prev.title}」的会话还在跑，等它结束再接着用` }
        if ([...resumed.values()].some((s) => (s.session || s.id) === key))
          return { ids: [], error: `同一批里不能有两个子任务都接着「${prev.title}」的会话` }
        const want = spec.agent?.trim()
        // 原来是哪个角色就以哪个角色接着跑（提示词、CLI、模型都跟着它）。
        // 角色被删掉时不能退回默认的「子任务」：那等于换了一个角色跑原来的会话，交回的结果也看不出走了样。
        // agentId 为空是旧数据里「没有角色」（不是角色被删），照旧交给下面的默认逻辑
        const was = prev.agentId ? host.agents.find((a) => a.id === prev.agentId) : undefined
        if (prev.agentId && !was && !want)
          return {
            ids: [],
            error: `「${prev.title}」原来的角色已经找不到了（可能被删掉或改名），不能接着它的会话：用 get_status 看现在有哪些角色，再显式写 agent 点名一个`,
          }
        if (want && was && was.id !== want && was.name !== want)
          return { ids: [], error: `「${prev.title}」是另一个角色跑的，接着它的会话时 agent 不写或写同一个角色` }
        resumed.set(spec, prev)
      }
      // 第一次派评审代码改动：交接单必须带需求和跑过的检查（ADR 0013）。
      // 评审只看改动的代码，这些背景只有派它的对话有；不交，评审就会自己读文档、搜项目去还原，一次评审拖到二十多分钟
      for (const spec of local) {
        if (resumed.has(spec)) continue
        const want = spec.agent?.trim()
        const role = want ? host.agents.find((a) => a.id === want || a.name === want) : undefined
        if (!reviewsCode(role)) continue
        const lack = briefMissing(spec)
        if (lack)
          return {
            ids: [],
            error: `派「${role!.name}」评审代码改动要带交接单 review：缺 ${lack}。把你已经知道的整理进去（goal、changes、checks 必写清楚，focus、context、files 按需），评审只看改动的代码，不再自己去项目里找这些背景。`,
          }
      }
      const made = local.map((spec, i) => {
        const want = spec.agent?.trim() ?? ''
        const prev = resumed.get(spec)
        // 接着的是失败、被终止或中断的子任务：就在原来那个子任务里重试（同一个 id、同一条记录、同一个会话），
        // 不另起一个新的。做完的子任务再接着做（复看的评审）才新开一条记录、借它的会话
        if (prev && retriable(prev)) {
          const again = st.errors.get(prev.id) || (prev.interrupted ? '上次执行到一半被中断了' : '')
          st.errors.delete(prev.id)
          st.delivered.delete(prev.id)
          const more = spec.instructions.trim()
          if (more && !prev.brief.includes(more))
            prev.brief = [prev.brief, `## 重试时补充\n${more}`].filter(Boolean).join('\n\n')
          prev.status = 'pending'
          prev.interrupted = false
          prev.output = ''
          prev.endedAt = ''
          prev.reruns = (prev.reruns ?? 0) + 1
          // 原角色被删掉、这次显式点了名：换到点名那个角色上重试（它现在跑的就是这个角色）
          const repl = want ? host.agents.find((a) => a.id === want || a.name === want) : undefined
          if (repl && repl.id !== prev.agentId) prev.agentId = repl.id
          const tier = (['high', 'medium', 'low'].includes(spec.tier ?? '') ? spec.tier : ctx.tier) as NodeTier
          return { step: prev, spec, tier, again: again || '上次没有做完' }
        }
        const agent =
          (prev && host.agents.find((a) => a.id === prev.agentId)) ||
          (want && host.agents.find((a) => a.id === want || a.name === want)) ||
          helperRole ||
          host.agents.find((a) => a.id === self.agentId)
        const n = have + i + 1
        const step = blankStep({
          id: `${self.id}/sub/h${n}`,
          parentId: self.id,
          slot: 'sub',
          workflowId: ctx.workflow?.id ?? '',
          flowId: self.flowId,
          kind: 'agent',
          title: clip((spec.title || spec.instructions).trim().split('\n')[0], 60),
          agentId: agent?.id ?? self.agentId,
          session: prev ? prev.session || prev.id : '',
          // 要求原文存到节点上：父对话那条系统消息里只有标题，报告和 AI 分析需要原文才能判断它有没有做到。
          // 评审的交接单也是要求的一部分，一起存
          brief: [spec.instructions.trim(), briefPart(spec.review)].filter(Boolean).join('\n\n'),
        })
        task.steps.push(step)
        const tier = (['high', 'medium', 'low'].includes(spec.tier ?? '') ? spec.tier : ctx.tier) as NodeTier
        return { step, spec, tier, again: '' }
      })
      for (const m of made)
        st.helpers.set(
          m.step.id,
          runHelper(
            host,
            ctx,
            self,
            m.step,
            m.spec,
            m.tier,
            made.filter((x) => x !== m).map((x) => x.step.title),
            m.again,
          ),
        )
      const retried = made.filter((m) => m.again)
      // 一批里既有本地建的、又有转交出去的：转交的那几个不在这个对话里跑，告诉模型结果不回这里
      const handNote = [
        handed.length
          ? t('转交父对话创建：{list}（结果交回父对话，这个对话不用等）', {
              list: handed.map((h) => h.spec.title).join(t('、')),
            })
          : '',
        handFailed.length ? t('没能转交：{list}', { list: handFailed.join(t('；')) }) : '',
      ]
        .filter(Boolean)
        .join('\n')
      system(
        host,
        [
          retried.length === made.length
            ? t('「{title}」在原来的子任务里重试：{list}', {
                title: self.title,
                list: made.map((m) => m.step.title).join(t('、')),
              })
            : t('「{title}」派出 {n} 个子角色：{list}', {
                title: self.title,
                n: made.length,
                list: made.map((m) => m.step.title).join(t('、')),
              }),
          handNote,
        ]
          .filter(Boolean)
          .join('\n'),
        where,
      )
      // 记下派出了哪几个：对话里把它们收进这条消息的位置，做成可以展开的子任务卡片
      task.messages.at(-1)!.spawned = made.map((m) => m.step.id)
      // 点名的计划步骤挂上等待：全部结束、结果交回时由 settleHelpers 收口（成功标完成、失败退回进行中）。
      // 以前 spawn_agents 没有 step，派「版本控制」跑收尾那种步骤只能靠 linkKids 按标题猜，猜不中就永远挂在那里
      const at = !helper && ctx.chat ? step?.trim() : ''
      // 同一批子任务挂在同一步骤上：说明只回一句，否则 N 个子任务会在工具结果里刷 N 行一样的话
      const waits = at ? [bindWait(task, at, { kind: 'helper', ref: made[0].step.id, label: made[0].step.title })] : []
      if (at) for (const m of made.slice(1)) bindWait(task, at, { kind: 'helper', ref: m.step.id, label: m.step.title })
      // 父对话派的子任务记一条分诊（画成分诊卡）；子对话、节点派的是它们自己的事，不进分诊
      if (coordinator)
        recordRoute(
          host,
          'subtask',
          made.map((m) => m.step.id),
          made.map((m) => m.step.title).join(t('、')),
          opts?.route,
        )
      host.changed(true)
      return {
        ids: made.map((m) => m.step.id),
        ...(waits.length || handNote ? { info: [...waits, handNote].filter(Boolean).join('\n') } : {}),
      }
    },
    stopHelpers(ids, why) {
      if (helper) return { ok: false, info: '子任务不能终止别的子任务' }
      const mine = task.steps.filter((s) => s.parentId === self.id && s.slot === 'sub')
      const want = ids.length
        ? ids.map((id) => mine.find((s) => s.id === id || s.title === id))
        : mine.filter((s) => s.status === 'running' || s.status === 'pending')
      const missing = ids.filter((_, i) => !want[i])
      const done: string[] = []
      const over: string[] = []
      for (const s of want) {
        if (!s) continue
        if (stopHelper(task.id, s.id, why)) done.push(`${s.id}｜${s.title}`)
        else over.push(`${s.id}｜${s.title}`)
      }
      if (!done.length && !over.length && !missing.length) return { ok: false, info: '没有还在执行或排队的子任务' }
      return {
        ok: done.length > 0,
        info: [
          done.length ? `已终止 ${done.length} 个子任务：${done.join('、')}。它们会按「已终止」交回，不用等。` : '',
          over.length ? `这些已经结束了，不用终止：${over.join('、')}` : '',
          missing.length ? `找不到这些子任务（只能终止你自己派出的）：${missing.join('、')}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      }
    },
    async wait(ids, ms) {
      const mine = ids.length
        ? ids
        : task.steps.filter((s) => s.parentId === self.id && s.slot === 'sub').map((s) => s.id)
      const steps = mine.map((id) => task.steps.find((s) => s.id === id)).filter((s): s is TaskStep => !!s)
      const waiting = () =>
        Promise.race([Promise.all(steps.map((s) => st.helpers.get(s.id) ?? Promise.resolve())), sleep(ms)])
      await (host.yieldSlot ? host.yieldSlot(self.id, waiting) : waiting())
      const over = (s: TaskStep) => helperOver(host, s)
      const done = steps.filter(over)
      for (const s of done) st.delivered.add(s.id)
      // 手动取走结果的路径：helperBatch 的入口只看「还没取走的子任务」，取走后就轮不到 settleHelpers，
      // 计划里等它们的那一步会永远停在等待中。这里直接收口（成功标完成、失败退回进行中）
      if (done.length) settleHelperWaits(host)
      return {
        done: done.map((s) => helperReport(host, s)),
        running: steps.filter((s) => !over(s)).map((s) => helperReport(host, s)),
      }
    },
    async ask(question, ms) {
      const main = ctx.main
      if (!main) return { error: '这个工作流没有主 Agent 调度，自己判断，或者在结果里写明需要用户决定的事' }
      if (main.step.id === self.id) return { error: '你就是主 Agent，自己决定' }
      system(
        host,
        t('「{title}」向主角色提问：{question}', { title: self.title, question: clip(question, 500) }),
        where,
      )
      host.changed(true)
      let settled: AgentResult | undefined
      const p = mainTurn(host, main, 'answer', questionEvent(self.title, question)).then((r) => (settled = r))
      const waiting = () => Promise.race([p, sleep(ms)])
      await (host.yieldSlot ? host.yieldSlot(self.id, waiting) : waiting())
      const text = (r: AgentResult) => (r.ok ? stripDispatch(r.text).trim() : '')
      if (settled) return settled.ok ? { answer: text(settled) } : { error: `主 Agent 没能回答：${settled.error}` }
      // 主 Agent 还在忙（排队或在想）：回答到了放进提问者的收件箱，read_messages 取
      void p.then((r) => {
        if (r.ok) putMail(host, self.id, `主 Agent 回答了你的问题「${clip(question, 80)}」：${text(r)}`)
      })
      return { pending: true }
    },
    async send(to, text) {
      const target = findStep(to)
      if (!target) return { ok: false, info: `找不到「${to}」，用 get_status 看节点 id` }
      if (target.id === self.id) return { ok: false, info: '不能发给自己' }
      if (target.status === 'done' || target.status === 'failed' || target.status === 'skipped')
        return { ok: false, info: `「${target.title}」已经结束了，消息没有送到` }
      const body = `来自「${self.title || '对话'}」的消息：${text.trim()}`
      // 先记进这次运行，界面和重启后都能看到；交给正在跑的节点时再标成已读，避免它重复看到。
      // 不再另 push 一条 system 消息：发件方已经有「发送消息」工具行（正文可展开），再铺一条居中块会把整段正文摊在对话流里
      const kept = sendRunMessage(host, where, target.id, body)
      host.changed(true)
      if (target.status === 'running' && host.steer && (await host.steer(target.id, body))) {
        const rec = runRecord(task)
        const last = rec?.messages.at(-1)
        if (last && last.to === target.id) last.read = true
        return { ok: true, info: `已交给正在执行的「${target.title}」` }
      }
      if (!kept) putMail(host, target.id, body)
      return {
        ok: true,
        info:
          target.status === 'running'
            ? `已放进「${target.title}」的收件箱，它用 read_messages 能看到`
            : `「${target.title}」还没开始，开始时会带上这条消息`,
      }
    },
    inbox: () => takeMail(host, self.id),
  }
}

/** 去掉标题里「（重试）」「重试 2」「(retry)」这类标记，比较是不是同一件事 */
export const retryBase = (title: string) =>
  title
    .replace(/[（(【[]\s*(?:第\s*\d+\s*次)?\s*(?:重试|再试|retry)\s*\d*\s*[）)】\]]/gi, '')
    .replace(/\s*[-—:：·|｜]?\s*(?:重试|再试|retry)\s*\d*\s*$/i, '')
    .trim()

/**
 * 新建子对话其实是在重试一个失败、中断的子对话：标题去掉重试标记后和它一样。
 * 返回那个子对话，父对话应该用 send_to_conversation 交回给它
 */
async function retryTarget(host: EngineHost, title: string) {
  if (!host.listConversations) return undefined
  const base = retryBase(title)
  if (!base) return undefined
  const ended = new Set([convStateText('failed'), convStateText('stopped')])
  const list = await host.listConversations().catch(() => [])
  return list.find((c) => !c.resolved && !c.busy && ended.has(c.status) && retryBase(c.title) === base)
}

/** 失败、被终止、被中断的子任务：spawn_agents 的 resume 写它时在原来那条记录里重试 */
const retriable = (s: TaskStep) =>
  s.status === 'failed' || s.status === 'skipped' || (s.status === 'pending' && !!s.interrupted)

/** 执行一个派出的子 Agent */
async function runHelper(
  host: EngineHost,
  ctx: { workflow?: Workflow; main?: MainCtl; tier: NodeTier; chat?: boolean; coordinator?: boolean },
  parent: TaskStep,
  step: TaskStep,
  spec: HelperSpec,
  tier: NodeTier,
  siblings: string[],
  /** 在原来的子任务里重试：上次为什么没做完（失败原因、被终止、被中断） */
  again = '',
) {
  const st = orchState(host)
  const ac = new AbortController()
  const key = helperKey(host.task.id, step.id)
  helperStops.set(key, ac)
  /** 被终止了：记成跳过，原因交回给派它的对话（见 settleHelpers） */
  const stopped = () => {
    step.status = 'skipped'
    // 交回给派它的对话看的说明，不翻译
    st.errors.set(step.id, `已终止：${String(ac.signal.reason || '没写原因')}`)
    step.endedAt = now()
    host.changed(true)
  }
  // 有名额就当场占住；没有才排队。等待者被唤醒时不自己加一，名额由释放方直接交接，
  // 否则唤醒到它真正继续之间新来的子 Agent 会看到还没满，又多占一个。
  // 排队时被终止：从队里拿掉，不占名额，直接按终止交回
  let entered = true
  if (st.running < MAX_HELPERS_RUNNING) st.running++
  else
    entered = await new Promise<boolean>((resolve) => {
      const enter = () => {
        ac.signal.removeEventListener('abort', leave)
        resolve(true)
      }
      const leave = () => {
        const i = st.queue.indexOf(enter)
        if (i >= 0) st.queue.splice(i, 1)
        resolve(false)
      }
      st.queue.push(enter)
      ac.signal.addEventListener('abort', leave, { once: true })
    })
  if (!entered) {
    helperStops.delete(key)
    return stopped()
  }
  try {
    if (ac.signal.aborted) return stopped()
    if (host.halted) return
    step.status = 'running'
    step.startedAt = now()
    host.changed(true)
    const role = host.agents.find((a) => a.id === step.agentId)
    const reviewing = reviewsCode(role)
    const review = await reviewPart(host, step, spec)
    const prompt = [
      // 评审代码只要需求和必须遵守的规则：搜索范围、编译和收尾、授权这些段落是写给要动手的角色的，
      // 给评审只会引着它去搜项目、跑检查（ADR 0013）
      ...(reviewing ? reviewCommonPart(host) : commonPart(host, ctx.workflow, !!ctx.chat)),
      `${NODE_PART}\n你是「${isMainStep(parent) ? '主 Agent' : parent.title}」派出的子 Agent，负责其中一部分：${step.title}`,
      step.session
        ? `## 接着上一次做\n这是你之前那个会话的延续（上一次是「${host.task.steps.find((s: TaskStep) => s.id === step.session)?.title ?? step.session}」）：之前读过的文档和代码、给过的意见都还在上下文里，不用从头再读，只看这次交给你的增量和要确认的事。`
        : '',
      again
        ? `## 这是重试\n这个子任务上次没有做完：${clip(again, 600)}。还在同一个会话里的话，先看看之前已经做了哪些，从中断的地方接着做，已经做完的不用重做。`
        : '',
      spec.instructions.trim() ? `## 要做的事\n${spec.instructions.trim()}` : '',
      review,
      siblings.length
        ? `## 同时进行的子 Agent\n下面这些和你同时执行，不要做它们的工作，也尽量不要改同一个文件：\n${siblings.map((x) => `- ${x}`).join('\n')}`
        : '',
      `## 要求\n只完成上面这件事，不要做发起节点的其他工作。完成后用${promptLangWord()}简要总结结果，结果会交回给派你的 Agent。`,
    ]
      .filter(Boolean)
      .join('\n\n')
    // 评审到了软时限还没交卷：传话要它按已确认的交卷（CLI 不支持执行中补充时传不进去，不影响它继续）
    const wrap = reviewing
      ? setTimeout(() => void host.steer?.(step.id, REVIEW_WRAP_NOTE).catch(() => false), REVIEW_SOFT_LIMIT_MS)
      : undefined
    wrap?.unref?.()
    const r = await host
      .runAgent({
        step,
        agentId: step.agentId,
        prompt,
        // 接着之前的子任务时用它的会话（见 TaskStep.session），否则一个子任务一个会话
        sessionKey: step.session || step.id,
        tier,
        // 子任务的工具只剩查状态、读写共享状态、传话：不能再派子任务、启动工作流或开子对话。
        // chat 要透传：对话里的子任务用不上共享状态（跑过 start_plan 后 task.runs 会残留上一次运行）
        orch: makeOrchestra(host, { workflow: ctx.workflow, main: ctx.main, tier, helper: true, chat: ctx.chat }, step),
        signal: ac.signal,
      })
      .finally(() => clearTimeout(wrap))
    // 单独终止的：不管 CLI 怎么收的尾，都按终止交回（整个任务停止时 ac 没被触发，照旧走下面）
    if (ac.signal.aborted) return stopped()
    if (r.ok) {
      const late = await settleHelpers(host, step)
      // 评审、测试验收的输出常常比交接上限长：只截开头会把后面的意见整段丢掉（派它的 Agent 看不到、下一轮又被提一遍），
      // 完整内容和节点一样存成文件，交回的结果里写明去哪读
      step.output = await storeOutput(host, step, late ? `${r.text}\n\n## 子 Agent 的结果\n${late}` : r.text)
      step.status = 'done'
    } else {
      step.status = r.stopped || r.halted ? 'pending' : 'failed'
      // 被停止的标成打断：报告和界面才能说清「这一轮被停了、结论没出来」，而不是像还没开始
      if (r.stopped || r.halted) {
        pauseStep(step)
        step.interrupted = true
      } else {
        st.errors.set(step.id, r.error)
        system(host, r.error || t('执行失败'), step.id, true)
      }
    }
    step.endedAt = now()
    host.changed(true)
  } finally {
    helperStops.delete(key)
    // 名额直接交给排在最前面的那个，running 保持不变；没人排队时才真正空出来
    const next = st.queue.shift()
    if (next) next()
    else st.running--
  }
}

/** 按连线执行一个流程，返回连到「结束」的节点的输出 */
async function runFlow(host: EngineHost, inv: Invocation): Promise<FlowResult> {
  const live = reachable(inv.flow)
  const nodes = inv.flow.nodes.filter((n) => live.has(n.id))
  if (!nodes.length) return { ok: true, output: '' }
  const outputs = new Map<string, { title: string; text: string }>()
  /** 条件连线没走到的节点：整段跳过 */
  const skipped = new Set<string>()
  const branch = new Map<string, 'pass' | 'fail'>()
  const started = new Set<string>()
  const running = new Map<string, Promise<void>>()
  const failures: Fail[] = []
  const title = (n: FlowNode) => n.title.trim() || t('节点 {n}', { n: inv.flow.nodes.indexOf(n) + 1 })

  const incoming = (id: string) => inv.flow.edges.filter((e) => e.to === id && (e.from === START || live.has(e.from)))
  /** 这条线走得通：上游完成了，条件（如果有）和上游的结论一致 */
  const taken = (e: FlowEdge) =>
    e.from === START || (outputs.has(e.from) && (!e.when || e.when === (branch.get(e.from) ?? 'pass')))
  const settled = (e: FlowEdge) => e.from === START || outputs.has(e.from) || skipped.has(e.from)

  const ready = () => nodes.filter((n) => !started.has(n.id) && incoming(n.id).every(settled))

  for (;;) {
    let progressed = true
    while (progressed && !failures.length && !host.halted) {
      progressed = false
      for (const n of ready()) {
        started.add(n.id)
        const ins = incoming(n.id)
        // 进来的线一条都没走通（上游走了另一条分支，或者上游被跳过）：这个节点也跳过
        if (ins.length && !ins.some(taken)) {
          skipped.add(n.id)
          const step = ensureStep(host, inv, n, inv.flow.nodes.indexOf(n))
          if (step.status !== 'done') step.status = 'skipped'
          progressed = true
          continue
        }
        // 只把走通的线上的上游结果交给它
        const upstream = new Map(
          ins.filter(taken).flatMap((e) => (outputs.has(e.from) ? [[e.from, outputs.get(e.from)!]] : [])),
        )
        running.set(
          n.id,
          runNode(host, inv, n, inv.flow.nodes.indexOf(n), upstream).then((r) => {
            running.delete(n.id)
            if (r.ok) {
              const step = host.task.steps.find((s) => s.id === stepPath(inv, n.id))
              if (step?.branch) branch.set(n.id, step.branch)
              outputs.set(n.id, { title: title(n), text: r.output })
            } else {
              failures.push(r)
              host.halted = true
            }
          }),
        )
      }
    }
    if (!running.size) break
    await Promise.race(running.values())
  }

  if (failures.length) {
    const stopped = failures.find((f) => f.stopped)
    const real = failures.filter((f) => !f.halted && !f.stopped)
    if (stopped) return stopped
    if (!real.length) return failures[0]
    return real.length === 1
      ? real[0]
      : { ok: false, error: real.map((f) => f.error).join('\n\n'), reported: real.every((f) => f.reported) }
  }
  // 别处失败后这里没跑完：不能当成功返回
  if (host.halted && nodes.some((n) => !outputs.has(n.id) && !skipped.has(n.id)))
    return { ok: false, halted: true, error: '' }
  const ends = inv.flow.edges.filter((e) => e.to === END && outputs.has(e.from) && taken(e)).map((e) => e.from)
  const sinks = ends.length
    ? ends
    : nodes
        .filter((n) => outputs.has(n.id) && !inv.flow.edges.some((e) => e.from === n.id && live.has(e.to)))
        .map((n) => n.id)
  const out = sinks.map((id) => outputs.get(id)!).filter(Boolean)
  return {
    ok: true,
    output: out.length === 1 ? out[0].text : out.map((o) => `### ${o.title}\n${o.text}`).join('\n\n'),
  }
}

/** 对话 Agent 的伪节点：只用来绑定编排工具，不进入 task.steps */
const CHAT_STEP = '@chat'
function chatStep(host: EngineHost, agentId: string): TaskStep {
  return {
    ...blankStep({ id: CHAT_STEP, title: t('对话'), agentId }),
    status: 'running',
    startedAt: now(),
  }
}

/** 对话里启动一次工作流运行：节点全部新建，同步跑完，结果交回对话 */
async function startPlan(host: EngineHost, plan: PlannedRun): Promise<{ ok: boolean; text: string; error?: string }> {
  const snap = host.resolveWorkflow?.(plan.workflowId)
  const workflow =
    snap?.workflow ?? (plan.workflowId ? host.workflows.find((w) => w.id === plan.workflowId) : host.workflow)
  if (!workflow)
    return {
      ok: false,
      text: '',
      error: t('找不到要执行的工作流：{id}', { id: plan.workflowId || t('默认工作流') }),
    }
  const workflows = snap?.workflows ?? workflowClosure(workflow, host.workflows)
  const skillSlots = snap?.skillSlots ?? host.task.skillSlots
  // runSeq 是已经跑完的次数：第一次计划是第 1 次运行
  const run = (host.task.runSeq ?? 0) + 1
  host.task.runSeq = run
  host.task.flowClosed = false
  host.workflow = workflow
  host.workflows = workflows
  host.task.workflowId = workflow.id
  host.task.workflowName = workflow.name
  host.task.workflows = workflows
  host.task.skillSlots = skillSlots
  ensureTaskRun(host, workflow, run, skillSlots)
  for (const s of planTask(workflow, run).steps)
    if (!host.task.steps.some((x) => x.id === s.id)) host.task.steps.push(s)
  // 工作流是计划里的一个主步骤，它的节点就是子步骤
  if (host.task.projectId) bindRun(host.task, plan.step ?? '', run, t('工作流「{name}」', { name: workflow.name }))
  host.changed(true)
  const inv: Invocation = {
    workflow,
    flow: entryFlow(workflow),
    parentId: '',
    slot: '',
    round: 0,
    input: plan.input || host.prompt,
    depth: 0,
    run,
  }
  const r = await runFlow(host, inv)
  const rec = host.task.runs.find((x) => x.id === run)
  if (rec) {
    rec.status = r.ok ? 'done' : r.stopped ? 'stopped' : 'failed'
    rec.endedAt = now()
  }
  endRun(host.task, run, r.ok, r.ok ? '' : r.error)
  // 一次运行失败不拖住后面的对话：下一次计划重新开始
  host.halted = false
  host.changed(true)
  return r.ok ? { ok: true, text: r.output } : { ok: false, text: '', error: r.error }
}

/** 对话 Agent 的提示：这次的消息、可选工作流、子对话目录，以及分派规则 */
async function conversationPrompt(
  host: EngineHost,
  kind: 'top' | 'sub',
  planning: boolean,
  coordinator: boolean,
  /** 角色本身是做分派的（例如「主理」），这次却不能分派：要明说角色设定里的分派规则不适用 */
  delegates = false,
  /** 父对话能就地做微小改动（角色开了 inlineEdit、宿主给了护栏） */
  inline = false,
) {
  // 角色设定写着「用 create_conversation 分派」，执行方式又说没有这个能力：两条直接冲突，
  // Agent 要么空等分派、要么自己干又觉得违规。明确以执行方式为准
  const noDelegate = delegates
    ? '\n角色设定里用 list_conversations / create_conversation / send_to_conversation 分派子对话的规则这次不适用：这里没有这些工具，按上面的执行方式自己处理，不要假装已经分派。'
    : ''
  const catalog = host.workflowCatalog?.() ?? []
  const wt = host.task.worktree?.state === 'active' ? host.task.worktree : null
  const parts = [
    `## 用户这次的消息\n${host.prompt}`,
    promptLangRules(),
    policyPart(host),
    goalPart(host),
    rulesPart(host),
    searchPart(host),
    inboxPart(host),
    buildPart(host),
    verifyPart(host),
    editPart(host),
    backgroundPart(host),
    planPart(host, coordinator),
    wrapUpPart(host),
    p4Part(host),
    // 对话模式没有共享状态工具：这里不注入（跑过 start_plan 时 task.runs 里是上一次运行的旧状态）
    // 独立分支的子对话：不说清楚它会以为自己在项目目录里，去切分支或把改动提交到错的地方
    wt
      ? `## 执行目录
你在独立分支 ${wt.branch} 的单独目录里工作，不是项目目录；项目目录里的未提交改动看不到。
${
  host.task.parentTaskId
    ? host.ueBuild
      ? '别的子对话改不到这里，你也不用认领文件，放心改；父对话用 files 划了范围就按范围改，要改范围外的文件先说一声。这是 UE 项目，不在这里编译，见上面的「UE 编译交给父对话申请」。'
      : '别的子对话改不到这里，你也不用认领文件，放心改；父对话用 files 划了范围就按范围改，要改范围外的文件先说一声。编译、测试就在这里跑，跑通后用 submit_merge 合回原分支，见上面的「在独立分支里验证，再合回原分支」。'
    : wrapKind(host) === 'push'
      ? `提交留在这个分支上。计划的最后一步是「${WRAP_UP.push.title}」：那时先把它合回原分支（见下面「收尾：计划的最后一步」），再在原分支上推。`
      : '提交留在这个分支上，由用户决定合并还是丢弃。'
}不要自己切换 / 检出新分支；用户没要求时不要合并主分支${host.task.parentTaskId ? '（合并编译报冲突、面板让你把原分支合进来时除外）' : ''}。
不要把这个独立分支推送到远端${wrapKind(host) === 'push' ? `（推送归计划的最后一步「${WRAP_UP.push.title}」：合回原分支之后推原分支）` : '，用户明确要求之前一律不推'}。用户要求推送时，先把它合回原分支${
          host.task.parentTaskId
            ? '（调用 submit_merge，合进去后改动就在原分支上了）'
            : `（在原目录里 git merge --no-ff ${wt.branch}）`
        }，再在原目录${host.worktreeHome ? ` ${host.worktreeHome}` : ''}里推送原分支。
${wt.baseBranch ? `这个分支从「${wt.baseBranch}」开出。` : ''}`
      : '',
    catalog.length && planning
      ? `## 可用工作流\n${catalog
          .map(
            (w, i) =>
              `- id: ${w.id}｜${w.name}${i === 0 ? '（默认）' : ''}：${w.description}${w.steps.length ? `（节点：${w.steps.join(' → ')}）` : ''}`,
          )
          .join('\n')}\n\n需要按计划执行时调用 start_plan，workflow 写上面的 id；不写就是默认工作流。`
      : planning
        ? '## 可用工作流\n项目还没有配置工作流，直接在对话里执行。'
        : '## 工作流\n当前 Agent 没有开启「按工作流执行计划」的能力，直接在对话里执行。',
  ]
  if (coordinator) {
    const list = host.listConversations ? await host.listConversations() : []
    parts.push(
      `## 现有子对话\n${
        list.length
          ? list
              .map(
                (c) =>
                  `- ${c.id}｜${c.title}｜${c.busy ? '执行中' : c.status}${c.waiting ? `｜${c.waiting}` : ''}${c.lastActivityAt ? `｜最后活动 ${timeAgo(c.lastActivityAt)}` : ''}：${clip(c.summary, 200) || '（还没有结果）'}`,
              )
              .join('\n')
          : '（还没有子对话）'
      }`,
      `${
        inline
          ? `## 你的定位：父对话先分析再分派，只就地做微小改动
你是项目的父对话，负责理解用户的意思、需要时向用户问清楚、决定怎么处理、分派和汇总；改代码、编译、测试、找具体的 Bug 都交给子对话。
- 唯一能自己改文件的情况是「就地微改动」：改什么、改成什么已经清楚、不用排查，最多 ${INLINE_EDIT_MAX_FILES} 个文件、${INLINE_EDIT_MAX_LINES} 行以内（文案、配置值、一两行文档）。先调用 begin_inline_edit 声明文件和理由，面板放行后再改；改完跑项目测试步骤里标「快速」的检查，本地提交这几个文件，再调用 end_inline_edit。Bug、要排查的、改公共接口或数据格式的、超出上限的，一律交给子对话。
- 除此之外不修改、新建或删除任何文件，也不跑会写文件的命令（编译、安装依赖、格式化）。看代码、搜索、跑只读命令（git log、git diff 这类）可以。`
          : `## 你的定位：父对话只统筹，不动手
你是项目的父对话，负责理解用户的意思、收集上下文、分派和汇总；改代码、编译、测试、找具体的 Bug 都交给子对话。
- 不修改、新建或删除任何文件，也不跑会写文件的命令（编译、安装依赖、格式化、提交）。看代码、搜索、跑只读命令（git log、git diff 这类）可以。`
      }
${
  wt
    ? `- 你在这个对话的独立分支 ${wt.branch} 上（创建对话时开好的），不要再开别的分支。子对话从这个分支开出自己的独立分支，验证通过后合回这里。
- 推送：子对话的分支和你的独立分支都不推。用户明确要求推送时，按上面「执行目录」里说的先合回原分支再推。`
    : `- 你就在项目目录的当前分支${host.branch ? `「${host.branch}」` : ''}上，不开独立分支。子对话从这个分支开出自己的独立分支，验证通过后合回这里。
- 推送：子对话的分支不推。用户明确要求推送时，由你在这里推送当前分支。`
}
- 子对话报错、失败或被中断要重试：用 send_to_conversation 交回原来那个子对话，它在原来的会话里接着做，不要新建一个「（重试）」子对话。派出的子任务也一样：重试时 spawn_agents 的 resume 写原来那个子任务的 id。
- 子对话只剩合回时会发「收尾请求」给你：看它交的验证结果，够了就调用 finish_child（合回、标完成、删它的分支，都是工具调用，不要自己跑 git）；不够就用 send_to_conversation 把要补的交回给它。合并就是验收，测试要在它合并之前做完。
- 项目里有范围为「全量，合并后由父对话跑」的测试步骤时，合回后面板自动在你的目录里按顺序跑它们（一次只跑一个，和编译共用独占队列），结果和耗时直接回传给对应的子对话；你不用自己跑，也不用转述。跑完通过才算它收尾，失败会退回给子对话修，它重新合并后这些步骤全部重跑。等它跑完期间，你计划里等这个子对话的步骤保持等待。

## 这条消息怎么处理
1. 先判断它和现有子对话的关联强度：相关就调用 send_to_conversation，把消息交给最合适的那个子对话。
2. 现有子对话都不相关，要改代码、要排查问题或者要做较大的研究：调用 create_conversation 新建一个子对话，标题由你分析后起；子对话会自己列计划并执行。${inline ? '够得上就地微改动的（见上面）自己改，不开子对话；其余改动再小也交给子对话。' : '改动再小（一行、一个文案）也交给子对话。'}
3. 只是一般问题、讨论、查询：自己回答。
一条消息里有几件互不相关的事时拆开，分别交给不同的子对话，它们会同时执行。不要把同一件事发给多个子对话：用户的一条消息（连同用户定下的规则、约定）只交给关联最紧密的那一个子对话，和别的子对话手上的事无关就不转给它们；同一段话再交给别的子对话会被面板拒绝。子对话不能再创建子对话，子对话之间也不能直接通讯，需要配合时由你转达。

## 分派前只收集到模块为止
分派前花少量时间把方向找准就交出去，不要自己把问题分析到底：
- 找出这件事涉及的大体模块和入口文件（目录、主要文件），相关的文档（设计说明、AGENTS.md 里的约定、docs 里的说明）。
- 不去定位具体是哪一行、哪个函数出的错，不写修改方案的细节，不读完整个模块；这些交给子对话。
- message 里写：用户的原话和验收标准、现象 / 复现步骤 / 报错原文（有的话）、你找到的模块和入口文件、相关文档的路径。

${
  host.childIsolation === 'worktree'
    ? `## 子对话各自在独立分支里改
要改代码的子对话都有自己的独立分支目录，互相看不到对方改到一半的文件。
- 新建子对话时用 files 写清它负责的文件或目录（相对项目根），它按这个范围改。两个子对话的文件重叠没关系：各在自己的独立分支里改、互不影响，不用拆范围，也不用排队等对方。面板会在创建结果里提示重叠，那只是信息——合并回这里时按 git merge 处理，能自动合上的直接合。
- 子对话在自己的分支里编译、测试，跑通后调用 submit_merge，面板排队把它合回你所在的分支；有冲突撤回并推回给那个子对话。一次只合一个，你不用自己合并。合回去只代表改动进了你的分支，不等于它做完了：它还有计划没做完、后台命令还在跑、待回答的提问或者这一轮没结束时，面板不会把它标成完成，你也不要当它已经交付完了。
- 合并结果里写着「两边都改了这些文件」时，那个文件两边都动过（git 没报冲突也算了）：让子对话核对内容、确认没有把对方的改动盖掉，再当它交付完了。
- 每次合并的结果会告诉你；子对话做完一轮却没合并时，面板会先催它一次，还没合再交给你决定。子对话反复冲突、或者问题其实是别的子对话的改动引起的，由你协调。
- 几个子对话都合进来之后，需要整体验证时新建一个子对话去跑完整的测试，你自己不跑。
- 合并时面板已经在这个分支上提交了，你不用另外提交。`
    : `## 子对话共用一个目录
所有子对话都在同一个目录里直接改，不建独立分支。为了不互相覆盖：
- 新建子对话时用 files 写清它负责的文件或目录（相对项目根），面板替它认领；别的子对话改这些文件要等它做完。
- 两件事会改同一批文件时，交给同一个子对话，或者等前一个做完再交给下一个。
- 编译、全量测试会读到别的子对话改到一半的文件：同一时间只让一个子对话跑编译，结果不对时先确认是不是别人的改动造成的。
- 子对话报告文件冲突或者提问时，由你决定谁先做、怎么分，再用 send_to_conversation 告诉它们。`
}`,
    )
  } else if (kind === 'top') {
    parts.push(`## 执行方式\n直接在对话里回答或执行当前任务；没有创建子对话的能力。${noDelegate}`)
  } else {
    parts.push(
      planning
        ? `## 执行方式
你只负责当前这个子对话的任务。要修改代码、跨模块改动或较大的研究时，调用 start_plan 按项目的默认工作流执行（更合适的可选工作流写它的 id）；只是问题、分析或一两行的小改动直接在对话里做。你没有创建子对话的能力。${noDelegate}`
        : `## 执行方式
你只负责当前这个子对话的任务，直接在对话里执行。你没有创建子对话或按工作流启动计划的能力。${noDelegate}`,
    )
    // 界面把「没在跑、也没有提问」的子对话当成已完成：子对话安静停下等于把未决的问题藏起来
    parts.push(`## 停下之前先提问
子对话的「已停止」只由用户或父对话主动停止产生，你不要安静地停下。遇到拿不准的、需要用户确认的、不可逆的操作、缺外部信息时：用 ask_user 把问题、选项和各自的后果写清楚；要父对话决定时用 message_parent 并把 question 设为 true。先把提问发出去再结束这一轮，不要只在结论里写一句「待确认」。`)
    if (host.messageParent)
      parts.push(`## 收尾建议要交给用户选
这一轮做完了、结论里要给用户下一步怎么做的建议时（继续做某个方向、换个做法、要不要接着做），必须调用 suggest_next_step（text 写建议，options 写 2–4 个做法，第一个是推荐做法并标「（推荐）」），不要只写在结论里：只写在结论里用户看不出你是在等他，还是已经结束了，子对话就一直停在那条没人处理的建议上。用户选完会自动交回给你接着做。
建议只写你自己能做完的本地动作；完成标准是${wrapDone(host.wrapUp, parentRunsIn(host))}${host.wrapUp ? '——这是收尾，面板已经把它列成计划的最后一步，不要写成建议' : ''}；计划步骤和收尾里不写「等推送 / 等合入其他分支 / 同步远端」。推送、创建 PR、P4 submit、合并到主干由父对话决定，不要写成建议项，也不要写成要用户回答的问题。调用时 remote 必须写 "none"（这些建议不改远端）：写了别的值会被直接拒绝，卡片不会交给用户。`)
    if (host.messageParent)
      parts.push(
        host.claimFiles
          ? `## 和父对话、其他子对话的协作
你是项目对话分出来的子对话，和其他子对话在同一个目录里同时工作（没有独立分支）：
- 改文件前先用 claim_files 认领要改的文件或目录；被别的子对话占着的不要改，先做别的部分或用 message_parent 请父对话协调。做完一部分可以用 release_files 释放。
- 不要切换分支、不要 reset / checkout 别人的文件、不要格式化整个仓库，只动自己负责的范围。
- 编译或测试报错的位置不在你改的文件里时，先确认是不是别的子对话正在改的，不要去修别人的文件；提交时只 git add 你自己改的文件，不用 -A。
- 需要决定、发现和别的任务有关、或者做完一个阶段时，用 message_parent 告诉父对话（question 设为 true 表示需要它决定，options 列出可选的做法）。你不能直接联系其他子对话。`
          : `## 和父对话的协作
你是项目对话分出来的子对话。只动自己负责的范围，不要格式化整个仓库。
需要决定、发现和别的任务有关、或者做完一个阶段时，用 message_parent 告诉父对话（question 设为 true 表示需要它决定，options 列出可选的做法）。你不能直接联系其他子对话。`,
      )
  }
  return parts.filter(Boolean).join('\n\n')
}

/**
 * 一轮对话：调用对话 Agent；它启动的计划在这一轮里同步跑完，再交回结果继续对话。
 * 导出给单测验证「计划设的预算在 chat 路径也生效」。
 */
export async function runConversationTurn(host: EngineHost, who: string) {
  const { task } = host
  const kind = task.parentTaskId ? 'sub' : 'top'
  // 能不能分派子对话由 Agent 自己的能力开关决定；子对话本身永远不能再分派
  const agent = who ? host.agents.find((a) => a.id === who) : undefined
  // 独立聊天没有项目，create_conversation 一定失败：不按分派对话去提示
  const coordinator = kind === 'top' && !!agent?.canDelegate && !!task.projectId
  const planning = !!agent?.canPlan
  const turn = host.prewarm ? undefined : beginTurn(task, host.newId(), host.prompt, who)
  if (turn) host.changed(true)
  try {
    const inline = coordinator && !!host.inlineEdit && agent?.inlineEdit === 'tiny'
    let prompt = await conversationPrompt(
      host,
      kind,
      planning,
      coordinator,
      !coordinator && delegatesRole(host, agent),
      inline,
    )
    let orch: Orchestra | undefined
    // 回复完 CLI 就退出的（Claude Code、Codex）在这里等子任务；停在等待工具上的 CLI 在 runner 里自己等
    const gate = helperGate(
      () => orch?.helperBatch(),
      (text) => host.steer?.('', text) ?? Promise.resolve(false),
    )
    // 子任务交回结果、等待时用户插进来聊也算一圈：上限放宽一些
    for (let i = 0; i < 30; i++) {
      // 计划带的执行上限：和工作流节点同一套口径，每圈开始前先看一次。
      // 计划启动的是 chat 模式，不走 runNodeSteps，这里不查的话 token / 时长上限就完全不生效。
      // includeWorkflow=false：对话里跑过 start_plan 之后任务也带着工作流快照，工作流那份额度不该管聊天轮次
      const over = overBudget(host, false)
      if (over) {
        if (turn) endTurn(task, turn, 'stopped', Date.now(), host.stopReason?.())
        return finish(host, { ok: false, stopped: true, budget: true, error: over })
      }
      orch = makeOrchestra(
        host,
        { workflow: host.workflow, tier: '', chat: true, planning, coordinator },
        chatStep(host, who),
      )
      // 告诉宿这一轮的 Orchestra：对话 AI 正在处理这一轮时才接转交来的子任务（见 ADR 0019）。
      // 不能放在 makeOrchestra 后面一直挂着：等子任务结果、跑计划、执行工作流节点都在这同一个 try 里，
      // 那时派出的对话级子任务不参与节点收尾，这一轮很快就 done 了，结果再也交不回来
      host.onOrchestra?.(orch)
      let r: AgentResult
      try {
        r = await host.runAgent({
          agentId: who,
          prompt,
          // 会话键就是 Agent id；选了「无」时用空字符串，runner 仍然按对话处理
          sessionKey: who,
          ...(host.prewarm ? { prewarm: true } : {}),
          orch,
        })
      } finally {
        // AI 这一轮处理完了：宿主不再把转交来的子任务派进它（后面的阶段交给下一轮）
        host.onOrchestra?.(undefined)
      }
      if (!r.ok) {
        // 这一轮 CLI 已经报过完成（turnDoneAt）才被收掉：例如子对话交付完合并回收、父对话收尾、保活上限，
        // 这时用户没点暂停、活也已经干完，不能记成被打断。和 endTurn 用同一个判据，两处结论必须一致
        const answered = !!turn && !!r.stopped && (answeredAll(task, turn) || finishedStop(host))
        // 停止原因记进这一轮的结局：面板重启、父对话收尾、用户暂停在报告里要能分开算
        if (turn)
          endTurn(task, turn, answered ? 'done' : r.stopped ? 'stopped' : 'failed', Date.now(), host.stopReason?.())
        if (host.prewarm) {
          task.status = r.stopped && !answered ? 'stopped' : (host.prewarmFrom ?? 'done')
          return
        }
        return finish(host, r, { answered })
      }
      // 这一轮派出的子任务还没交回：对话停在这里等它们做完，结果交回给同一个会话接着做；
      // 等的时候用户发来的消息马上开一轮回复
      const next = gate.wait(host.signal ?? new AbortController().signal, host.waitChat)
      if (next) {
        const text = await next
        if (host.halted || !text) break
        prompt = text
        continue
      }
      const plans = takePendingPlans(host)
      if (!plans.length) break
      const results: string[] = []
      for (const p of plans) {
        const out = await startPlan(host, p)
        results.push(
          out.ok
            ? `### 计划执行完成\n${clip(out.text || '（没有文字输出）', 12000)}`
            : `### 计划执行失败\n${clip(out.error || '执行失败', 4000)}`,
        )
      }
      prompt = `## 计划执行结果\n${results.join('\n\n')}\n\n请根据结果继续：向用户说明完成了什么、有哪些改动和遗留问题；需要再启动一次计划就继续调用 start_plan。`
    }
    if (turn) endTurn(task, turn, 'done')
    if (host.task.parentTaskId) host.task.summary = summaryOf(host.task)
    // 预热没有处理新消息时由调用方恢复状态
    if (host.prewarm && (task.turnDoneAt ?? '') === host.prewarmTurnDoneAt) return
    task.status = 'done'
    host.changed(true)
  } catch (e) {
    if (turn) endTurn(task, turn, 'failed')
    throw e
  } finally {
    // 这一轮结束了：宿主不再拿它派转交来的子任务
    host.onOrchestra?.(undefined)
    // 就地改动这一轮没收：自动收尾核对（越界会写警告），免得下一轮一直拦着收尾子对话
    if (task.inlineEdit && host.inlineEdit)
      await host.inlineEdit.end().then(
        () => host.changed(true),
        () => undefined,
      )
  }
}

/** 角色（含引入的）有分派能力：它的设定里多半写着怎么分派子对话 */
function delegatesRole(host: EngineHost, agent: Agent | undefined) {
  if (!agent) return false
  return agent.canDelegate || includedAgents(agent, host.agents).some((x) => x.agent.canDelegate)
}

/**
 * 被停下时这一轮其实已经答完了没有：保活的进程回复完停在等下一句，之后被停止、换 CLI、父对话结束而收掉，
 * 这时 CLI 已经报过这一轮完成（turnDoneAt），而且晚于最后一条用户消息，就算正常结束，不能记成被打断。
 */
function answeredAll(task: Task, turn: { startedAt: string }) {
  const done = Date.parse(task.turnDoneAt ?? '')
  if (!Number.isFinite(done) || done < Date.parse(turn.startedAt)) return false
  const lastAsk = [...task.messages].reverse().find((m) => m.role === 'user')
  return !lastAsk?.at || done >= Date.parse(lastAsk.at)
}

/**
 * 这一轮是面板在对话彻底完成后收掉的（stopReason 为 finish）：子对话收尾做完、结束等下一句的进程。
 * 这时活已经干完，CLI 有没有来得及报完成（turnDoneAt）都不影响，不能记成「这一轮被中断」
 */
const finishedStop = (host: EngineHost) => host.stopReason?.() === 'finish'

/** 子对话的摘要：最近一条 Agent 回复的开头，父对话的协调 Agent 用它判断关联 */
function summaryOf(task: Task) {
  const last = [...task.messages].reverse().find((m) => m.role === 'agent' && m.text.trim())
  return last ? clip(last.text.replace(/\s+/g, ' ').trim(), 300) : ''
}

function followUpPrompt(host: EngineHost, blocked?: TaskStep) {
  const { original } = userRequests(host.task)
  if (host.task.mode === 'chat') return host.prompt
  const after = `完成后用${promptLangWord()}简要说明改了什么。`
  return [
    `用户对任务「${host.task.title}」提出了追加要求：\n${host.prompt}`,
    promptLangRules(),
    `## 任务的原始需求\n${original}`,
    host.workflow?.document.trim() ? `## 工作流说明\n${host.workflow.document.trim()}` : '',
    blocked
      ? `工作流停在了节点「${blocked.title}」：它的结论是不通过，后面的节点还没有执行。它的结果：\n${clip(blocked.output, 3000)}\n\n` +
        `请按追加要求处理（例如修好不通过的地方），必要时自己验证；${after}之后会重新执行「${blocked.title}」，通过后接着走后面的流程，后面节点的工作不用你做。`
      : host.task.flowClosed
        ? `用户已经结束了工作流，没完成的节点不再执行。请按追加要求直接修改，必要时自己验证；${after}`
        : `工作流的各个节点已经完成。请按追加要求直接修改，必要时自己验证；${after}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** 收尾：把这一轮的结果写进任务（导出给单测验证「超预算停下时不丢已有输出」） */
export function finish(host: EngineHost, r: Fail, opts?: { answered?: boolean }) {
  // 这一轮其实已经答完了（见 answeredAll）：CLI 报过完成、只是停在等下一句之后才被收掉，不算被打断——
  // 不写「这一轮被中断」、不记 stopReason，状态照常是 done。真停止（用户暂停、面板重启、CLI 崩溃）照旧
  const answered = !!r.stopped && (!!opts?.answered || finishedStop(host))
  for (const s of host.task.steps)
    if (s.status === 'running') {
      s.status = answered ? 'done' : r.stopped ? 'pending' : 'failed'
      s.interrupted = !!r.stopped && !answered
      if (r.stopped && !answered) pauseStep(s)
      s.endedAt = now()
    }
  if (r.budget) system(host, r.error, '', false, true, 'budget')
  else if (r.stopped && !answered) {
    // 谁结束的这一轮：只有用户按的暂停才说「已暂停」，别的动作要说清是谁结束的，
    // 不能让用户看到「我没点暂停却变成已暂停」（父对话收尾的时候子对话就是这种）
    const reason = host.stopReason?.() ?? 'user'
    host.task.stopReason = reason
    const next = host.task.mode === 'workflow' ? t('点「继续流程」') : t('点「继续执行」')
    system(
      host,
      reason === 'user'
        ? host.task.mode === 'workflow'
          ? t('已暂停。点「继续流程」从中断的地方接着做，或者在下面输入新的要求。')
          : t('已暂停。点「继续执行」从中断的地方接着做，或者在下面输入新的要求。')
        : t('这一轮被中断：{reason}。{next}从中断的地方接着做，或者在下面输入新的要求。', {
            reason: stopReasonText(reason),
            next,
          }),
      '',
      false,
      true,
    )
  } else if (!r.stopped) {
    const failed = host.task.steps
      .filter((s) => s.status === 'failed' && !s.parentId)
      .map((s) => t('「{title}」', { title: s.title }))
    system(
      host,
      r.reported
        ? t('{nodes}执行失败，原因见节点里的错误。可以点「继续流程」重试，或者在下面输入新的要求。', {
            nodes: failed.join(t('、')) || t('有节点'),
          })
        : r.error || t('执行失败'),
      '',
      true,
      true,
    )
  }
  host.task.status = answered ? 'done' : r.stopped ? 'stopped' : 'failed'
  host.changed(true)
}

/**
 * 执行一轮：
 * - 对话模式直接发给对应 Agent
 * - 工作流模式由常驻编排器（`@main`）负责：这次运行还没走完就按流程图接着执行；
 *   走完了就把用户的新要求交给它，由它决定起一次新的运行、重跑，还是直接回答
 */
export async function runEngineTurn(host: EngineHost) {
  const { task } = host
  task.status = 'running'
  // 又开了一轮：上一轮停下的原因不再成立（不然图标一直挂在暂停 / 中断上）
  task.stopReason = undefined
  // 预算按每次执行算：从这一轮开始时的用量起算（时长也从这里开始）
  task.budgetFrom = {
    usd: task.usage.costUsd,
    tokens: task.usage.inputTokens + task.usage.outputTokens,
    at: Date.now(),
  }
  // 旧版对话里的常驻编排器不再工作：记录留着可以看，但不再参与执行
  for (const s of task.steps) if (isMainStep(s) && s.status !== 'done' && s.status !== 'skipped') s.status = 'skipped'
  host.changed(true)

  // 新架构里项目对话都是对话：Agent 自己决定直接执行，还是用 start_plan 启动工作流
  if (task.mode === 'chat') return runConversationTurn(host, task.agentId)

  const wf = host.workflow
  const run = currentRun(task)
  const flow = taskFlow(task, wf)
  let tops = topSteps(task)
  if (task.mode === 'workflow' && flow && !task.flowClosed) {
    // 任务开始后工作流改过：已经不在流程图里的节点不会再执行，标成跳过，免得这次运行永远「没跑完」
    const live = reachable(flow)
    for (const s of tops) if (s.status !== 'done' && !live.has(s.nodeId)) s.status = 'skipped'
    if (!tops.length && !live.size)
      return finish(host, {
        ok: false,
        error: t('工作流的主流程还没有连到「开始」的节点，请先在流程图里从「开始」连线'),
      })
  }
  const dispatching = !!wf && !!flow && dispatches(wf, flow)
  // 流程停在某个节点的结论上（例如前置检查不通过）：继续流程时从它重新检查；追加要求先交给主 Agent 处理，再接着走
  const blocked = task.mode === 'workflow' ? blockedStep(task, flow) : undefined
  if (blocked && host.resume) reopenFlow(task, blocked)
  const unfinished =
    task.mode === 'workflow' &&
    !task.flowClosed &&
    (tops.length === 0 || tops.some((s) => s.status !== 'done' && s.status !== 'skipped'))

  /** 按流程图执行第 n 次运行（没完成的节点接着做）；input 是编排器为这次运行补充的要求 */
  const runWorkflow = async (n: number, input = ''): Promise<boolean> => {
    // 旧版工作流任务没有运行记录：这里补一条，节点共享状态和消息按运行保存
    const rec = wf ? ensureTaskRun(host, wf, n) : undefined
    if (rec) {
      rec.status = 'running'
      rec.endedAt = ''
    }
    const inv: Invocation = {
      workflow: wf!,
      flow: flow!,
      parentId: '',
      slot: '',
      round: 0,
      input,
      depth: 0,
      run: n,
    }
    if (dispatching) inv.main = openMain(host, inv)
    const r = await runInvocation(host, inv)
    if (rec) {
      rec.status = r.ok ? 'done' : r.stopped ? 'stopped' : 'failed'
      rec.endedAt = now()
    }
    if (!r.ok) {
      finish(host, r)
      return false
    }
    const stuck = blockedStep(task, flow)
    if (stuck)
      system(
        host,
        t(
          '流程停在「{title}」：结论是不通过，后面的节点没有执行。可以输入要求让主角色处理，处理完会自动接着走流程；也可以点「继续流程」重新检查。',
          { title: stuck.title },
        ),
        '',
        false,
        true,
      )
    return true
  }

  /** 起一次新的运行：节点全部新建（只复用编排器的会话），按流程图执行 */
  const newRun = async (input: string): Promise<boolean> => {
    const n = run + 1
    task.runSeq = n
    task.flowClosed = false
    // 新一次运行的节点：编排器还是原来那个，其余全部新建
    const fresh = planTask(wf, n).steps.filter((s) => !isMainStep(s))
    for (const s of fresh) if (!task.steps.some((x) => x.id === s.id)) task.steps.push(s)
    if (input) system(host, t('主角色起了第 {n} 次运行：{input}', { n, input: clip(input, 300) }), '')
    tops = topSteps(task)
    host.changed(true)
    return runWorkflow(n)
  }

  // 新对话的第一条要求先交给常驻编排器分析，由它决定要不要起运行；没有编排器的单节点工作流照旧直接执行。
  // 新建任务时节点已经按流程排好（都是待执行），第一次运行还没开始
  const first =
    task.mode === 'workflow' &&
    !!wf &&
    !!flow &&
    dispatching &&
    !task.flowClosed &&
    run === 1 &&
    tops.every((s) => s.status === 'pending')

  if (first) {
    const inv: Invocation = { workflow: wf!, flow: flow!, parentId: '', slot: '', round: 0, input: '', depth: 0, run }
    // 前面已经直接回答过几条时，这次不是这个对话的第一条要求
    const replanned = (mainStep(task)?.rounds ?? 0) > 0
    const main = openMain(host, inv)
    const turn = host.prewarm ? undefined : beginTurn(task, host.newId(), host.prompt, main.step.agentId)
    if (turn) host.changed(true)
    const r = await mainTurn(host, main, 'plan', firstPlanEvent(host.prompt, !replanned))
    if (turn) endTurn(task, turn, r.ok ? 'done' : r.stopped ? 'stopped' : 'failed', Date.now(), host.stopReason?.())
    if (!r.ok) {
      if (host.prewarm) {
        task.status = r.stopped ? 'stopped' : (host.prewarmFrom ?? 'done')
        return
      }
      return finish(host, r)
    }
    const d = parseDispatch(r.text) ?? { action: 'answer' as const }
    main.step.output = clip(stripDispatch(r.text).trim(), MAX_OUTPUT)
    host.changed(true)
    // 编排器用工具直接要求的运行（run_workflow）优先，其次才是 dispatch 里的决定
    const asked = takePendingRun(host)
    const input = asked || (d.action === 'run' ? (d.input ?? '') : d.action === 'restart' ? d.feedback : '')
    if (asked || d.action === 'run' || d.action === 'restart') {
      if (input) system(host, t('主角色起了第 {n} 次运行：{input}', { n: run, input: clip(input, 300) }), main.step.id)
      if (!(await runWorkflow(run, input))) return
    } else {
      system(host, dispatchText(d, t('第一条要求')), main.step.id)
      host.changed(true)
    }
  } else if (task.mode === 'workflow' && wf && flow && unfinished) {
    if (!(await runWorkflow(run))) return
  } else if (task.mode === 'workflow' && unfinished) {
    return finish(host, { ok: false, error: t('工作流不存在，可能已被删除') })
  } else if (task.mode === 'workflow' && wf && flow && dispatching) {
    // 这次运行已经走完：新要求交给常驻编排器，由它决定起新运行、重跑还是直接回答
    const inv: Invocation = { workflow: wf, flow, parentId: '', slot: '', round: 0, input: '', depth: 0, run }
    const main = openMain(host, inv)
    const turn = host.prewarm ? undefined : beginTurn(task, host.newId(), host.prompt, main.step.agentId)
    if (turn) host.changed(true)
    const r = await mainTurn(host, main, 'plan', planEvent(host.prompt, run, blocked ?? undefined))
    if (turn) endTurn(task, turn, r.ok ? 'done' : r.stopped ? 'stopped' : 'failed', Date.now(), host.stopReason?.())
    if (!r.ok) {
      if (host.prewarm) {
        task.status = r.stopped ? 'stopped' : (host.prewarmFrom ?? 'done')
        return
      }
      return finish(host, r)
    }
    const d = parseDispatch(r.text) ?? { action: 'answer' as const }
    main.step.output = clip(stripDispatch(r.text).trim(), MAX_OUTPUT)
    system(host, dispatchText(d, t('这次要求')), main.step.id)
    host.changed(true)
    // 编排器用工具直接要求的运行（run_workflow）优先，其次才是 dispatch 里的决定
    const asked = takePendingRun(host)
    if (asked) {
      if (!(await newRun(asked))) return
    } else if (d.action === 'run' || d.action === 'restart') {
      if (!(await newRun(d.action === 'run' ? (d.input ?? '') : d.feedback))) return
    }
  } else {
    const who = host.workflow?.mainAgentId ?? topSteps(task)[0]?.agentId ?? ''
    // 追加要求（工作流关掉了调度时）：续接主 Agent 最近执行过的节点
    if (task.mode === 'workflow' && !task.sessions[who]) {
      const last = [...task.steps].reverse().find((s) => s.agentId === who && task.sessions[s.id])
      if (last) task.sessions[who] = task.sessions[last.id]
    }
    // 没选主角色（例如自带的「默认」工作流）时直接用默认 CLI 回答，不带角色设定
    // 每一轮单独记耗时和用量，任务进度里能看到工作流跑完后的追加要求；预热不算一轮
    const turn = host.prewarm ? undefined : beginTurn(task, host.newId(), host.prompt, who)
    if (turn) host.changed(true)
    const r = await host.runAgent({
      agentId: who,
      prompt: followUpPrompt(host, blocked),
      sessionKey: who,
      // 工作流任务的追加要求也走默认 CLI 的档位，和节点一致
      ...(task.mode === 'workflow' ? { tier: '' as NodeTier } : {}),
      ...(host.prewarm ? { prewarm: true } : {}),
    })
    if (turn) endTurn(task, turn, r.ok ? 'done' : r.stopped ? 'stopped' : 'failed', Date.now(), host.stopReason?.())
    // 预热失败（CLI 没装好、会话续不上等）不算这一轮：回到原来的状态，等用户发消息时再按正常流程报错
    if (!r.ok) {
      if (host.prewarm) {
        task.status = r.stopped ? 'stopped' : (host.prewarmFrom ?? 'done')
        // 列表时间留给收尾恢复，不要因为预热失败改成现在
        return
      }
      return finish(host, r)
    }
    // 处理完停住流程的问题：从停住的节点重新检查，接着走后面的流程
    if (blocked && wf && flow && blockedStep(task, flow) === blocked) {
      reopenFlow(task, blocked)
      system(host, t('处理完了，从「{title}」重新检查，接着走流程', { title: blocked.title }))
      host.changed(true)
      if (!(await runWorkflow(run))) return
    }
  }
  // 预热没有处理新消息：不标完成、不刷新列表时间，交给 start 收尾恢复
  if (host.prewarm && (task.turnDoneAt ?? '') === host.prewarmTurnDoneAt) return
  // 编排器这一轮忙完了：标成完成只表示它空闲，会话还在，下一条要求接着用同一个会话
  const idle = mainStep(task)
  if (idle?.status === 'running') {
    idle.status = 'done'
    idle.endedAt = now()
  }
  task.status = 'done'
  host.changed(true)
}
