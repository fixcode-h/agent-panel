import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WorkflowInput, type Workflow } from '../../shared/schema.ts'
import { BUILTIN_WORKFLOWS, buildWorkflow } from '../../shared/builtin/workflows.ts'
import { workflowCatalog } from './workflow-catalog.ts'

const copy = (key: string, id: string): Workflow => {
  const w = BUILTIN_WORKFLOWS.find((x) => x.key === key)!
  return {
    ...WorkflowInput.parse({ ...buildWorkflow(w, (k) => `agent-${k}`), categoryId: 'c' }),
    id,
    origin: `builtin:${key}`,
    createdAt: '',
    updatedAt: '',
  } as Workflow
}

test('方案设计工作流每个项目都能启动：项目没勾也在可用工作流里，勾了不重复（用户 2026-11-24）', () => {
  const general = copy('project-general', 'g')
  const design = copy('architecture', 'd')
  const review = copy('review', 'r')
  const all = [general, design, review]
  const names = (ids: string[]) => workflowCatalog({ workflowIds: ids }, all, general).map((w) => w.name)
  assert.deepEqual(names([]), ['通用项目', '方案设计'])
  assert.deepEqual(names(['d', 'r']), ['通用项目', '方案设计', '代码评审'])
  // 用户删掉了它的副本就没有，不凭空造
  assert.deepEqual(
    workflowCatalog({ workflowIds: [] }, [general, review], general).map((w) => w.name),
    ['通用项目'],
  )
})
