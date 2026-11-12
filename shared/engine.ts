/**
 * 执行引擎：按流程图调度节点，真实执行和模拟执行共用。
 * - 从「开始」出发，上游全部完成才执行，没有依赖的节点同时执行；节点可挂开始 / 验收 / 结束流程，也可以整个就是另一个流程
 * - 每个节点在 task.steps 里有一条记录，id 是路径（`n1/review.2/n5`），也是 CLI 会话键；续跑时已完成的节点直接复用输出
 * - 没有主 Agent（design.md D1）；节点执行中可以经编排工具（Orchestra，真实执行由 server/orch-mcp.ts
 *   交给 CLI）派子 Agent 并行、查状态、传话，派出的子 Agent 挂在节点下面（`n1/sub/h1`）
 * - 工作流只由父对话启动，是一次独立的运行（不是子对话，见 flow-run.ts、flow-run-turn.ts、flow-run-orch.ts）
 * 怎么调用一个 Agent 由宿主决定（server/exec/runner.ts 调用 CLI，shared/runner.ts 生成示例输出）。
 */

import type { OrchCtx, OrchOpts } from './orchestra/ctx.ts'
import { planTools } from './orchestra/plan-tools.ts'
import { conversationTools } from './orchestra/conversation-tools.ts'
import { capabilityTools } from './orchestra/capability-tools.ts'
import { recordRoute } from './orchestra/route.ts'

import { commonAgents, includedAgents, mountedAgents, paramsProblem } from './agent-role.ts'
import { INLINE_EDIT_MAX_FILES, INLINE_EDIT_MAX_LINES } from './inline-edit.ts'
import {
  END,
  START,
  type Agent,
  type AlertKind,
  type Flow,
  type FlowNode,
  type FlowEdge,
  type FlowRef,
  type NodeStep,
  type NodeTier,
  type ParamValues,
  type Task,
  type TaskStep,
  type TurnSources,
  type Workflow,
} from './schema.ts'
import {
  blankStep,
  flowLabel,
  nodeAgent,
  nodeSteps,
  parallelTo,
  preds,
  reachable,
  resolveRef,
  runPrefix,
  stepTree,
  isMainStep,
} from './flow.ts'
import { t } from './i18n.ts'
import { clip } from './text.ts'
import { runRecord, runTextTooLong, sendRunMessage } from './run-state.ts'
import { clipToFile, layeredBatch, WHOLE_OUTPUT } from './helper-batch.ts'
import { runsSection, workflowCatalogText } from './flow-run.ts'
import { runFlowRunTurn } from './flow-run-turn.ts'
import { runTools } from './flow-run-orch.ts'

import { runWithSummary } from './helper-summary.ts'
import * as rs from './run-stops.ts'
import { fixRoutePart } from './fix-route.ts'
import { bugRoutePart } from './bug-route.ts'
import { cherryPickPart } from './cherry-pick.ts'
import { orchAskPush } from './push-auth.ts'
import { docRootText, plainDocRootText } from './doc-root.ts'
import { makeAlert } from './alerts.ts'
import { promptLangRules, promptLangWord, VERDICT_LINE } from './prompt-lang.ts'
import { summaryCardRules, summaryDetailRules } from './summary-card.ts'
import { ensureVerdict, reviewVerdict, submitOn, verdictOf, type Blocker } from './submitted.ts'

import { beginTurn, endTurn, pauseStep, stopReasonText } from './task.ts'
import { chatRoleFor, findRole, isChatMode, modeScope, scopeOf, turnRole } from './conv-mode.ts'
import { backgroundPart, chatConversationPrompt } from './chat-prompt.ts'
import {} from './builtin/default.ts'
import { LIVE, nextSent, type PromptSent, promptDelta, promptSources, rememberSent } from './prompt-delta.ts'
import { isHelperAgent } from './builtin/core.ts'
import { childAskPrompt } from './child-ask.ts'
import { topPush } from './sub-policy.ts'
import { budgetLimit, overBudget } from './engine-budget.ts'
// 各节点共用的提示词段落拆在 engine-prompt-parts.ts，编排工具背后的状态和子任务收口拆在 engine-helpers.ts
import {
  SLOT_PROMPT,
  buildPart,
  commonPart,
  editPart,
  goalPart,
  inboxPart,
  p4Part,
  parentRunsIn,
  planPart,
  policyPart,
  reviewCommonPart,
  rulesPart,
  searchPart,
  verifyPart,
  wrapDone,
  wrapKind,
  wrapUpPart,
} from './engine-prompt-parts.ts'
import {
  MAX_HELPERS_PER_STEP,
  MAX_RESUME_IDS,
  REVIEW_SOFT_LIMIT_MS,
  REVIEW_WRAP_NOTE,
  briefMissing,
  briefPart,
  helperLabel,
  helperOver,
  helperReport,
  orchState,
  putMail,
  resumeTarget,
  reviewPart,
  reviewsCode,
  settleHelperBatch,
  settleHelperWaits,
  settleHelpers,
  statusTree,
  takeMail,
  wholeReport,
} from './engine-helpers.ts'
export { nodeRequests } from './engine-prompt-parts.ts'
export { settleHelperWaits } from './engine-helpers.ts'
import type { AgentResult, Fail, AgentCall, HelperSpec, HelperBatch, Orchestra, EngineHost } from './engine-host.ts'
export type {
  AgentResult,
  Fail,
  AgentCall,
  ReviewDiff,
  RouteInput,
  HelperSpec,
  ReviewBrief,
  HelperReport,
  HelperBatch,
  Orchestra,
  P4SplitArgs,
  EngineHost,
  LessonInput,
} from './engine-host.ts'

import { bindWait, finishStepNow, WRAP_UP } from './plan.ts'

/** 子任务、工作流运行的终止开关在 run-stops.ts：服务端路由从这里取 */
export { stopHelper, stopPlan } from './run-stops.ts'
/** 查名下子对话（计划对上等待、补步骤的标题、判断是不是重试）在 child-lookup.ts */
export { retryBase } from './child-lookup.ts'

/** 内置「版本控制」角色的来源标记：独立分支里的子对话不派它收尾（见 spawn） */
const VCS_ORIGIN = 'builtin:vcs'

/** 节点提示词里节点自己的部分从这里开始，前面是同一个任务里各节点共用的部分 */
export const NODE_PART = '## 当前节点'

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

const MAX_DEPTH = 6
/** 父对话每轮提示里列出的已完成子对话个数（最近完成的几个），更早的用 list_conversations 查 */
const RECENT_DONE_CHILDREN = 8
const MAX_OUTPUT = 4000
const now = () => new Date().toISOString()

/** 节点 / 步骤的输出：太长时另存文件，交给下游的结果里写明去哪读；评审、验收（whole）要逐条处置，上限放宽 */
async function storeOutput(host: EngineHost, step: TaskStep, text: string, whole = false) {
  return clipToFile(host.saveHandoff, step, text, whole ? WHOLE_OUTPUT : MAX_OUTPUT, '开始之前请先读完。')
}

/** 一次流程调用：在哪个工作流的哪个流程，挂在哪个节点的哪个入口下 */
export interface Invocation {
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
}

export type FlowResult = { ok: true; output: string } | Fail

export { budgetLimit, overBudget }

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

