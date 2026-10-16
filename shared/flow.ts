/**
 * 工作流的流程图：阶段从左到右依次执行，阶段内的节点并行。
 * 这里放前后端共用的逻辑：旧文档迁移、生成默认流程、把流程展开成任务节点。
 */
import type { Agent, TaskStep, Workflow, WorkflowMember, WorkflowStage } from './schema.ts'

const rand = () => Math.random().toString(36).slice(2, 10)
export const flowId = (prefix: 'st' | 'nd') => `${prefix}_${rand()}`

const stripTitle = (s: string) =>
  s
    .replace(/^\d+\s*[.、．]\s*/, '')
    .replace(/@\S+/g, '')
    .trim()

/**
 * 旧版工作流把步骤写在文档的二级标题里（`## 1. 标题 @Agent`）。
 * 迁移成一步一个阶段的流程，并把这些步骤从文档里拿掉，只留下目标、规范等说明。
 */
export function migrateDocSteps(
  w: { document: string; mainAgentId: string; members: WorkflowMember[] },
  agents: Agent[],
): { stages: WorkflowStage[]; document: string } {
  const doc = w.document ?? ''
  const team = [w.mainAgentId, ...w.members.map((m) => m.agentId)]
    .map((id) => agents.find((a) => a.id === id))
    .filter(Boolean) as Agent[]
  const heads = [...doc.matchAll(/^##\s+(.+)$/gm)]
  if (!heads.length) return { stages: [], document: doc }
  const stages: WorkflowStage[] = []
  const cut: [number, number][] = []
  for (const h of heads) {
    const start = h.index!
    const after = start + h[0].length
    const rest = doc.slice(after)
    const end = rest.search(/^#{1,2}\s/m)
    const stop = end < 0 ? doc.length : after + end
    const who = team.find((a) => h[1].includes(`@${a.name}`))
    const title = stripTitle(h[1]) || h[1].trim()
    stages.push({
      id: flowId('st'),
      title: '',
      nodes: [
        {
          id: flowId('nd'),
          title: title.slice(0, 60),
          agentId: who && who.id !== w.mainAgentId ? who.id : '',
          instructions: doc.slice(after, stop).trim(),
        },
      ],
    })
    cut.push([start, stop])
  }
  let left = doc
  for (const [a, b] of [...cut].reverse()) left = left.slice(0, a) + left.slice(b)
  // 步骤拿掉后只剩标题的「# 步骤」也一起去掉
  left = left
    .replace(/^#\s*(步骤|流程|执行步骤)\s*\n(\s*\n)*(?=#|$)/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { stages, document: left ? left + '\n' : '' }
}

/** 按团队生成一个默认流程：主 Agent 分析 → 子 Agent 并行实现 → 主 Agent 验收 */
export function flowTemplate(members: { agent: Agent; responsibility: string }[]): WorkflowStage[] {
  const node = (title: string, agentId: string, instructions: string) => ({
    id: flowId('nd'),
    title,
    agentId,
    instructions,
  })
  return [
    {
      id: flowId('st'),
      title: '分析',
      nodes: [node('分析需求、拆分任务', '', '阅读需求和相关代码，列出要改动的部分、每个节点的分工和验收标准。')],
    },
    {
      id: flowId('st'),
      title: '实现',
      nodes: members.length
        ? members.map((m) =>
            node(
              (m.responsibility || m.agent.description || m.agent.name).slice(0, 60),
              m.agent.id,
              '按分析阶段的分工完成自己负责的部分，只改自己负责的文件，完成后说明改了什么。',
            ),
          )
        : [node('实现', '', '按分析阶段的结论完成改动，并自测。')],
    },
    {
      id: flowId('st'),
      title: '验收',
      nodes: [node('验收', '', '逐条对照验收标准检查结果，列出没满足的地方。')],
    },
  ]
}

export const stageLabel = (title: string, index: number) => title.trim() || `阶段 ${index + 1}`

/** 节点的执行 Agent：没指定时是主 Agent */
export const nodeAgent = (w: Workflow, agentId: string) => agentId || w.mainAgentId

/** 把工作流展开成任务的阶段和节点 */
export function planTask(
  workflow: Workflow | undefined,
  agents: Agent[],
): { stages: { title: string }[]; steps: TaskStep[] } {
  if (!workflow) return { stages: [], steps: [] }
  let stages = workflow.stages.filter((s) => s.nodes.length)
  if (!stages.length) {
    const byId = new Map(agents.map((a) => [a.id, a]))
    stages = flowTemplate(
      workflow.members
        .map((m) => ({
          agent: byId.get(m.agentId)!,
          responsibility: m.responsibility,
        }))
        .filter((m) => m.agent),
    )
  }
  const steps: TaskStep[] = []
  stages.forEach((st, si) =>
    st.nodes.forEach((n, ni) =>
      steps.push({
        id: n.id,
        stage: si,
        title: n.title.trim() || `节点 ${ni + 1}`,
        agentId: nodeAgent(workflow, n.agentId),
        status: 'pending',
        startedAt: '',
        endedAt: '',
      }),
    ),
  )
  return {
    stages: stages.map((s, i) => ({ title: stageLabel(s.title, i) })),
    steps,
  }
}

/** 找到任务节点对应的工作流节点（取它的说明） */
export function findNode(workflow: Workflow | undefined, id: string) {
  for (const s of workflow?.stages ?? []) for (const n of s.nodes) if (n.id === id) return n
  return undefined
}

/** 任务的阶段分组：[{ index, title, steps: [{ step, i }] }] */
export function taskStages(task: { stages: { title: string }[]; steps: TaskStep[] }) {
  const groups = new Map<number, { step: TaskStep; i: number }[]>()
  task.steps.forEach((step, i) => {
    const g = groups.get(step.stage) ?? []
    g.push({ step, i })
    groups.set(step.stage, g)
  })
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, steps]) => ({
      index,
      title: task.stages[index]?.title || `阶段 ${index + 1}`,
      steps,
    }))
}
