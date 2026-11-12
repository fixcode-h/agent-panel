/**
 * 工作流运行（docs/openspec/changes/workflow-runs/design.md）：父对话 start_workflow 起的一次运行，
 * 记在一个 mode=workflow 的任务上（Task.flowRun），不是子对话。这里是不依赖引擎的纯函数：
 * 进度怎么说、父对话每轮看到的那一节、决定记录怎么拼进节点提示、父对话挑工作流的目录和判定规则。
 */
import type { Task, TaskStep } from './schema.ts'
import type { FlowDecision, FlowRun, FlowRunPhase, FlowWrap } from './tasks/flow-schema.ts'
import { topSteps } from './flow.ts'
import { WRAP_NODE } from './flow-run-wrap.ts'
import { clip } from './text.ts'
import { takeWorkflow } from './composer.ts'

type RunTask = Pick<Task, 'id' | 'title' | 'status' | 'steps' | 'runSeq' | 'flowRun'>

/** 运行一次只跑一遍流程图（第 1 次运行）：之后的修改、退回都在同一次运行里改节点状态 */
export const RUN_NO = 1

/** 是不是工作流运行（父对话 start_workflow 起的那种任务） */
export const isFlowRun = (t: Pick<Task, 'flowRun'>): t is Pick<Task, 'flowRun'> & { flowRun: FlowRun } => !!t.flowRun

/** 结束了的阶段：不会再自己往下跑，也不接收补充要求 */
export const RUN_ENDED: readonly FlowRunPhase[] = ['done', 'discarded', 'cancelled']

/** 运行停着（暂停）：任务停了、阶段还没结束 */
export const runPaused = (t: Pick<Task, 'status' | 'flowRun'>) =>
  !!t.flowRun && t.status !== 'running' && !RUN_ENDED.includes(t.flowRun.phase) && t.flowRun.phase !== 'ready'

/** 节点进度：做完的 / 一共几个、正在跑（或停在）哪个节点 */
export function runNodes(task: Pick<Task, 'steps'>) {
  const tops = topSteps({ steps: task.steps }, RUN_NO)
  const done = tops.filter((s) => s.status === 'done' || s.status === 'skipped').length
  const cur =
    tops.find((s) => s.status === 'running') ??
    tops.find((s) => s.awaitConfirm) ??
    tops.find((s) => s.status === 'failed') ??
    tops.find((s) => s.status !== 'done' && s.status !== 'skipped')
  return { done, total: tops.length, node: cur?.title ?? '', step: cur }
}

/** 运行一行摘要的结构：父对话的工作流栏、list_workflows 都按它说，不另算一套 */
export interface RunEntry {
  id: string
  title: string
  workflowName: string
  kind: FlowRun['kind']
  phase: FlowRunPhase
  paused: boolean
  done: number
  total: number
  node: string
  /** 收尾做到哪：评审 / 测试 / 修复 第几轮 */
  wrap?: FlowWrap
  /** 停在等确认的节点修改了几轮（超过上限只提示） */
  rounds?: number
  reviseLimit: number
  updatedAt?: string
}

/** 收尾做到哪（收尾节点在跑时）：验收流程里在跑测试就是测试、在跑评审就是评审，否则是收尾节点自己在补齐 / 修复 */
export function wrapNow(task: Pick<Task, 'steps'>): FlowWrap | undefined {
  const st = topSteps({ steps: task.steps }, RUN_NO).find((s) => s.nodeId === WRAP_NODE)
  if (st?.status !== 'running') return undefined
  const checks = task.steps.filter((s) => s.parentId === st.id && s.slot === 'review' && s.status === 'running')
  const stage = checks.some((s) => s.nodeId === 'test') ? 'test' : checks.length ? 'review' : 'fix'
  return { stage, round: (st.reviews ?? 0) + 1, review: '', test: '' }
}

