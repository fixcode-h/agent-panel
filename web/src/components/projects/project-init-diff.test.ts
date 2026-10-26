import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_FILE_FORMAT, ProjectInput, Workflow } from '@shared/schema'
import type { ProjectProposal } from '@shared/project-init'
import { buildGroups } from './ProjectInitPanel'

const wf = Workflow.parse({
  id: 'w-general',
  name: '通用项目',
  createdAt: '',
  updatedAt: '',
  mainAgentId: '',
  expose: [],
})
const draft = ProjectInput.parse({
  name: '商城',
  description: '面向用户的商城网站',
  workflowId: 'w-general',
  childIsolation: 'worktree',
  gitPolicy: 'ask',
})
const proposal: ProjectProposal = {
  kind: 'project',
  name: '商城',
  description: '面向用户的商城网站',
  type: 'general',
  steps: [],
  reasons: {},
  docRoot: '',
  files: [],
  workflows: [{ id: 'w-general', name: '通用项目', verdict: 'default', reason: '' }],
  params: {},
  settings: [
    { key: 'gitPolicy', value: 'allow', reason: '' },
    { key: 'encoding', value: 'utf8', reason: '' },
  ],
}
const ctx = { workflows: [wf], activeId: 'w-general', fallbackId: '', globalFormat: DEFAULT_FILE_FORMAT }
const pendingOf = (d: typeof draft) =>
  buildGroups(proposal, d, ctx)
    .flatMap((g) => g.recs)
    .filter((r) => !r.same)

test('推荐里的工作流已经被删掉：不生成保存时会失败的应用项', () => {
  const stale: ProjectProposal = {
    ...proposal,
    workflows: [
      { id: 'gone', name: '已删除的默认工作流', verdict: 'default', reason: '' },
      { id: 'gone2', name: '已删除的可选工作流', verdict: 'optional', reason: '' },
    ],
  }
  const recs = buildGroups(stale, draft, ctx)
    .flatMap((g) => g.recs)
    .filter((r) => !r.same)
  assert.deepEqual(
    recs.filter((r) => r.id === 'workflow' || r.id === 'optional:gone2'),
    [],
  )
})

test('推荐差异：只算和当前设置不同的项，应用后不再有差异', () => {
  const pending = pendingOf(draft)
  assert.deepEqual(
    pending.map((r) => r.id),
    ['setting:gitPolicy'],
  )
  const applied = pending.reduce((d, r) => r.apply(d), draft)
  assert.equal(applied.gitPolicy, 'allow')
  assert.deepEqual(pendingOf(applied), [])
})
