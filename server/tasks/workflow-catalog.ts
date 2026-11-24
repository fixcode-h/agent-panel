import type { Project, Workflow } from '../../shared/schema.ts'
import { everyProjectOrigins } from '../../shared/builtin/catalog.ts'
import { entryFlow, topoOrder } from '../../shared/flow/index.ts'

/**
 * 父对话能启动的工作流（ADR 0044）：项目默认 + 项目设置里的可选列表 + 每个项目都能用的（定义上标了 everyProject，
 * 如「方案设计」：协调器的分诊表直接点名它，项目没勾也得起得来），去重后按名称、说明、适用场景和节点概览交给它挑
 */
export function workflowCatalog(project: Pick<Project, 'workflowIds'>, all: Workflow[], fallback?: Workflow) {
  const every = everyProjectOrigins()
  const picked = [
    fallback,
    ...project.workflowIds.map((id) => all.find((w) => w.id === id)),
    ...all.filter((w) => w.origin && every.has(w.origin)),
  ]
    .filter((w): w is Workflow => !!w)
    .filter((w, i, list) => list.findIndex((x) => x.id === w.id) === i)
  return picked.map((w) => ({
    id: w.id,
    name: w.name,
    description: w.description,
    when: w.when,
    notFor: w.notFor,
    kind: w.kind,
    steps: topoOrder(entryFlow(w))
      .map((n) => n.title.trim())
      .filter(Boolean)
      .slice(0, 8),
  }))
}