export function runEntry(task: RunTask & Pick<Task, 'updatedAt'>): RunEntry | undefined {
  const f = task.flowRun
  if (!f) return undefined
  const n = runNodes(task)
  const wrap = f.phase === 'running' ? wrapNow(task) : undefined
  return {
    id: task.id,
    title: task.title,
    workflowName: f.workflowName,
    kind: f.kind,
    // 收尾节点在跑：阶段说成收尾（界面和父对话都按收尾说做到哪），不另记一份状态
    phase: wrap ? 'wrapup' : f.phase,
    paused: runPaused(task),
    done: n.done,
    total: n.total,
    node: n.node,
    ...(wrap ? { wrap } : {}),
    ...(f.phase === 'confirm' && n.node ? { rounds: reviseRounds(f, n.node) } : {}),
    reviseLimit: f.reviseLimit,
    updatedAt: task.updatedAt,
  }
}

const WRAP_NAME = { review: '评审', test: '测试', fix: '修复' } as const

/** 一句话的进度（给父对话的 AI 看：list_workflows、每轮的「名下的工作流」） */
export function runLine(e: RunEntry): string {
  const head = `工作流「${e.workflowName}」（id ${e.id}）`
  const count = e.total ? `${e.done}/${e.total}` : ''
  const paused = e.paused ? '，已暂停（重启后从这里接着走）' : ''
  switch (e.phase) {
    case 'running':
      return `${head}：${count}，在跑「${e.node}」${paused}`
    case 'confirm':
      return `${head}：${count}，「${e.node}」做完了，等用户确认${paused}`
    case 'failed':
      return `${head}：${count}，节点「${e.node}」失败，等决定（revise_workflow 带意见重跑，或 stop_workflow 终止）`
    case 'wrapup':
      return `${head}：收尾·${e.wrap ? `${WRAP_NAME[e.wrap.stage]}（第 ${e.wrap.round} 轮）` : ''}${paused}`
    case 'ready':
      return `${head}：做完了，等你合回（finish_workflow merge / discard）`
    case 'done':
      return `${head}：已完成`
    case 'discarded':
      return `${head}：已放弃`
    default:
      return `${head}：已终止`
  }
}

/** 父对话每一轮看到的「名下的工作流」：只列还没结束的，每个一行；没有就不写这一节 */
export function runsSection(list: RunEntry[]): string {
  const live = list.filter((e) => !RUN_ENDED.includes(e.phase))
  if (!live.length) return ''
  return `## 名下的工作流\n${live.map((e) => `- ${runLine(e)}`).join('\n')}`
}

const DECISION_NAME: Record<FlowDecision['kind'], string> = {
  confirm: '用户确认',
  revise: '用户要求修改',
  ask: '用户追问',
  back: '用户退回',
  note: '补充说明',
  parent: '父对话决定',
}

/** 决定记录和运行级说明：拼进之后每个节点的提示，知道哪些是用户明确要求的 */
export function decisionsText(f: Pick<FlowRun, 'decisions' | 'notes'>): string {
  const lines = [
    ...f.decisions
      .filter((d) => d.kind !== 'ask')
      .map(
        (d) => `- ${DECISION_NAME[d.kind]}${d.node ? `「${d.node}」` : ''}${d.text ? `：${clip(d.text, 600)}` : ''}`,
      ),
    ...f.notes.map((n) => `- 补充说明：${clip(n, 600)}`),
  ]
  return lines.length ? `## 这次运行里已经定下的事\n${lines.join('\n')}` : ''
}

/** 某个节点修改了几轮：同一节点上的修改、退回都算（追问不算） */
export function reviseRounds(f: Pick<FlowRun, 'decisions'>, node: string) {
  return f.decisions.filter((d) => d.node === node && (d.kind === 'revise' || d.kind === 'back')).length
}

/** 修改超过上限的节点：结尾提示用（不强制终止，D6） */
export function overLimit(f: Pick<FlowRun, 'decisions' | 'reviseLimit'>): string[] {
  if (!f.reviseLimit) return []
  const nodes = [...new Set(f.decisions.map((d) => d.node).filter(Boolean))]
  return nodes.filter((n) => reviseRounds(f, n) > f.reviseLimit)
}

