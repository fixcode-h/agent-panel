import { LEGACY_DEFAULT_AGENT_ID, inferStepScope } from '../schema.ts'
import { stagesToFlow } from '../flow/stages.ts'

/**
 * 工作流、项目、任务记录的几种旧格式换成当前格式（数据迁移 0011，复查清单「schema.ts 把数据定义和历史迁移绑在一起」）。
 * 以前挂在 shared/schema.ts 的 z.preprocess 上每次读都转一遍；现在只在这几处转一次：
 * - 数据目录：server/migrations/0011-legacy-shapes.ts（0001 拆旧任务文件时也先过一遍）
 * - 导出的任务文件：shared/tasks/export-upgrade.ts 的第 6 版
 * - 旧版导出的工作流文件：shared/agents/share.ts 的 readLegacy
 * - 演示版 localStorage：web/src/lib/demo/demo-backend.ts 的 load
 *
 * 全部就地改原始 JSON、返回有没有改，和 liftChildFields 这类 lift 函数一个写法；
 * 已经是新格式的原样不动（幂等，重复跑不会再改）
 */

type Raw = Record<string, unknown>

const isObj = (v: unknown): v is Raw => !!v && typeof v === 'object' && !Array.isArray(v)

/** 工作流：旧版的「阶段」换成流程图；旧「团队」里指向已去掉的默认 Agent 的成员去掉 */
export function migrateWorkflowShape(w: Raw): boolean {
  let changed = false
  if (!(Array.isArray(w.flows) && w.flows.length)) {
    const stages = Array.isArray(w.stages) ? (w.stages as { nodes?: Raw[] }[]) : []
    w.flows = [stagesToFlow(stages)]
    w.entryFlowId = 'main'
    changed = true
  }
  if ('stages' in w) {
    delete w.stages // delete-ok: 原始 JSON，不是经 store.update 合并的数据
    changed = true
  }
  if (Array.isArray(w.members)) {
    const kept = w.members.filter((m) => !isObj(m) || m.agentId !== LEGACY_DEFAULT_AGENT_ID)
    if (kept.length !== w.members.length) {
      w.members = kept
      changed = true
    }
  }
  return changed
}

/** 一组测试步骤：老步骤的 runInParent 换算成 scope（见 shared/schema.ts 的 inferStepScope） */
export function migrateTestSteps(steps: unknown): boolean {
  if (!Array.isArray(steps)) return false
  let changed = false
  steps.forEach((s, i) => {
    if (!isObj(s) || s.scope !== undefined) return
    steps[i] = inferStepScope(s)
    changed = true
  })
  return changed
}

/** 项目：单层的 workflowParams 按工作流分组；测试步骤（含保存的初始化推荐里的）换算 scope */
export function migrateProjectShape(p: Raw): boolean {
  let changed = false
  const raw = p.workflowParams
  if (isObj(raw)) {
    const vals = Object.values(raw)
    // 单层：值都是标量或数组（一个暴露项一个值）；分组后的值是对象（一个工作流一组）
    const single = vals.length > 0 && vals.every((x) => x === null || typeof x !== 'object' || Array.isArray(x))
    if (single) {
      p.workflowParams = p.workflowId ? { [String(p.workflowId)]: raw } : {}
      changed = true
    }
  }
  if (migrateTestSteps(p.testSteps)) changed = true
  if (isObj(p.initResult) && migrateTestSteps(p.initResult.steps)) changed = true
  return changed
}

/**
 * 任务记录：步骤补 id / nodeId，消息的节点下标换成节点 id，旧 queue 里没处理的普通要求补到对话末尾
 * （等 CLI 取走的补充丢掉），工作流快照和测试步骤快照按上面一起换。
 * 返回补进对话的那几条（数据目录里还要追加进对话文件），没有就是空数组；changed 表示记录本身改没改
 */
export function migrateTaskShape(t: Raw, now = new Date().toISOString()): { changed: boolean; queued: Raw[] } {
  let changed = false
  const steps = Array.isArray(t.steps) ? (t.steps as Raw[]) : []
  steps.forEach((s, i) => {
    if (!isObj(s)) return
    if (typeof s.id !== 'string') {
      s.id = `s${i}`
      changed = true
    }
    if (s.nodeId === undefined) {
      s.nodeId = s.id
      changed = true
    }
  })
  const messages = Array.isArray(t.messages) ? (t.messages as Raw[]) : []
  for (const m of messages) {
    if (!isObj(m) || typeof m.step !== 'number') continue
    m.step = m.step >= 0 ? String(steps[m.step]?.id ?? '') : ''
    changed = true
  }
  const queued: Raw[] = []
  if ('queue' in t) {
    const queue = Array.isArray(t.queue) ? t.queue : []
    queue.forEach((q, i) => {
      if (!isObj(q) || q.note === true || typeof q.text !== 'string' || !q.text.trim()) return
      queued.push({
        id: typeof q.id === 'string' && q.id ? q.id : `q${i}`,
        role: 'user',
        agentId: '',
        step: '',
        text: q.text,
        tools: [],
        ...(Array.isArray(q.attachments) && q.attachments.length ? { attachments: q.attachments } : {}),
        at: typeof q.at === 'string' && q.at ? q.at : now,
      })
    })
    if (queued.length) t.messages = [...messages, ...queued]
    delete t.queue // delete-ok: 原始 JSON，不是经 store.update 合并的数据
    changed = true
  }
  const snapshots = [t.workflows, ...(Array.isArray(t.runs) ? t.runs.map((r) => (isObj(r) ? r.workflows : [])) : [])]
  for (const list of snapshots)
    if (Array.isArray(list)) for (const w of list) if (isObj(w) && migrateWorkflowShape(w)) changed = true
  if (migrateTestSteps(t.testSteps)) changed = true
  return { changed, queued }
}
