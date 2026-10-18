import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AgentInput, type Agent } from '../shared/schema.ts'
import {
  composeRole,
  includedAgents,
  nodeAgentRun,
  renderTemplate,
  resolveParams,
  wouldCycle,
} from '../shared/agent-role.ts'

const agent = (id: string, o: Partial<AgentInput> = {}): Agent => ({
  ...AgentInput.parse({ name: id, ...o }),
  id,
  createdAt: '',
  updatedAt: '',
})

test('模板：替换参数、条件分支和嵌套', () => {
  const v = { level: '严格', focus: ['正确性', '安全'], on: true }
  assert.equal(renderTemplate('重点：{{focus}}', v), '重点：正确性、安全')
  assert.equal(renderTemplate('{{#if level=严格}}A{{else}}B{{/if}}', v), 'A')
  assert.equal(renderTemplate('{{#if level=快速|标准}}A{{else}}B{{/if}}', v), 'B')
  assert.equal(renderTemplate('{{#if level!=快速}}A{{/if}}', v), 'A')
  assert.equal(renderTemplate('{{#if focus=安全}}S{{/if}}', v), 'S')
  assert.equal(renderTemplate('{{#if !on}}X{{else}}Y{{/if}}', v), 'Y')
  assert.equal(
    renderTemplate('{{#if level=严格}}1{{else}}{{#if level=快速}}2{{else}}3{{/if}}{{/if}}', { level: '快速' }),
    '2',
  )
  // 不认识的参数原样保留
  assert.equal(renderTemplate('{{unknown}}', v), '{{unknown}}')
})

test('参数：给的值覆盖默认值，没默认值的要问', () => {
  const params = AgentInput.parse({
    name: 'x',
    params: [
      { key: 'level', type: 'select', options: ['快速', '严格'], default: '快速' },
      { key: 'who', type: 'select', options: ['用户', '开发者'], ask: true },
      { key: 'deep', type: 'bool', default: true },
    ],
  }).params
  const r = resolveParams(params, { deep: false, level: '不存在的选项' })
  assert.deepEqual(r.values, { level: '快速', deep: false })
  assert.deepEqual(
    r.missing.map((p) => p.key),
    ['who'],
  )
  assert.equal(resolveParams(params, { who: '用户' }).missing.length, 0)
})

test('引入：展开间接引入，跳过循环', () => {
  const a = agent('a', { instructions: '我是 A', includes: ['b'] })
  const b = agent('b', { instructions: '我是 B', includes: ['c', 'a'] })
  const c = agent('c', { instructions: '我是 C', skills: ['pdf'] })
  const all = [a, b, c]
  assert.deepEqual(
    includedAgents(a, all).map((x) => x.agent.id),
    ['b', 'c'],
  )
  assert.equal(wouldCycle('c', 'a', all), true)
  assert.equal(wouldCycle('a', 'c', [a, agent('b'), c]), false)
  const role = composeRole(a, all)
  assert.match(role, /我是 A[\s\S]*引入的 Agent：b[\s\S]*我是 B[\s\S]*我是 C[\s\S]*`pdf`/)
})

test('节点：固定用默认 CLI 的档位', () => {
  const a = agent('a', { cli: 'codex', model: '@high', effort: 'xhigh' })
  assert.deepEqual(
    { cli: nodeAgentRun(a, '').cli, model: nodeAgentRun(a, '').model, effort: nodeAgentRun(a, '').effort },
    { cli: '', model: '@high', effort: '' },
  )
  assert.equal(nodeAgentRun(a, 'low').model, '@low')
  assert.equal(nodeAgentRun(agent('b', { model: 'gpt-5' }), '').model, '@medium')
})