// 执行上限（花费 / token / 时长）的判定在 engine-budget.ts

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
  // 做完了、停在等确认时被停下：结果原样还在，继续时直接回到确认，不重跑节点、不重新验收
  const atConfirm = !!step.awaitConfirm && !!node.hooks.confirm && !!host.confirm
  // 上次执行到一半被打断、CLI 会话还在：续接会话接着做，不从头再来
  const half = step.interrupted
  const resumeHalf = !atConfirm && half && !!host.task.sessions[step.id] && node.kind === 'agent'
  step.interrupted = false
  if (!resumeHalf && !atConfirm) {
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
    host.nodeNote?.() ?? '',
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
  const deciding = node.kind === 'agent' && branchy
  const orch = makeOrchestra(host, { workflow: inv.workflow, tier: node.tier }, step)

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
        signal: rs.planSignal(host),
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
    if (r.ok && (inv.slot === 'review' || deciding)) r = await ensureVerdict(r, step, (q) => call(q + tail))
    if (!r.ok) return r
    // 节点派出去的子 Agent 是它工作的一部分：等它们都结束；它自己没取回的结果并进节点的输出
    const late = await settleHelpers(host, step)
    return late ? { ok: true, text: `${r.text}\n\n## 子 Agent 的结果\n${late}` } : r
  }
  const rework = (agentText: string, flowText: string) => body(++bodyRound, node.kind === 'flow' ? flowText : agentText)
  const r = atConfirm ? { ok: true as const, text: step.output } : await body(0, '')
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
      // 结论只认验收流程里用 submit_verdict 交的（ADR 0041 第 16 节）；没交不算通过，按出错停下给用户看
      const verdict = reviewVerdict(host.task.steps, step.id, round)
      step.rounds = round
      if (!verdict)
        return {
          ok: false,
          error: t('「{title}」的验收流程没有用 submit_verdict 交结论，不能算通过', { title: step.title }),
        }
      step.verdict = verdict
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
            feedback: await clipToFile(host.saveHandoff, step, rv.output, 1500, '先读完。'),
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

  // 已经验收过的结果（回到确认、追问之后）不再验收一遍
  let reviewed = atConfirm
  for (;;) {
    const rf = reviewed ? null : await review()
    reviewed = false
    if (rf) return fail(rf)
    // 完成后等用户确认：通过就往下走；退回时带着意见返工，再验收、再确认
    if (!node.hooks.confirm || !host.confirm) break
    if (host.halted) return fail({ ok: false, halted: true, error: '' })
    // 先把结果和「停在等确认」落盘：这时被停下，继续时直接回到确认（见开头的 atConfirm）
    step.output = text
    step.awaitConfirm = true
    host.changed(true)
    const c = await host.confirm(step, text)
    if (!c) return fail({ ok: false, stopped: true, error: t('已停止') })
    step.awaitConfirm = false
    if (c.allow) break
    if (c.ask) {
      // 追问：只回答，不改已经做好的结果；回答接在结果后面，仍停在等确认，不算一轮修改
      const qa = await rework(
        `用户看了结果，有个问题想先问清楚（只回答问题，不要改动已经做好的结果）：\n${c.answer || ''}`,
        `用户追问：\n${c.answer || ''}`,
      )
      if (!qa.ok) return fail(qa)
      text = `${text}\n\n## 追问\n问：${c.answer || ''}\n\n答：${qa.text}`
      reviewed = true
      continue
    }
    const fb = await rework(
      `用户看了结果，要求修改：\n${c.answer || '（没有写具体意见）'}\n\n请按要求继续完善本节点「${step.title}」的工作，完成后同样简要总结。`,
      `用户看了上一轮的结果，要求修改：\n${c.answer || '（没有写具体意见）'}`,
    )
    if (!fb.ok) return fail(fb)
    text = fb.text
  }

  // 条件连线按节点用 submit_verdict 交的结论选路；没交不默认走「通过」，按出错停下（ADR 0041 第 16 节）
  if (deciding) {
    const v = verdictOf(step)
    if (!v)
      return fail({
        ok: false,
        error: t('「{title}」没有用 submit_verdict 交结论，不知道该走哪条分支', { title: step.title }),
      })
    step.branch = v
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

  // 架构方案、测试的失败清单经常比交接上限长：完整内容存成文件，交给下游的结果里写明去哪读
  step.output = await storeOutput(host, step, text)
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
  const deciding = branchy && units[units.length - 1].kind === 'agent'

  const records: TaskStep[] = []
  const texts: string[] = []
  const halves: boolean[] = []
  const bodyRounds = units.map(() => 1)
  const recordOf = (i: number) => {
    records[i] ??= ensureUnitStep(host, inv, node, step, units[i], i)
    return records[i]
  }
  const prepare = (i: number): 'skip' | 'go' | 'confirm' => {
    const unit = units[i]
    const r = recordOf(i)
    if (r.status === 'done') {
      texts[i] = r.output
      return 'skip'
    }
    // 上次停在等确认（面板重启、运行暂停）：结果还在，直接回到确认，不重跑也不重新验收
    if (r.awaitConfirm && unit.confirm && host.confirm) {
      texts[i] = r.output
      r.status = 'running'
      r.interrupted = false
      host.changed(true)
      return 'confirm'
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
        orch: makeOrchestra(host, { workflow: inv.workflow, tier: unit.tier }, r),
        signal: rs.planSignal(host),
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
    if (res.ok && (inv.slot === 'review' || decidingHere)) res = await ensureVerdict(res, r, (q) => call(q + tail))
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
      const verdict = reviewVerdict(host.task.steps, r.id, round)
      r.rounds = round
      if (!verdict)
        return {
          ok: false,
          error: t('「{title}」的验收流程没有用 submit_verdict 交结论，不能算通过', { title: r.title }),
        }
      r.verdict = verdict
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
            feedback: await clipToFile(host.saveHandoff, step, rv.output, 1500, '先读完。'),
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
  const confirmUnit = async (i: number): Promise<Fail | 'rework' | 'ask' | null> => {
    const unit = units[i]
    const r = recordOf(i)
    if (!unit.confirm || !host.confirm) return null
    if (host.halted) return { ok: false, halted: true, error: '' }
    // 等确认前先把结果和「在等确认」记下来：这时停了再继续，直接回到确认
    r.output = texts[i]
    r.awaitConfirm = true
    host.changed(true)
    const c = await host.confirm(r, texts[i])
    if (!c) return { ok: false, stopped: true, error: t('已停止') }
    r.awaitConfirm = false
    if (c.allow) return null
    if (c.ask) {
      const qa = await reworkText(
        i,
        `用户看了结果，有个问题想先问清楚（只回答问题，不要改动已经做好的结果）：\n${c.answer || ''}`,
        `用户追问：\n${c.answer || ''}`,
      )
      if (!qa.ok) return qa
      texts[i] = `${texts[i]}\n\n## 追问\n问：${c.answer || ''}\n\n答：${qa.text}`
      return 'ask'
    }
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
    const p = prepare(i)
    if (p === 'skip') continue
    if (host.halted) return fail({ ok: false, halted: true, error: '' }, recordOf(i))
    if (p === 'go') {
      const b = overBudget(host)
      if (b) return fail({ ok: false, stopped: true, budget: true, error: b }, recordOf(i))
      const r = await body(i, 0, '')
      if (!r.ok) return fail(r, recordOf(i))
      texts[i] = r.text
    }
    // 追问只回答问题、不改结果，不用重新验收；接着等确认
    let reviewed = p === 'confirm'
    for (;;) {
      const rf = reviewed ? null : await reviewUnit(i)
      reviewed = false
      if (rf) return fail(rf, recordOf(i))
      const cf = await confirmUnit(i)
      if (cf === 'ask') {
        reviewed = true
        continue
      }
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

  // 条件连线按最后一步用 submit_verdict 交的结论选路；没交按出错停下
  if (deciding) {
    const v = verdictOf(recordOf(units.length - 1))
    if (!v)
      return fail(
        { ok: false, error: t('「{title}」没有用 submit_verdict 交结论，不知道该走哪条分支', { title: step.title }) },
        recordOf(units.length - 1),
      )
    step.branch = v
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
  }
  return runFlow(host, inv)
}

// ---- 编排工具：派子 Agent、查状态、提问、传话 ----

function makeOrchestra(host: EngineHost, ctx: OrchOpts, self: TaskStep): Orchestra {
  const st = orchState(host)
  const { task } = host
  const helper = !!ctx.helper
  // 调用者自己的角色：挂了哪些能力、能不能就地改动都看它（节点、子任务用的是基本角色，没有挂载）
  const selfAgent = self.agentId ? host.agents.find((a) => a.id === self.agentId) : undefined
  // 能力由 Agent 配置决定：canPlan 才能启动计划，canDelegate 才能分派子对话。
  // 旧的常驻编排器（@main）还能看到，但它们不会出现在新对话里。子任务一样都没有
  const planner = !helper && (!!ctx.planning || (isMainStep(self) && !self.parentId))
  const coordinator = !helper && !!ctx.coordinator
  // Chat 模式的上限（ADR 0038）：不派子任务、没有并行的节点可传话；工具按 canSpawn / team 给，不再认「是不是 Chat 页」
  const chatMode = !!ctx.chat && isChatMode(task)
  // 对话的工具调用不属于任何节点：系统消息不挂 step，免得被当成一次运行的节点输出
  const where = self.id === CHAT_STEP ? '' : self.id
  const findStep = (key: string) => {
    const k = key.trim()
    return (
      task.steps.find((s) => s.id === k) ??
      task.steps.find((s) => s.title === k && s.status === 'running') ??
      task.steps.find((s) => s.title === k)
    )
  }
  const oc: OrchCtx = { host, ctx, self, st, task, helper, selfAgent, planner, coordinator, chatMode, where, findStep }
  return {
    self: self.id,
    planner,
    common: commonAgents(host.agents)
      .filter((a) => a.id !== self.agentId && !(host.isolated && a.origin === VCS_ORIGIN))
      .map((a) => ({ name: a.name, description: a.description })),
    helper,
    ...(where && {
      submitVerdict: (v: { verdict: 'pass' | 'fail'; blockers?: Blocker[] }) =>
        submitOn(self, { verdict: v.verdict, blockers: v.blockers ?? [] }, () => host.changed(true)),
    }),
    ...(helper && {
      submitResult: (r: { state: 'done' | 'unfinished' | 'stuck'; summary: string; left: string }) =>
        submitOn(self, r, () => host.changed(true)),
    }),
    canSpawn: !helper && !chatMode,
    team: !chatMode,
    autoReturn: !!ctx.chat && !helper,
    // 对话（含它派出的子任务）用不到共享状态：对话里跑过工作流之后 task.runs 会残留上一次运行，
    // 只看 runs 会把工具又注册回来，读到的还是上一次运行的 state
    sharedState: !ctx.chat && !!runRecord(task),
    planning: !!ctx.planning && coordinator,
    runs: runTools(task, host.runs, !helper && !!ctx.planning && coordinator, () => host.changed(true)),
    plans: !!ctx.chat && !helper && !!task.projectId,
    coordinator,
    // 挂了能力的高级角色就地用能力：取能力的完整做法（子任务只做派给它的那件事，不加载别的能力）
    capabilities: !helper && !!selfAgent && mountedAgents(selfAgent, host.agents).length > 0,
    inlineEdit: coordinator && !!host.inlineEdit && selfAgent?.inlineEdit === 'tiny',
    // 子任务的结果只交回派它的对话，不直接和父对话通讯、不认领文件（推回的结果由同一个对话处理）
    child: !helper && !!task.parentTaskId && !!host.messageParent,
    claims: !helper && !!host.claimFiles,
    // 子任务也能用后台命令：命今跑在同一个对话的目录里、结果也推回同一个对话，只是记录上带自己的步骤 id，
    // 运行区据此按「子任务 + 命令名」单独列出（见 web/src/components/tasks/RunningNow.tsx）
    canBackground: !!host.runBackground,
    canSubmit: !helper && !!host.submitMerge,
    isolated: !!host.isolated,
    // 只有对话自己能开：派出去的子角色、计划里的节点中途换目录，会和对话本身对不上
    canBeginEdit: !!host.beginEdit && !!ctx.chat && !self.parentId,
    ueBuild: !helper && ctx.chat && host.ueBuild ? host.ueBuild.role : '',
    parentOf: !helper && !!ctx.chat && !!host.finishChild,
    peers: !helper && !!ctx.chat && !!host.peers,
    p4Split: host.p4Split,
    cherryPick: helper || host.task.parentTaskId ? undefined : host.cherryPick,
    askPush: orchAskPush(host, !!ctx.chat, helper),
    remember: !helper && isChatMode(task) ? host.chatMemory?.remember : undefined,
    status: () => statusTree(host, self.id),
    // 按派发 / 计划 / 对话 / 能力分组的工具（shared/orchestra/*.ts、本文件的 dispatchTools）
    ...planTools(oc),
    ...conversationTools(oc),
    ...capabilityTools(oc),
    ...dispatchTools(oc),
  }
}

/** 派发类工具：派子任务、终止、等结果、交回的批次、给节点传话、收件箱 */
function dispatchTools(oc: OrchCtx) {
  const { host, self, st, task, helper, where, findStep } = oc
  return {
    spawn: (...a: Parameters<Orchestra['spawn']>) => spawn(oc, ...a),
    helperBatch() {
      const going = st.batches.get(self.id)
      if (going) return going
      const kids = () => task.steps.filter((s) => s.parentId === self.id && s.slot === 'sub')
      if (!kids().some((k) => !st.delivered.has(k.id) && st.helpers.has(k.id))) {
        // 没有要交回的结果（这一轮结束时也走这里）：顺手收掉计划里等着已经结束的子任务的等待项。
        // 别的路径漏收（老数据、被打断后直接终止的）时，这是最后一道：不收的话那一步永远「等待中」，面板不再推它
        settleHelperWaits(host)
        return undefined
      }
      const batch = settleHelperBatch(host, self).then(({ text: late, ids }): HelperBatch => {
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
            // 个数按交回的子任务记：正文里子任务自己的输出也会带「### 」小标题，按标题数会多算
            results: ids,
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
    stopHelpers(ids, why) {
      if (helper) return { ok: false, info: '子任务不能终止别的子任务' }
      const mine = task.steps.filter((s) => s.parentId === self.id && s.slot === 'sub')
      const want = ids.length
        ? ids.map((id) => mine.find((s) => s.id === id || s.title === id))
        : mine.filter((s) => s.status === 'running' || s.status === 'pending')
      const missing = ids.filter((_, i) => !want[i])
      const [done, over]: string[][] = [[], []]
      for (const s of want) {
        if (!s) continue
        if (rs.stopHelper(task.id, s.id, why) || rs.dropInterrupted(s, why)) done.push(`${s.id}｜${s.title}`)
        else over.push(`${s.id}｜${s.title}`)
      }
      if (done.length) {
        // 被打断、没在跑的子任务这里直接记成已终止，不会再有一批结果交回（helperBatch 只收还在跑的），
        // 计划里等它的那一步只能在这里收口：不收的话那一步永远「等待中」，planStalled 当它在等别人不推，
        // 子对话的阶段汇报也被「没做完不报」吞掉，父子互等到用户来问（用户 2026-11-12 报，第二次）
        settleHelperWaits(host)
        host.changed(true)
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
    async wait(ids, ms, signal) {
      const mine = ids.length
        ? ids
        : task.steps.filter((s) => s.parentId === self.id && s.slot === 'sub').map((s) => s.id)
      const steps = mine.map((id) => task.steps.find((s) => s.id === id)).filter((s): s is TaskStep => !!s)
      // 上限的定时器等完要清掉：一次可能挂 25 分钟，留着会让进程（和测试）白等到点
      let timer: ReturnType<typeof setTimeout> | undefined
      const cap = new Promise<void>((r) => (timer = setTimeout(r, ms)))
      const woken = new Promise<void>((r) => {
        st.wakers.set(self.id, r)
        if (signal?.aborted) r()
        else signal?.addEventListener('abort', () => r())
      })
      const waiting = () =>
        Promise.race([Promise.all(steps.map((s) => st.helpers.get(s.id) ?? Promise.resolve())), cap, woken])
      await (host.yieldSlot ? host.yieldSlot(self.id, waiting) : waiting()).finally(() => {
        clearTimeout(timer)
        st.wakers.delete(self.id)
      })
      const over = (s: TaskStep) => helperOver(host, s)
      // 取过的不再交：以前每次都把做完的全部重交一遍，派 6 个分 4 次取完，交回的字数是结果本身的 2.5 倍。
      // CLI 已经断开（工具超时、进程被停）时不算取走，留给下一次或节点结束时并进输出
      const taken = steps.filter((s) => over(s) && st.delivered.has(s.id)).length
      const done = signal?.aborted ? [] : steps.filter((s) => over(s) && !st.delivered.has(s.id))
      for (const s of done) st.delivered.add(s.id)
      // 手动取走结果的路径：helperBatch 的入口只看「还没取走的子任务」，取走后就轮不到 settleHelpers，
      // 计划里等它们的那一步会永远停在等待中。这里直接收口（成功标完成、失败退回进行中）
      if (done.length) settleHelperWaits(host)
      const outputs = await layeredBatch(host.saveHandoff, done, wholeReport(host))
      return {
        done: done.map((s) => ({ ...helperReport(host, s), ...(outputs.has(s.id) && { output: outputs.get(s.id) }) })),
        running: steps.filter((s) => !over(s)).map((s) => helperReport(host, s)),
        taken,
      }
    },
    // 工作流没有主 Agent 了（用户 2026-11-05 定）：要人拿主意的事写进结果，节点设了确认时由用户在工作流卡片上确认
    ask: async () => ({
      error: '工作流没有主 Agent：自己判断，需要用户决定的事写进结果里（节点设了确认时会交给用户确认）',
    }),
    async send(to, text) {
      const target = findStep(to)
      if (!target) return { ok: false, info: `找不到「${to}」，用 get_status 看节点 id` }
      if (target.id === self.id) return { ok: false, info: '不能发给自己' }
      if (target.status === 'done' || target.status === 'failed' || target.status === 'skipped')
        return { ok: false, info: `「${target.title}」已经结束了，消息没有送到` }
      const over = runTextTooLong(text.trim(), '消息')
      if (over) return { ok: false, info: over }
      const body = `来自「${self.title || '对话'}」的消息：${text.trim()}`
      // 先记进这次运行，界面和重启后都能看到；交给正在跑的节点时再标成已读，避免它重复看到。
      // 不再另 push 一条 system 消息：发件方已经有「发送消息」工具行（正文可展开），再铺一条居中块会把整段正文摊在对话流里
      const kept = sendRunMessage(host, where, target.id, body)
      host.changed(true)
      st.wakers.get(target.id)?.()
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
  } satisfies Partial<Orchestra>
}

/** spawn_agents：派子任务（在原记录里续跑失败的、按层次分批、给版本控制收尾留规则） */
function spawn(oc: OrchCtx, ...[tasks, step, opts]: Parameters<Orchestra['spawn']>): ReturnType<Orchestra['spawn']> {
  const { host, ctx, self, st, task, helper, selfAgent, coordinator, where } = oc
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
  if (host.isolated) {
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
    const named = want ? findRole(host.agents, want, modeScope(host.task)) : undefined
    if (named && scopeOf(named) === 'chat')
      return {
        ids: [],
        error: `「${named.name}」是 Chat 角色，只能在 Chat 页用${available ? `：可以点名 ${available}` : ''}`,
      }
    if (want && !named)
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
  // 转交父对话创建（见 ADR 0019）。判定放引擎里：对话、工作流节点、计划面板定时任务的 spawn 都走这里，放 orch-mcp 会漏
  const local = list.filter((spec) => {
    if (opts?.local || !host.task.parentTaskId) return true
    const want = spec.agent?.trim()
    if (mountOf(want)?.mode === 'parent') return false
    return !want || findRole(host.agents, want, modeScope(host.task))?.runIn !== 'parent'
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
  const blocked = rs.interruptedBlock(mine, local.length - resumed.size, resumed)
  if (blocked) return { ids: [], error: blocked }
  // 派出去的角色：接着的子任务原来的角色（被删了才落到点名的）→ 点名的 → 默认「子任务」→ 发起者自己
  const roleOf = (spec: HelperSpec) => {
    const prev = resumed.get(spec)
    const want = spec.agent?.trim()
    return (
      (prev && host.agents.find((a) => a.id === prev.agentId)) ||
      (want && findRole(host.agents, want, modeScope(host.task))) ||
      helperRole ||
      host.agents.find((a) => a.id === self.agentId)
    )
  }
  // 角色参数：挂载上定的垫底，接着的子任务沿用上一次的，这次写的最优先；只认角色声明过的 key 和选项
  const paramsOf = new Map<HelperSpec, ParamValues | undefined>()
  for (const spec of local) {
    const role = roleOf(spec)
    const bad = role && spec.params ? paramsProblem(role.name, role.params, spec.params) : ''
    if (bad) return { ids: [], error: bad }
    const mount = mounts.find((m) => m.agent.id === role?.id)?.params
    const merged = { ...mount, ...resumed.get(spec)?.params, ...spec.params }
    paramsOf.set(spec, Object.keys(merged).length ? merged : undefined)
  }
  // 第一次派评审代码改动：交接单必须带需求和跑过的检查（ADR 0013）。
  // 评审只看改动的代码，这些背景只有派它的对话有；不交，评审就会自己读文档、搜项目去还原，一次评审拖到二十多分钟
  for (const spec of local) {
    if (resumed.has(spec)) continue
    const want = spec.agent?.trim()
    const role = want ? findRole(host.agents, want, modeScope(host.task)) : undefined
    if (!reviewsCode(role, paramsOf.get(spec))) continue
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
      const repl = want ? findRole(host.agents, want, modeScope(host.task)) : undefined
      if (repl && repl.id !== prev.agentId) prev.agentId = repl.id
      prev.params = paramsOf.get(spec)
      const tier = (['high', 'medium', 'low'].includes(spec.tier ?? '') ? spec.tier : ctx.tier) as NodeTier
      return { step: prev, spec, tier, again: again || '上次没有做完' }
    }
    const agent = roleOf(spec)
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
      params: paramsOf.get(spec),
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
}

/** 失败、被终止、被中断的子任务：spawn_agents 的 resume 写它时在原来那条记录里重试 */
const retriable = (s: TaskStep) =>
  s.status === 'failed' || s.status === 'skipped' || (s.status === 'pending' && !!s.interrupted)

/** 执行一个派出的子 Agent */
async function runHelper(
  host: EngineHost,
  ctx: { workflow?: Workflow; tier: NodeTier; chat?: boolean; coordinator?: boolean },
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
  const key = rs.helperKey(host.task.id, step.id)
  rs.helperStops.set(key, ac)
  /** 被终止了：记成跳过，原因交回给派它的对话（见 settleHelpers） */
  const stopped = () => {
    if (rs.pausedSignal(ac.signal)) return void (rs.pauseUnit(step), host.changed(true))
    // 交回给派它的对话看的说明，不翻译
    st.errors.set(step.id, `已终止：${String(ac.signal.reason || '没写原因')}`)
    rs.cancelUnit(step)
    host.changed(true)
  }
  // 派出就开跑，不按任务限数排队（用户要求）：一个节点最多派几个由 spawn 的 MAX_HELPERS_PER_STEP 管，
  // 真要限流用 API 设置里的并发上限（server/api-slots.ts），那是按厂家限流各算各的
  try {
    if (ac.signal.aborted) return stopped()
    // 工作流被叫停、还没开始的：暂停（被打断），继续时能 resume 它；不然停在「待做」既不能接着做、也挡不住另派
    if (host.halted) return rs.pauseUnit(step)
    step.status = 'running'
    step.startedAt = now()
    host.changed(true)
    const role = host.agents.find((a) => a.id === step.agentId)
    const vcs = role?.origin === VCS_ORIGIN
    const reviewing = reviewsCode(role, step.params)
    const review = await reviewPart(host, step, spec)
    const parts = [
      // 评审代码只要需求和必须遵守的规则：搜索范围、编译和收尾、授权这些段落是写给要动手的角色的，
      // 给评审只会引着它去搜项目、跑检查（ADR 0013）
      ...(reviewing ? reviewCommonPart(host) : commonPart(host, ctx.workflow, !!ctx.chat, !vcs, vcs)),
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
      `## 要求\n只完成上面这件事，不要做发起节点的其他工作。${reviewing ? `完成后用${promptLangWord()}简要总结结果，结果会交回给派你的 Agent。` : `最后调用 submit_result 工具交结果：state 写 done（做完）、unfinished（没做完）或 stuck（做不下去），summary 写结论和关键文件，没做完或卡住时 left 写还差什么、卡在哪。面板只按这个工具判断子任务做完没有，不看回复里写了什么；没做完就接着做，不要先交。回复本身用${promptLangWord()}写，会交回给派你的 Agent。`}\n交回时可能只带开头（全文另存文件）：先用几行写结论、关键文件和需要派你的 Agent 处理的事，细节放在后面。`,
    ].filter(Boolean)
    // 接着原来的子任务做（复看、重试）：会话里已经有需求和通用规则，只发新的和变了的段落（见 shared/prompt-delta.ts）
    const sessionKey = step.session || step.id
    const sent = host.task.promptSent?.[sessionKey]
    const full = parts.join('\n\n')
    const delta = promptDelta(parts, sent, host.task.sessions[sessionKey])
    // 评审到了软时限还没交卷：传话要它按已确认的交卷（CLI 不支持执行中补充时传不进去，不影响它继续）
    const wrap = reviewing
      ? setTimeout(() => void host.steer?.(step.id, REVIEW_WRAP_NOTE).catch(() => false), REVIEW_SOFT_LIMIT_MS)
      : undefined
    ;(wrap as { unref?: () => void } | undefined)?.unref?.() // 只有 Node 的定时器有 unref，在线演示（浏览器）里是数字
    // 这次调用里会话压缩过：规则只剩摘要，不记已发段落，下次接着做时发完整的
    let compacted = false
    const call: AgentCall = {
      step,
      agentId: step.agentId,
      prompt: delta ?? full,
      onCompacted: () => (compacted = true),
      ...(delta ? { fresh: full } : {}),
      // 接着之前的子任务时用它的会话（见 TaskStep.session），否则一个子任务一个会话
      sessionKey,
      tier,
      params: step.params, // 不传时 runner 按角色默认值渲染：「清理用例」会变回「跑验收」
      // 子任务的工具只剩查状态、读写共享状态、传话：不能再派子任务、启动工作流或开子对话。
      // chat 要透传：对话里的子任务用不上共享状态（跑过工作流后 task.runs 会残留上一次运行）
      orch: makeOrchestra(host, { workflow: ctx.workflow, tier, helper: true, chat: ctx.chat }, step),
      signal: ac.signal,
    }
    // 子任务按最后的总结判定做完：没交总结就在同一个会话里推一次；评审按验收结论判定，不看总结（见 helper-summary.ts）
    let r = await runWithSummary(host, step, call, () => clearTimeout(wrap), system, !reviewing)
    if (reviewing) r = await ensureVerdict(r, step, (q) => host.runAgent({ ...call, prompt: q, fresh: undefined }))
    if (!compacted && host.task.sessions[sessionKey] && (r.ok || r.stopped))
      host.task.promptSent = rememberSent(
        host.task.promptSent,
        sessionKey,
        nextSent(parts, host.task.sessions[sessionKey], !!delta, sent),
      )
    // 单独终止的：不管 CLI 怎么收的尾，都按终止交回（整个任务停止时 ac 没被触发，照旧走下面）
    if (ac.signal.aborted) return stopped()
    if (r.ok) {
      const late = await settleHelpers(host, step)
      // 评审、测试验收的输出常比交接上限长：完整内容和节点一样存成文件，交回的结果里写明去哪读（只截开头会丢意见）
      step.output = await storeOutput(host, step, late ? `${r.text}\n\n## 子 Agent 的结果\n${late}` : r.text, reviewing)
      step.status = 'done'
    } else {
      // 被停止的暂停（被打断）：报告和界面才能说清「这一轮被停了、结论没出来」，继续时在原记录里接着做
      if (r.stopped || r.halted) rs.pauseUnit(step)
      else {
        step.status = 'failed'
        st.errors.set(step.id, r.error)
        system(host, r.error || t('执行失败'), step.id, true)
      }
    }
    step.endedAt = now()
    host.changed(true)
  } catch (e) {
    // 启动 CLI 前后抛了异常（读配置、写文件、进程起不来）：不能让它往外冒。
    // 冒出去的话子任务一直停在执行中、没有任何输出，终止按钮又说它已经结束了；
    // 等它的对话也跟着抛错。按失败收口，原因照常显示并交回给派它的对话
    if (ac.signal.aborted) return stopped()
    const error = t('子任务没能执行：{error}', { error: (e as Error)?.message || String(e) })
    step.status = 'failed'
    st.errors.set(step.id, error)
    system(host, error, step.id, true)
    step.endedAt = now()
    host.changed(true)
  } finally {
    rs.helperStops.delete(key)
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
          runNode(host, inv, n, inv.flow.nodes.indexOf(n), upstream).then(
            (r) => {
              running.delete(n.id)
              if (r.ok) {
                const step = host.task.steps.find((s) => s.id === stepPath(inv, n.id))
                if (step?.branch) branch.set(n.id, step.branch)
                outputs.set(n.id, { title: title(n), text: r.output })
              } else {
                failures.push(r)
                host.halted = true
              }
            },
            // 节点里抛了异常（不是正常的失败结果）：也按失败收口并叫停其余分支。
            // 不接住的话 Promise.race 直接抛出去，任务记成失败、执行位释放，并行的另一支 CLI 却还在跑，
            // 之后把旧状态写回去盖掉新一轮
            (e: unknown) => {
              running.delete(n.id)
              failures.push({
                ok: false,
                error: t('节点「{title}」出错：{error}', {
                  title: title(n),
                  error: (e as Error)?.message ?? String(e),
                }),
              })
              host.halted = true
            },
          ),
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
  const unrun = nodes.filter((n) => !outputs.has(n.id) && !skipped.has(n.id))
  // 别处失败后这里没跑完：不能当成功返回
  if (host.halted && unrun.length) return { ok: false, halted: true, error: '' }
  // 没人叫停、却还有节点既没跑也没被跳过：它们在环上（互相等对方），永远等不到。
  // 画布连线时会拦环，但导入的、手改的、从库里装进来的工作流可能有环，不能当成功
  if (unrun.length)
    return {
      ok: false,
      error: t('工作流里有环，这些节点互相等待、一直没能开始：{nodes}。请在流程图里断开其中一条连线', {
        nodes: unrun.map((n) => `「${title(n)}」`).join('、'),
      }),
    }
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

/** 对话 Agent 的提示：这次的消息、可选工作流、子对话目录，以及分派规则 */
async function conversationPrompt(
  host: EngineHost,
  kind: 'top' | 'sub',
  planning: boolean,
  coordinator: boolean,
  /** 角色本身是做分派的（例如「协调器」），这次却不能分派：要明说角色设定里的分派规则不适用 */
  delegates = false,
  /** 父对话能就地做微小改动（角色开了 inlineEdit、宿主给了护栏） */
  inline = false,
  /** 这一轮的角色：角色设定里已经写过的规则不再由面板重复一遍 */
  agent?: Agent,
) {
  // 角色设定写着「用 create_conversation 分派」，执行方式又说没有这个能力：两条直接冲突，
  // Agent 要么空等分派、要么自己干又觉得违规。明确以执行方式为准
  const noDelegate = delegates
    ? '\n角色设定里用 list_conversations / create_conversation / send_to_conversation 分派子对话的规则这次不适用：这里没有这些工具，按上面的执行方式自己处理，不要假装已经分派。'
    : ''
  // Chat 模式另起一套（shared/chat-prompt.ts）：没有项目、子对话、工作流和面板计划
  if (kind === 'top' && isChatMode(host.task)) return chatConversationPrompt(host, [goalPart(host), rulesPart(host)])
  const catalog = host.workflowCatalog?.() ?? []
  const wt = host.task.worktree?.state === 'active' ? host.task.worktree : null
  const parts = [
    `## 用户这次的消息\n${host.prompt}`,
    promptLangRules(),
    [policyPart(host), docRootText(host.policy?.docs) || plainDocRootText(host.policy?.docRoot)]
      .filter(Boolean)
      .join('\n\n'),
    cherryPickPart(host),
    goalPart(host),
    rulesPart(host),
    searchPart(host),
    inboxPart(host),
    buildPart(host),
    ...verifyPart(host),
    fixRoutePart(host, coordinator),
    bugRoutePart(host, coordinator),
    editPart(host),
    backgroundPart(host),
    ...planPart(host, coordinator),
    wrapUpPart(host),
    p4Part(host),
    // 每轮的总结（shared/summary-card.ts）：子对话写详细 Markdown，其余写卡片，父对话的卡片标题链到子对话
    kind === 'sub' ? summaryDetailRules() : summaryCardRules(undefined, coordinator),
    // 对话模式没有共享状态工具：这里不注入（跑过工作流时 task.runs 里是上一次运行的旧状态）
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
      ? `提交留在这个分支上。计划的最后一步是「${WRAP_UP.push.title}」：那时先把它合回原分支（见下面「收尾：计划的最后一步」），再在原分支上推送并用 gh 合并到主干。`
      : '提交留在这个分支上，由用户决定合并还是丢弃。'
}不要自己切换 / 检出新分支；用户没要求时不要合并主分支${host.task.parentTaskId ? '（合并编译报冲突、面板让你把原分支合进来时除外）' : ''}。
不要把这个独立分支推送到远端${wrapKind(host) === 'push' ? `（推送归计划的最后一步「${WRAP_UP.push.title}」：合回原分支之后推送原分支并合并主干）` : '，用户明确要求之前一律不推'}。用户要求推送时，先把它合回原分支${
          host.task.parentTaskId
            ? '（调用 submit_merge，合进去后改动就在原分支上了）'
            : `（在原目录里 git merge --no-ff ${wt.branch}）`
        }，再在原目录${host.worktreeHome ? ` ${host.worktreeHome}` : ''}里推送原分支${wrapKind(host) === 'push' ? '并用 gh 合并到主干' : ''}。
${wt.baseBranch ? `这个分支从「${wt.baseBranch}」开出。` : ''}`
      : '',
    // 只有父对话（能分派、开了 canPlan）列可用工作流和启动规则；子对话不启动工作流，不列（ADR 0044）
    planning ? workflowCatalogText(catalog) : '',
    // 名下还没结束的工作流运行：每轮一行一个，父对话不用轮询就知道走到哪了
    planning && host.runs ? runsSection(await host.runs.list().catch(() => [])) : '',
  ]
  if (coordinator) {
    // 内置「协调器」的角色设定里已经有一整套更细的处理顺序、分诊表和派单写法（系统提示词里常驻），
    // 这两节再每轮发一遍只是重复；自建的统筹角色没有这些，照旧给
    const ownDispatch = agent?.origin === 'builtin:orchestrator'
    const dispatchRules = `## 这条消息怎么处理
1. 先判断它和现有子对话的关联强度：相关就调用 send_to_conversation，把消息交给最合适的那个子对话。
2. 现有子对话都不相关，要改代码、要排查问题或者要做较大的研究：调用 create_conversation 新建一个子对话，标题由你分析后起；子对话会自己列计划并执行。${inline ? '够得上就地微改动的（见上面）自己改，不开子对话；其余改动再小也交给子对话。' : '改动再小（一行、一个文案）也交给子对话。'}
3. 只是一般问题、讨论、查询：自己回答。
一条消息里有几件互不相关的事时拆开，分别交给不同的子对话，它们会同时执行。不要把同一件事发给多个子对话：用户的一条消息（连同用户定下的规则、约定）只交给关联最紧密的那一个子对话，和别的子对话手上的事无关就不转给它们；同一段话再交给别的子对话会被面板拒绝。子对话不能再创建子对话，子对话之间也不能直接通讯，需要配合时由你转达。

## 分派前只收集到模块为止
分派前花少量时间把方向找准就交出去，不要自己把问题分析到底：
- 找出这件事涉及的大体模块和入口文件（目录、主要文件），相关的文档（设计说明、AGENTS.md 里的约定、docs 里的说明）。
- 不去定位具体是哪一行、哪个函数出的错，不写修改方案的细节，不读完整个模块；这些交给子对话。
- message 里写：用户的原话和验收标准、现象 / 复现步骤 / 报错原文（有的话）、你找到的模块和入口文件、相关文档的路径。`
    const all = host.listConversations ? await host.listConversations() : []
    // 已完成的子对话只列最近几个：子对话越开越多，每一轮都把几十个早就做完的整份列一遍，
    // 父对话判断新消息交给谁时用不上那么早的；要找更早的用 list_conversations
    const done = all.filter((c) => c.resolved).sort((a, b) => (b.at > a.at ? 1 : b.at < a.at ? -1 : 0))
    const hidden = new Set(done.slice(RECENT_DONE_CHILDREN).map((c) => c.id))
    const list = all.filter((c) => !hidden.has(c.id))
    // 这一段按全文记指纹（shared/prompt-delta.ts），逐分钟变的「最后活动 N 分钟前」会让整段每轮重发，不放进来。
    // 卡住了面板会自动询问、重启（ADR 0036），父对话要看多久没输出时用 list_conversations 查
    parts.push(
      host.policy?.modules ?? '',
      `## 现有子对话\n${
        list.length
          ? list
              .map(
                (c) =>
                  `- ${c.id}｜${c.title}｜${c.busy ? '执行中' : c.status}${c.waiting ? `｜${c.waiting}` : ''}：${clip(c.summary, 200) || '（还没有结果）'}`,
              )
              .join('\n')
          : '（还没有子对话）'
      }${hidden.size ? `\n（另有 ${hidden.size} 个更早完成的子对话没列出，需要时用 list_conversations 查）` : ''}`,
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
- 推送与合并主干：子对话的分支和你的独立分支都不推。${
        wrapKind(host) === 'push'
          ? '到计划的最后一步时，按上面「执行目录」里说的先合回原分支，再推送原分支并用 gh 合并到主干。'
          : '按上面「授权情况」处理推送；没有授权时不推、不建 PR、不合并主干。'
      }`
    : `- 你就在项目目录的当前分支${host.branch ? `「${host.branch}」` : ''}上，不开独立分支。子对话从这个分支开出自己的独立分支，验证通过后合回这里。
- 推送与合并主干：子对话的分支不推。${
        wrapKind(host) === 'push'
          ? '由你在计划的最后一步推送当前分支并用 gh 合并到主干。'
          : '按上面「授权情况」处理推送；没有授权时不推、不建 PR、不合并主干。'
      }`
}
- 子对话报错、失败或被中断要重试：用 send_to_conversation 交回原来那个子对话，它在原来的会话里接着做，不要新建一个「（重试）」子对话。派出的子任务也一样：重试时 spawn_agents 的 resume 写原来那个子任务的 id。
- 子对话只剩合回时会发「收尾请求」给你：看它交的验证结果，够了就调用 finish_child（合回、标完成、删它的分支，都是工具调用，不要自己跑 git）；不够就用 send_to_conversation 把要补的交回给它。合并就是验收，测试要在它合并之前做完。
- 项目里有范围为「全量，合并后由父对话跑」的测试步骤时，合回后面板自动在你的目录里按顺序跑它们（一次只跑一个，和编译共用独占队列），结果和耗时直接回传给对应的子对话；你不用自己跑，也不用转述。跑完通过才算它收尾，失败会退回给子对话修，它重新合并后这些步骤全部重跑。等它跑完期间，你计划里等这个子对话的步骤保持等待。

${ownDispatch ? '## 分派提醒\n用户的一条消息只交给关联最紧密的那一个子对话；同一段话再交给别的子对话会被面板拒绝。\n\n' : dispatchRules + '\n\n'}${
        host.childIsolation === 'worktree'
          ? `## 子对话各自在独立分支里改
要改代码的子对话都有自己的独立分支目录，互相看不到对方改到一半的文件。
- 新建子对话时用 files 写清它负责的文件或目录（相对项目根），它按这个范围改。两个子对话的文件重叠没关系：各在自己的独立分支里改、互不影响，不用拆范围，也不用排队等对方。面板会在创建结果里提示重叠，那只是信息——合并回这里时按 git merge 处理，能自动合上的直接合。
- 子对话在自己的分支里编译、测试，跑通后调用 submit_merge，面板排队把它合回你所在的分支；有冲突撤回并推回给那个子对话。一次只合一个，你不用自己合并。合回去只代表改动进了你的分支，不等于它做完了：它还有计划没做完、后台命令还在跑、待回答的提问或者这一轮没结束时，面板不会把它标成完成，你也不要当它已经交付完了。
- 合并结果里写着「两边都改了这些文件」时，那个文件两边都动过（git 没报冲突也算了）：让子对话核对内容、确认没有把对方的改动盖掉，再当它交付完了。
- 每次合并的结果会告诉你；子对话做完一轮却没合并时，面板会先催它一次，还没合再交给你决定。子对话反复冲突、或者问题其实是别的子对话的改动引起的，由你协调。
- 几个子对话都合进来之后的整体验证：范围为「全量，合并后由父对话跑」的测试面板会自动跑；用户点名要整体回归时派「测试验收」（spawn_agents），不另开子对话，你自己也不跑。
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
    parts.push(`## 执行方式\n直接在对话里回答或执行当前任务；没有创建子对话的能力。${topPush(host)}${noDelegate}`)
  } else {
    parts.push(
      `## 执行方式
你只负责当前这个子对话的任务，直接在对话里执行。你不能创建子对话，也不能启动工作流（工作流由父对话启动）。${noDelegate}`,
    )
    // 角色（或它引入的「通用约束」）里已经写了这两条时，面板不再每个子对话重复一遍；
    // 按正文判断而不是按来源：用户把通用约束改掉了这两节，面板照旧补上
    const roleText = agent
      ? [agent, ...includedAgents(agent, host.agents).map((x) => x.agent)].map((a) => a.instructions).join('\n')
      : ''
    const roleAsks = roleText.includes('子对话停下来等用户时必须先提问')
    const roleSuggests = roleText.includes('子对话的收尾建议也交给用户选')
    // 提问怎么问、问给谁按子对话自己的「提问」开关（见 shared/child-ask.ts）
    const askPart = childAskPrompt(host.task.askUser, roleAsks)
    if (askPart) parts.push(askPart)
    // 通用规则在角色里、或关着提问（收尾建议也不交给别人选）时：只补随项目变的完成标准
    if (host.messageParent && (roleSuggests || !host.task.askUser))
      parts.push(`## 子对话的完成标准
这个子对话做到「${wrapDone(wrapKind(host), parentRunsIn(host))}」为止${wrapKind(host) ? '，这是收尾，面板已经把它列成计划的最后一步，不要写成建议' : ''}；和角色设定里写的不一样时以这里为准。`)
    else if (host.messageParent)
      parts.push(`## 收尾建议要交给用户选
这一轮做完了、结论里要给用户下一步怎么做的建议时（继续做某个方向、换个做法、要不要接着做），必须调用 suggest_next_step（text 写建议，options 写 2–4 个做法，第一个是推荐做法并标「（推荐）」），不要只写在结论里：只写在结论里用户看不出你是在等他，还是已经结束了，子对话就一直停在那条没人处理的建议上。用户选完会自动交回给你接着做。
建议只写你自己能做完的本地动作；完成标准是${wrapDone(wrapKind(host), parentRunsIn(host))}${wrapKind(host) ? '——这是收尾，面板已经把它列成计划的最后一步，不要写成建议' : ''}；计划步骤和收尾里不写「等推送 / 等合入其他分支 / 同步远端」。推送、创建 PR、P4 submit、合并到主干由父对话决定，不要写成建议项，也不要写成要用户回答的问题。调用时 remote 必须写 "none"（这些建议不改远端）：写了别的值会被直接拒绝，卡片不会交给用户。`)
    if (host.messageParent)
      parts.push(
        host.claimFiles
          ? `## 和父对话、其他子对话的协作
你是项目对话分出来的子对话，和其他子对话在同一个目录里同时工作（没有独立分支）：
- 改文件前先用 claim_files 认领要改的文件或目录；被别的子对话占着的不要改，先做别的部分或用 message_parent（question 设为 true）请父对话协调。没改过的部分可以用 release_files 提前让出；改过的文件留到父对话验收你的改动后由面板释放（一轮结束、停下都不释放）。
- 不要切换分支、不要 reset / checkout 别人的文件、不要格式化整个仓库，只动自己负责的范围。
- 编译或测试报错的位置不在你改的文件里时，先确认是不是别的子对话正在改的，不要去修别人的文件；提交时只 git add 你自己改的文件，不用 -A。
- 需要父对话决定或协调时用 message_parent 并把 question 设为 true（options 列出可选的做法）；阶段进展不用单独发，一轮结束面板会把你的汇报和状态合成一封交给父对话。你不能直接联系其他子对话。`
          : `## 和父对话的协作
你是项目对话分出来的子对话。只动自己负责的范围，不要格式化整个仓库。
需要父对话决定或协调时用 message_parent 并把 question 设为 true（options 列出可选的做法）；阶段进展不用单独发，一轮结束面板会把你的汇报和状态合成一封交给父对话。你不能直接联系其他子对话。`,
      )
  }
  return parts.filter(Boolean)
}

/**
 * 一轮对话：调用对话 Agent；它启动的计划在这一轮里同步跑完，再交回结果继续对话。
 * 导出给单测验证「计划设的预算在 chat 路径也生效」。
 */
export async function runConversationTurn(host: EngineHost, who: string) {
  const { task } = host
  const kind = task.parentTaskId ? 'sub' : 'top'
  // 能不能分派子对话由 Agent 自己的能力开关决定；子对话本身永远不能再分派。Chat 模式没选角色、选的角色被删了都按内置「助手」跑
  const agent = who ? turnRole(task, host.agents, who) : chatRoleFor(task, host.agents)
  // Chat 模式没有子对话（子对话要项目），create_conversation 一定失败：不按分派对话去提示
  const coordinator = kind === 'top' && !!agent?.canDelegate && !!task.projectId
  const planning = coordinator && !!agent?.canPlan && !isChatMode(task) // 只有父对话能启动工作流（ADR 0044）
  const turn = host.prewarm ? undefined : beginTurn(task, host.newId(), host.prompt, who)
  if (turn) host.changed(true)
  try {
    const inline = coordinator && !!host.inlineEdit && agent?.inlineEdit === 'tiny'
    // 第一轮和保活进程里的下一条必须用同一套参数拼：以前保活那处漏传了 agent，
    // 角色设定里已写过的规则（协调器的分派规则、子对话的提问和完成标准）被发回去，下一轮又宣布作废
    const buildPrompt = () =>
      conversationPrompt(host, kind, planning, coordinator, !coordinator && delegatesRole(host, agent), inline, agent)
    const parts = await buildPrompt()
    const full = parts.join('\n\n')
    // 续接同一个会话时规则段落只发变了的（见 shared/prompt-delta.ts）；回退、预热不省，按完整的发
    const sent = task.promptSent?.[who]
    const delta = host.prewarm || task.rewind ? null : promptDelta(parts, sent, task.sessions[who])
    let prompt = delta ?? full
    // 这一轮的输入构成（见 TaskTurn.sources）：按来源记字数，界面上看得出 token 花在规则、消息还是工具输出上
    const source = (k: keyof TurnSources, n: number) => {
      if (!turn || n <= 0) return
      const s = (turn.sources ??= { rules: 0, user: 0, results: 0, tools: 0, setup: 0 })
      s[k] += n
    }
    const sentParts = (ps: string[], text: string) => {
      const x = promptSources(ps, text)
      source('user', x.user)
      source('rules', x.rules)
    }
    // 这个 CLI 进程已经收到的段落：保活时后面的消息在同一个进程里接着发，比的是它；会话 id 跑完才知道，先用占位。
    // 会话压缩过就清空：之后的消息发完整提示，这一轮结束时也不把压缩前的记录写回去
    let live: PromptSent | undefined = nextSent(parts, LIVE, !!delta, sent)
    const onCompacted = () => (live = undefined)
    const nextPrompt = async (text: string) => {
      host.prompt = text
      const now = await buildPrompt()
      const d = promptDelta(now, live, LIVE)
      live = nextSent(now, LIVE, !!d, live)
      const out = d ?? now.join('\n\n')
      sentParts(now, out)
      return out
    }
    // 第一圈之后的 prompt 是子任务结果、计划结果，不是这份规则
    let first = true
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
      // includeWorkflow=false：对话里跑过工作流之后任务也带着工作流快照，工作流那份额度不该管聊天轮次
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
      // 继续执行：被打断的子任务由面板在原记录、原会话里接着跑（ADR 0042），接不上的原因交给模型处理
      const lost =
        first && host.resume && !host.prewarm ? rs.resumePausedHelpers(host, orch, chatStep(host, who).id) : ''
      if (lost) prompt += `\n\n（面板说明：被打断的子任务没能自动接着跑：${lost}）`
      let r: AgentResult
      // 第一圈是这条消息和规则；之后的是子任务、计划交回的结果
      if (first) sentParts(parts, prompt)
      else source('results', prompt.length)
      const onInput = (i: { setup: number; rules: number; fresh: boolean }) => {
        source('setup', i.setup)
        source('rules', i.rules)
        // runner 没接上原会话、改发了完整的：省掉的规则其实也发了
        if (i.fresh) source('rules', full.length - prompt.length)
      }
      try {
        r = await host.runAgent({
          agentId: who,
          prompt,
          // 只发了增量时带上完整的：runner 续不上会话、开了新会话时改用它
          ...(first && delta ? { fresh: full } : {}),
          // 预热也给：预热那一轮发的是完整提示（live 就是它），用户的第一条消息经 wait_user_message 或保活交进来时
          // 同样按当前状态只补变了的段落，不然原样交过去，没有「## 用户这次的消息」，计划、收件箱也停在预热那一刻
          ...(first ? { nextPrompt, onInput, onCompacted } : {}),
          ...(first ? {} : { carry: true }),
          // 会话键就是 Agent id；选了「无」时用空字符串，runner 仍然按对话处理
          sessionKey: who,
          ...(host.prewarm ? { prewarm: true } : {}),
          orch,
          // 预热也装结束前钩子：预热起的进程之后会接着处理用户真正的消息（开独立分支后在新目录里重开也是预热），
          // 不装的话这些轮次只能等一轮结束后另起一轮提醒。预热还没收到消息时由 before-end 判成放行
          ...(host.beforeEnd ? { beforeEnd: host.beforeEnd } : {}),
        })
      } finally {
        // AI 这一轮处理完了：宿主不再把转交来的子任务派进它（后面的阶段交给下一轮）
        host.onOrchestra?.(undefined)
      }
      // 记下这个会话已经有了哪些段落：跑完或被停下的算收到了（停下时 CLI 已经读过这一轮）；报错的不记，
      // 可能根本没交到 CLI，下一轮照旧补发。会话 id 取 runner 跑完后的（续不上开了新会话时，新会话收到的是 fresh）
      // 这一轮里压缩过（含手动压缩：那一轮只发了压缩命令，规则根本没发）：不记，下一轮发完整提示
      // 预热同样记：它发的是完整提示，之后在这个进程里收的消息也都按 live 补过段落，会话里有的就是 live 这份
      // 预热被停下不记：CLI 可能还没把提示写进会话就被停了，记成收到会让下一轮只发增量、漏掉规则
      if (first && live && task.sessions[who] && (r.ok || (r.stopped && !host.prewarm)))
        task.promptSent = rememberSent(task.promptSent, who, { ...live, session: task.sessions[who] })
      first = false
      if (!r.ok) {
        // 这一轮 CLI 已经报过完成才被收掉（交付完回收、父对话收尾、闲置回收）不算被打断；用户停下时还有活没干完的除外（见 userCutWork）
        const done = rs.answeredAll(task, turn ?? { startedAt: '' }) && !rs.userCutWork(host)
        const answered = !!turn && !!r.stopped && (done || rs.finishedStop(host))
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
      break
    }
    // 等子任务结果时用户停下、活还没干完：记成已停止，「继续执行」才能把整棵树接回来（见 userCutWork）
    if (rs.userCutWork(host)) {
      if (turn) endTurn(task, turn, 'stopped', Date.now(), 'user')
      return finish(host, { ok: false, stopped: true, error: '' })
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

/** 子对话的摘要：最近一条 Agent 回复的开头，父对话的协调 Agent 用它判断关联 */
function summaryOf(task: Task) {
  const last = [...task.messages].reverse().find((m) => m.role === 'agent' && m.text.trim())
  return last ? clip(last.text.replace(/\s+/g, ' ').trim(), 300) : ''
}

/** 收尾：把这一轮的结果写进任务（导出给单测验证「超预算停下时不丢已有输出」） */
export function finish(host: EngineHost, r: Fail, opts?: { answered?: boolean }) {
  // 这一轮其实已经答完了（见 answeredAll）：CLI 报过完成、只是停在等下一句之后才被收掉，不算被打断——
  // 不写「这一轮被中断」、不记 stopReason，状态照常是 done。真停止（用户暂停、面板重启、CLI 崩溃）照旧
  // 停的时候还有子任务、节点在跑：活没干完，不能记成答完、更不能把它们记成完成（ADR 0042），一律暂停、继续时接着做
  const cut = !!r.stopped && host.task.steps.some((s) => s.status === 'running')
  const answered = !!r.stopped && !cut && (!!opts?.answered || rs.finishedStop(host))
  for (const s of host.task.steps.filter((x) => x.status === 'running'))
    if (r.stopped || rs.pauseHelper(host.task.id, s)) rs.pauseUnit(s)
    else [s.status, s.endedAt] = ['failed', now()]
  if (r.budget) system(host, r.error, '', false, true, 'budget')
  else if (r.stopped && !answered) {
    // 谁结束的这一轮：用户自己按的暂停不写提示行（输入框旁已经有「继续执行」按钮）；
    // 别的动作要说清是谁结束的，不能让用户看到「我没点暂停却停了」（父对话收尾的时候子对话就是这种）
    const reason = host.stopReason?.() ?? 'user'
    host.task.stopReason = reason
    if (reason !== 'user')
      system(
        host,
        t('这一轮被中断：{reason}。{next}从中断的地方接着做，或者在下面输入新的要求。', {
          reason: stopReasonText(reason),
          next: host.task.mode === 'workflow' ? t('点「继续流程」') : t('点「继续执行」'),
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

/** 执行一轮：对话模式发给对应 Agent（工作流子对话先跑流程图）；旧的工作流模式按流程图接着执行、追加要求交给主角色 */
export async function runEngineTurn(host: EngineHost) {
  const { task } = host
  task.status = 'running'
  // 又开了一轮：上一轮停下的原因不再成立（不然图标一直挂在暂停 / 中断上）
  task.stopReason = undefined
  // 不管是前置合回后面板启动的、还是用户手动继续的，开始了就不再排在别人后面（shared/child-after.ts）
  task.waitAfter = undefined
  // 预算按每次执行算：从这一轮开始时的用量起算（时长也从这里开始）
  task.budgetFrom = {
    usd: task.usage.costUsd,
    tokens: task.usage.inputTokens + task.usage.outputTokens,
    at: Date.now(),
  }
  // 旧版对话里的常驻编排器不再工作：记录留着可以看，但不再参与执行
  for (const s of task.steps) if (isMainStep(s) && s.status !== 'done' && s.status !== 'skipped') s.status = 'skipped'
  host.changed(true)

  // 新架构里项目对话都是对话：父对话决定直接执行、交给子对话，还是用 start_workflow 启动工作流
  if (task.mode === 'chat') return runConversationTurn(host, task.agentId)

  // 工作流运行（父对话 start_workflow 起的，不是子对话）：面板按流程图推着走，见 flow-run-turn.ts
  if (task.flowRun) return runFlowRunTurn(host, { runFlow, system, finish })
  // 旧版的工作流任务（主 Agent 常驻的那种）不再执行：记录照旧能看（用户 2026-11-05 定：不做兼容，但不能崩）
  return finish(host, {
    ok: false,
    error: t('这是旧版的工作流任务，已经不能继续执行；要再做一次，请在父对话里启动工作流'),
  })
}
