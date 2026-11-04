import { rewriteVerdictText } from '../shared/verdict.ts'
import { log } from './log.ts'

/**
 * 启动时把用户存下来的角色、工作流里「最后一行写『验收结论：通过』」这类旧要求改成「调用 submit_verdict 交结论」
 * （ADR 0049 第三期）。面板早就只认 submit_verdict，旧说法会让模型只写一行字、不调工具，被追问一次后按出错停下。
 * 只改这几句，别的原样；没有旧说法的不写盘。已经开始的对话里存的快照不改：它们按开始时的样子跑完
 */
interface Coll<T> {
  list: () => Promise<T[]>
  update: (id: string, input: never) => Promise<unknown>
}
type AgentLike = { id: string; instructions: string; createdAt?: string; updatedAt?: string }
type WorkflowLike = {
  id: string
  document: string
  flows: { nodes: { instructions?: string }[] }[]
  createdAt?: string
  updatedAt?: string
}

export async function migrateVerdictText(agents: Coll<AgentLike>, workflows: Coll<WorkflowLike>) {
  let n = 0
  for (const a of await agents.list()) {
    const next = rewriteVerdictText(a.instructions)
    if (next === a.instructions) continue
    const { id, createdAt: _c, updatedAt: _u, ...input } = a
    await agents.update(id, { ...input, instructions: next } as never)
    n++
  }
  for (const w of await workflows.list()) {
    const document = rewriteVerdictText(w.document)
    const flows = w.flows.map((f) => ({
      ...f,
      nodes: f.nodes.map((x) => (x.instructions ? { ...x, instructions: rewriteVerdictText(x.instructions) } : x)),
    }))
    if (document === w.document && JSON.stringify(flows) === JSON.stringify(w.flows)) continue
    const { id, createdAt: _c, updatedAt: _u, ...input } = w
    await workflows.update(id, { ...input, document, flows } as never)
    n++
  }
  if (n) log.info('server', '旧角色、工作流里「写一行验收结论」的要求改成了调用 submit_verdict', { count: n })
}
