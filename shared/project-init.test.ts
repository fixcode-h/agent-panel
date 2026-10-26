import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildAssistPrompt, resolveProposal, type AssistContext } from './assist.ts'
import { ProjectInput, Workflow } from './schema.ts'
import { ProjectProposalSchema, readProjectProposal, withInitResult, type ProjectProposal } from './project-init.ts'

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

const savedProposal: ProjectProposal = {
  kind: 'project',
  name: '商城',
  description: '面向用户的商城网站',
  type: 'general',
  steps: [],
  reasons: { name: 'package.json 的 name' },
  docRoot: 'docs',
  files: [{ path: 'AGENTS.md', action: 'created', summary: '新建' }],
  workflows: [{ id: 'w-general', name: '通用项目', verdict: 'default', reason: '日常改动' }],
  params: { docRoot: 'docs' },
  settings: [
    { key: 'gitPolicy', value: 'allow', reason: '平时直接推送' },
    { key: 'searchExclude', value: ['Saved'], reason: '' },
  ],
}

test('只更新初始化结果：已经应用过的推荐和用户改过的设置不会被写回旧值', () => {
  // 应用推荐之后，项目已经是最新值；这时初始化的结果才回来（对话可能跑了几分钟）
  const applied = ProjectInput.parse({
    name: '商城',
    description: '应用后的简介',
    testSteps: [{ id: 'unit', name: '单元测试', command: 'npm test' }],
    initializedAt: '2026-10-01T00:00:00Z',
  })
  const next = withInitResult(applied, savedProposal)
  assert.equal(next.name, '商城')
  assert.equal(next.description, '应用后的简介')
  assert.deepEqual(next.testSteps, applied.testSteps)
  // 已经初始化过的时间不刷新，重跑一次初始化不应该改掉它
  assert.equal(next.initializedAt, '2026-10-01T00:00:00Z')
  assert.deepEqual(next.initResult, savedProposal)
  // 还没初始化过的项目这次补上
  const fresh = ProjectInput.parse({ name: '新项目' })
  assert.equal(withInitResult(fresh, savedProposal, '2026-10-26T00:00:00Z').initializedAt, '2026-10-26T00:00:00Z')
})

test('保存的初始化结果：旧项目没有这个字段时按没有推荐处理', () => {
  const p = ProjectInput.parse({ name: '旧项目' })
  assert.equal(p.initializedAt, '')
  assert.equal(p.initResult, undefined)
})

test('保存的初始化结果：读数据文件时结构不对按没有推荐处理', () => {
  assert.equal(readProjectProposal(undefined), undefined)
  assert.equal(readProjectProposal({ settings: 'oops' }), undefined)
  assert.deepEqual(readProjectProposal(savedProposal), savedProposal)
})

test('保存的初始化结果：按 ProjectProposalSchema 原样读写，坏设置值被拒绝', () => {
  const back = ProjectProposalSchema.parse(JSON.parse(JSON.stringify(savedProposal)))
  assert.deepEqual(back, savedProposal)
  assert.deepEqual(ProjectInput.parse({ name: '商城', initResult: savedProposal }).initResult, savedProposal)
  assert.equal(
    ProjectProposalSchema.safeParse({ ...savedProposal, settings: [{ key: 'encoding', value: 'gbk' }] }).success,
    false,
  )
  assert.equal(
    ProjectProposalSchema.safeParse({ ...savedProposal, settings: [{ key: 'unknown', value: true }] }).success,
    false,
  )
})