/** 退回到某个节点：它和它之后的节点（按流程图顺序）改回待执行，返回改了哪些；找不到这个节点返回空 */
export function rewindTo(task: Pick<Task, 'steps'>, node: string): TaskStep[] {
  const tops = topSteps({ steps: task.steps }, RUN_NO)
  const at = tops.findIndex((s) => s.title === node || s.id === node || s.nodeId === node)
  if (at < 0) return []
  const back = tops.slice(at)
  // 节点下面的步骤、验收、子任务记录一起改回：不然多步节点续跑时把做完的步骤直接复用，等于没退回
  const under = task.steps.filter((s) => back.some((b) => s.id.startsWith(`${b.id}/`)))
  for (const s of [...back, ...under]) {
    s.status = 'pending'
    s.verdict = ''
    s.branch = ''
    s.endedAt = ''
    s.awaitConfirm = false
    s.interrupted = false
  }
  return back
}

/** 一条步骤记录属于哪个节点（多步节点里的某一步、验收都算到所在节点上）：决定记录按节点标题记 */
export function nodeTitle(task: Pick<Task, 'steps'>, step: Pick<TaskStep, 'id' | 'title'>): string {
  const top = topSteps({ steps: task.steps }, RUN_NO).find((s) => s.id === step.id || step.id.startsWith(`${s.id}/`))
  return top?.title ?? step.title
}

/** 节点确认的回答（用户在运行卡片上点的，或父对话 answer_workflow 代答的） */
export interface ConfirmReply {
  allow: boolean
  answer?: string
  ask?: boolean
}

/**
 * 节点确认有了回答：记进决定记录，阶段回到在跑。by 是谁答的：父对话代答记成「父对话决定」，
 * 之后的节点知道这不是用户本人的话。修改、追问都算在这个节点上（修改计轮次，追问不计）
 */
export function noteConfirm(f: FlowRun, node: string, r: ConfirmReply, by: 'user' | 'parent' = 'user') {
  const text = (r.answer ?? '').trim()
  const kind: FlowDecision['kind'] = r.allow ? (by === 'parent' ? 'parent' : 'confirm') : r.ask ? 'ask' : 'revise'
  // 确认也记一笔：之后的节点知道这一步的结果用户看过、认可了
  f.decisions.push({
    at: new Date().toISOString(),
    node,
    kind,
    text: by === 'parent' && !r.allow ? `（父对话代答）${text}` : text,
  })
  f.phase = 'running'
}

/** 父对话可以启动的工作流目录里的一项：名字、说明、节点概览，加上挑工作流用的适用场景 */
export interface WorkflowEntry {
  id: string
  name: string
  description: string
  steps: string[]
  when?: string
  notFor?: string
  kind?: 'change' | 'readonly'
}

/**
 * 父对话什么时候启动工作流（ADR 0044 第 4 条）：判定规则只写在这里，协调器的角色设定和提示词都用它，不再各写一份
 */
export const WORKFLOW_PICK_RULES = `什么时候用 start_workflow 启动工作流，三条同时满足才用：步骤事先定得下来（不取决于上一步查到了什么）；有不能跳的门禁或留痕（先确认方案再动手、迁移和回滚成对写、要出 ADR）；这类事会重复做。按顺序判断：
1. 用户点名了某个工作流：直接用它。
2. 需求命中下面某个工作流的「适用」：用它；同时命中几个选最具体的那个。
3. 这些一律不起工作流：问答和分析、排查和 Bug 定位、一两个文件的小改动、要边做边和用户商量的事、一次性调研、推送和发布。按分诊就地做、派子任务或交给子对话。
4. 拿不准就交给子对话，不起工作流：起错一个工作流要把节点全跑一遍，比少起一个贵。
工作流是一次独立的运行（不是子对话）：面板按流程图推着走，改代码的在自己的独立分支里改，跑完自己评审、测试，再交回给你决定合回（finish_workflow）。节点要用户确认时由用户在工作流卡片上确认，你不用管；用户点了「交给父对话决定」你才用 answer_workflow。进度用 list_workflows 看，等决定、待合回、完成、终止时会来信叫你。启动时 route 写清为什么用这个工作流。`

