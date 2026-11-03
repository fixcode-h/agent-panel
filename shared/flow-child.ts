/**
 * 工作流子对话（ADR 0044）：工作流只由父对话启动，每次启动在父对话下开一个子对话（任务上记 `flow`），
 * 面板先按流程图把节点跑完，再交给这个子对话的执行角色收尾（评审 → 完整测试 → 合回）。
 * 这里是不依赖引擎的纯函数：这一轮该跑流程图的哪一段、进度怎么说、跑完交给执行角色的话、父对话挑工作流的目录。
 */
import type { Task, TaskStep } from './schema.ts'
import { topSteps } from './flow.ts'
import { clip } from './text.ts'
import { takeWorkflow } from './composer.ts'

type FlowTask = Pick<Task, 'flow' | 'runs' | 'steps' | 'runSeq'>

/**
 * 这一轮流程图要做什么：
 * - start：还没跑过（或父对话要再跑一次），起一次新的运行；
 * - continue：上次停下了（暂停、面板重启、卡住重开），同一次运行从没做完的节点接着跑；
 * - retry：上次有节点失败，父对话交回意见后，失败的节点带着意见重跑，再接着往下走；
 * - undefined：不是工作流子对话，或者流程图已经交给执行角色 / 被终止了，按普通子对话走。
 */
export function flowPhase(task: FlowTask): 'start' | 'continue' | 'retry' | undefined {
  const f = task.flow
  if (!f || f.handed || f.cancelled) return undefined
  const rec = f.run ? task.runs.find((r) => r.id === f.run) : undefined
  if (!rec) return 'start'
  return rec.status === 'failed' ? 'retry' : 'continue'
}

/** 失败的节点退回待执行：重跑时带着父对话的意见；返回第一个（意见交给它） */
export function reopenFailed(task: FlowTask, run: number): TaskStep | undefined {
  const failed = topSteps(task, run).filter((s) => s.status === 'failed')
  for (const s of failed) {
    s.status = 'pending'
    s.verdict = ''
    s.branch = ''
    s.endedAt = ''
  }
  return failed[0]
}

/** 接着跑时第一个没做完的节点：父对话这次交来的话给它 */
export const nextUnfinished = (task: FlowTask, run: number) =>
  topSteps(task, run).find((s) => s.status !== 'done' && s.status !== 'skipped')

export interface FlowProgress {
  name: string
  run: number
  done: number
  total: number
  /** 正在跑的节点（没有在跑的就是下一个没做完的） */
  node: string
  /** running 在跑节点；handed 流程图跑完、执行角色在收尾；failed 停在失败的节点；stopped 暂停；cancelled 被终止 */
  state: 'pending' | 'running' | 'handed' | 'failed' | 'stopped' | 'cancelled'
}

/** 工作流子对话的进度：子对话栏、list_conversations 都按它说，不另算一套 */
export function flowProgress(task: FlowTask & Pick<Task, 'status'>): FlowProgress | undefined {
  const f = task.flow
  if (!f) return undefined
  const rec = f.run ? task.runs.find((r) => r.id === f.run) : undefined
  const tops = f.run ? topSteps(task, f.run) : []
  const done = tops.filter((s) => s.status === 'done' || s.status === 'skipped').length
  const cur =
    tops.find((s) => s.status === 'running') ?? tops.find((s) => s.status !== 'done' && s.status !== 'skipped')
  const state: FlowProgress['state'] = f.cancelled
    ? 'cancelled'
    : f.handed
      ? 'handed'
      : !rec
        ? 'pending'
        : rec.status === 'failed'
          ? 'failed'
          : rec.status === 'running' && task.status === 'running'
            ? 'running'
            : 'stopped'
  return { name: f.workflowName || f.workflowId, run: f.run, done, total: tops.length, node: cur?.title ?? '', state }
}

/** 一句话的进度，给父对话看（list_conversations、续接说明） */
export function flowLine(task: FlowTask & Pick<Task, 'status'>): string {
  const p = flowProgress(task)
  if (!p) return ''
  const head = `工作流「${p.name}」`
  const count = p.total ? `${p.done}/${p.total}` : ''
  switch (p.state) {
    case 'pending':
      return `${head}：还没开始`
    case 'running':
      return `${head}：${count}，正在跑「${p.node}」`
    case 'failed':
      return `${head}：${count}，停在「${p.node}」（节点失败，等你给意见重跑或 stop_workflow 终止）`
    case 'stopped':
      return `${head}：${count}，暂停在「${p.node}」，继续时从这里接着跑`
    case 'cancelled':
      return `${head}：已终止`
    default:
      return `${head}：流程图跑完了，执行角色在收尾`
  }
}

/**
 * 流程图跑完、交给执行角色的话：工作流已经做完实现，执行角色只做收尾（ADR 0044 第 3 条）。
 * output 是流程图最后的结果（已经按长度截过、带全文指针）
 */
export function flowHandoffPrompt(f: NonNullable<Task['flow']>, output: string): string {
  const tail =
    f.kind === 'readonly'
      ? '这个工作流只读，没有改动：不用评审，也不用跑测试。把上面的结果整理成交回父对话的总结（按总结格式写，结论在前），然后按收尾规则交付。'
      : '工作流已经做完实现、快速检查和文档同步，不要从头重做。按你的收尾规则接着做：评审（只看这次的 diff，带交接单）→ 完整测试和编译 → 合回。评审或测试发现问题就地修，修完再走一遍收尾。'
  return `## 工作流「${f.workflowName || f.workflowId}」跑完了
父对话用这个工作流处理：${clip(f.input, 2000)}

### 结果
${output || '（没有文字输出，各节点的输出见运行记录）'}

${tail}`
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
export const WORKFLOW_PICK_RULES = `什么时候用 start_workflow 启动工作流，按顺序判断：
1. 用户点名了某个工作流：直接用它。
2. 需求命中下面某个工作流的「适用」：用它；同时命中几个选最具体的那个。
3. 这些一律不起工作流：问答和分析、排查和 Bug 定位、一两个文件的小改动、要边做边和用户商量的事、一次性调研。按分诊就地做、派子任务或交给子对话。
4. 拿不准就交给子对话，不起工作流：起错一个工作流要把节点全跑一遍，比少起一个贵。
工作流跑在新开的工作流子对话里（和子对话一样有自己的分支、状态和收尾），流程图跑完由它的执行角色评审、测试、合回；你按等子对话的方式等它。启动时 route 写清为什么用这个工作流。`

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
): { ok: false; info: string } | { ok: true; flow: NonNullable<Task['flow']> } {
  const k = key.trim()
  const w = !k ? list[0] : (list.find((x) => x.id === k) ?? list.find((x) => x.name === k))
  if (!w)
    return {
      ok: false,
      info: list.length
        ? `没有「${k}」这个工作流，可以用：${list.map((x) => `${x.name}（id ${x.id}）`).join('、')}`
        : '项目还没有配置可用的工作流：按分诊交给子对话或就地做',
    }
  const flow = { workflowId: w.id, workflowName: w.name, input: '', kind: w.kind ?? 'change', run: 0, handed: false }
  return { ok: true, flow }
}

/**
 * 用户手动点名工作流（ADR 0044 第 7 条）：「在项目里运行」和输入框「+」里的「引入工作流」都把要求写成这一句发给父对话，
 * 父对话按判定规则第 1 条直接用它起工作流子对话。带 id：重名、不在项目可选列表里也认得出
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
