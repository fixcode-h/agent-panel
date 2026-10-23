import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildAssistPrompt, resolveProposal, type AssistContext } from './assist.ts'
import { ProjectInput, Workflow } from './schema.ts'

const wf = (id: string, name: string, expose: unknown[] = []) =>
  Workflow.parse({ id, name, createdAt: '', updatedAt: '', mainAgentId: '', expose })
const general = wf('w-general', '通用项目', [
  { key: 'docRoot', label: '文档根', type: 'text', target: 'agent', targetId: 'docRoot' },
  {
    key: 'projectStructure',
    type: 'select',
    options: ['project-structure', 'ue-project-structure'],
    target: 'skill',
    targetId: 'projectStructure',
  },
])
const bugfix = wf('w-bug', 'Bug 修复')
const review = wf('w-review', '代码评审')
const ctx: AssistContext = {
  agents: [],
  categories: [],
  workflows: [general, bugfix, review],
  rules: '',
  projectPath: '/code/shop',
  defaultWorkflowIds: ['w-general'],
  platform: 'linux',
}

test('初始化结果：工作流名换成 id，默认只能从「项目」分类里选、只留一个', () => {
  const r = resolveProposal(
    'project',
    {
      name: '商城',
      workflows: [
        { name: 'Bug 修复', verdict: 'default', reason: '不在项目分类里' },
        { name: '通用项目', verdict: 'default', reason: '日常改动' },
        { name: '代码评审', verdict: 'skip' },
        { name: '不存在的工作流', verdict: 'optional' },
      ],
    },
    ctx,
  )
  assert.ok(r.proposal && r.proposal.kind === 'project')
  assert.deepEqual(
    r.proposal.workflows.map((w) => [w.id, w.verdict]),
    [
      ['w-bug', 'optional'],
      ['w-general', 'default'],
      ['w-review', 'skip'],
    ],
  )
})

test('初始化结果：参数按默认工作流的暴露项校验，设置项只留认识的 key 和合法的值', () => {
  const r = resolveProposal(
    'project',
    {
      name: '商城',
      workflows: [{ name: '通用项目', verdict: 'default' }],
      params: { docRoot: 'docs', projectStructure: 'nope', unknown: 1 },
      settings: {
        childIsolation: { value: 'claim', reason: 'P4 项目' },
        gitPolicy: 'deny',
        eol: { value: 'cr' },
        searchExclude: { value: ['Saved', 'Intermediate'] },
        whatever: { value: true },
      },
    },
    ctx,
  )
  assert.ok(r.proposal && r.proposal.kind === 'project')
  assert.deepEqual(r.proposal.params, { docRoot: 'docs' })
  assert.deepEqual(
    r.proposal.settings.map((s) => [s.key, s.value, s.reason]),
    [
      ['childIsolation', 'claim', 'P4 项目'],
      ['gitPolicy', 'deny', ''],
      ['searchExclude', ['Saved', 'Intermediate'], ''],
    ],
  )
})

test('初始化结果：文件已经写好，步骤格式不对只丢掉步骤，不让 CLI 重跑', () => {
  const r = resolveProposal(
    'project',
    {
      name: '商城',
      files: [{ path: 'AGENTS.md', action: 'created', summary: '新建' }, { path: '' }],
      steps: [{ name: '', command: '' }],
    },
    ctx,
  )
  assert.ok(r.proposal && r.proposal.kind === 'project')
  assert.deepEqual(r.proposal.steps, [])
  assert.deepEqual(r.proposal.files, [{ path: 'AGENTS.md', action: 'created', summary: '新建' }])
  // 没有名称还是不行：至少要知道项目叫什么
  assert.ok(resolveProposal('project', { description: 'x' }, ctx).error)
})

test('初始化提示词：要求写 AGENTS.md 和文档框架，列出已有工作流和默认工作流的暴露项', () => {
  const p = buildAssistPrompt('project', ctx, [{ role: 'user', text: '初始化这个项目' }], [])
  assert.match(p, /AGENTS\.md/)
  assert.match(p, /MODULE-MAP\.md/)
  assert.match(p, /「通用项目」（可作默认）/)
  assert.match(p, /docRoot（文档根/)
  assert.doesNotMatch(p, /「Bug 修复」（可作默认）/)
})

test('旧项目没有初始化标记：读出来是空的，项目设置里要先初始化才能保存', () => {
  assert.equal(ProjectInput.parse({ name: '旧项目' }).initializedAt, '')
})