/** 「可用工作流」那一段：目录加判定规则 */
export function workflowCatalogText(list: WorkflowEntry[]): string {
  if (!list.length) return '## 可用工作流\n项目还没有配置工作流：要做的事按分诊交给子对话或就地做。'
  const lines = list.map((w, i) => {
    const extra = [
      w.when && `适用：${w.when}`,
      w.notFor && `不用：${w.notFor}`,
      w.kind === 'readonly' && '只读',
    ].filter(Boolean)
    const nodes = w.steps.length ? `（节点：${w.steps.join(' → ')}）` : ''
    return `- id: ${w.id}｜${w.name}${i === 0 ? '（默认）' : ''}：${w.description}${nodes}${extra.length ? `\n  ${extra.join('；')}` : ''}`
  })
  return `## 可用工作流\n${lines.join('\n')}\n\n${WORKFLOW_PICK_RULES}`
}

/** 按 id 或名字找工作流；空是项目默认的（目录第一个）。找不到时说清能用哪些 */
export function pickFlow(
  list: WorkflowEntry[],
  key: string,
): { ok: false; info: string } | { ok: true; flow: PickedFlow } {
  const k = key.trim()
  const w = !k ? list[0] : (list.find((x) => x.id === k) ?? list.find((x) => x.name === k))
  if (!w)
    return {
      ok: false,
      info: list.length
        ? `没有「${k}」这个工作流，可以用：${list.map((x) => `${x.name}（id ${x.id}）`).join('、')}`
        : '项目还没有配置可用的工作流：按分诊交给子对话或就地做',
    }
  return { ok: true, flow: { workflowId: w.id, workflowName: w.name, kind: w.kind ?? 'change' } }
}

/** 挑中的工作流：起运行要的那几样 */
export interface PickedFlow {
  workflowId: string
  workflowName: string
  kind: FlowRun['kind']
}

/**
 * 用户手动点名工作流（ADR 0044 第 7 条）：「在项目里运行」和输入框「+」里的「引入工作流」都把要求写成这一句发给父对话，
 * 父对话按判定规则第 1 条直接用它起工作流运行。带 id：重名、不在项目可选列表里也认得出
 */
export function workflowPrompt(workflow: { id: string; name: string }, text: string) {
  return `用工作流「${workflow.name}」（id ${workflow.id}）做：\n${text.trim()}`
}

/** 这个角色当父对话时能不能启动工作流：要能开子对话、能启动工作流（start_workflow 只给这样的父对话） */
export function canStartFlow(agents: { id: string; canDelegate: boolean; canPlan: boolean }[], agentId: string) {
  const a = agents.find((x) => x.id === agentId)
  return !!a && a.canDelegate && a.canPlan
}

/**
 * 输入框里引入了工作流（行内的工作流卡片）：卡片摘掉，剩下的要求写成点名它的一句；没有卡片原样返回。
 * 按名字找工作流拿 id；找不到（改名、删了）只写名字，父对话按名字再认一次
 */
export function withWorkflow(value: string, workflows: readonly { id: string; name: string }[]) {
  const { name, rest } = takeWorkflow(value)
  if (!name) return value
  const w = workflows.find((x) => x.name === name)
  return w ? workflowPrompt(w, rest) : `用工作流「${name}」做：\n${rest.trim()}`
}

/** 发出去的要求点名了工作流（workflowPrompt / withWorkflow 写出来的那句）：拆出名字和后面的要求，对话里把点名画回工作流卡片 */
export function namedWorkflow(text: string): { name: string; rest: string } | undefined {
  const m = /^用工作流「([^」\n]+)」(?:（id [^）\n]*）)?做：\n/.exec(text)
  return m ? { name: m[1], rest: text.slice(m[0].length) } : undefined
}
