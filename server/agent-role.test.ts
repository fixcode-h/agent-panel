import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AgentInput, type Agent } from '../shared/schema.ts'
import {
  commonAgents,
  composeRole,
  cycleText,
  defaultChatPrompt,
  includeCycle,
  includeCycles,
  includeDepth,
  includeTree,
  includedAgents,
  nodeAgentRun,
  renameParamRefs,
  renderTemplate,
  resolveParams,
  templateKeys,
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

test('参数联动：前面的选择决定后面显示哪些、能选哪些', () => {
  const params = AgentInput.parse({
    name: 'x',
    params: [
      { key: 'lang', type: 'select', options: ['ts', 'cpp', 'lua'], default: 'ts' },
      { key: 'strict', type: 'bool', default: true, when: { key: 'lang', values: ['ts'] } },
      {
        key: 'fw',
        type: 'select',
        options: ['React', 'Vue', 'UE', 'Qt'],
        default: 'React',
        optionsBy: { key: 'lang', map: { ts: ['React', 'Vue'], cpp: ['UE', 'Qt'], lua: [] } },
      },
      { key: 'ui', type: 'select', options: ['UMG', 'Slate'], ask: true, when: { key: 'fw', values: ['UE'] } },
      // 依赖后面的参数：条件不算数，照常显示
      { key: 'early', type: 'text', default: 'e', when: { key: 'late', values: ['x'] } },
      { key: 'late', type: 'select', options: ['x', 'y'], default: 'y' },
    ],
  }).params
  const ts = resolveParams(params)
  assert.deepEqual(ts.hidden, ['ui'])
  assert.deepEqual(ts.options.fw, ['React', 'Vue'])
  assert.equal(ts.values.fw, 'React')
  assert.equal(ts.values.early, 'e')
  assert.deepEqual(ts.missing, [])

  // 换成 cpp：开关隐藏按空值；默认值不在新选项里时退到第一个可选项；隐藏的必填参数现在要问
  const cpp = resolveParams(params, { lang: 'cpp', strict: true })
  assert.deepEqual(cpp.hidden, ['strict'])
  assert.equal(cpp.values.strict, false)
  assert.equal(cpp.values.fw, 'UE')
  assert.deepEqual(
    cpp.missing.map((p) => p.key),
    ['ui'],
  )
  // 选了 Qt：依赖 UE 的不再问
  assert.deepEqual(resolveParams(params, { lang: 'cpp', fw: 'Qt' }).missing, [])
  // lua 对应空选项：这个参数不适用，依赖它的也跟着隐藏
  const lua = resolveParams(params, { lang: 'lua' })
  assert.deepEqual(lua.hidden, ['strict', 'fw', 'ui'])

  // 角色设定里不出现隐藏参数的取值
  const a = agent('a', { params, instructions: '{{#if strict}}严格{{else}}宽松{{/if}}' })
  const text = composeRole(a, [a], { lang: 'cpp' })
  assert.match(text, /宽松/)
  assert.doesNotMatch(text, /strict/)
})

test('参数改名：角色设定里的引用一起改，别的写法不动', () => {
  const text = '{{mode}} {{#if mode=a|b}}x{{else}}y{{/if}} {{#if !mode}}z{{/if}} {{model}} {{#if model}}m{{/if}}'
  assert.equal(
    renameParamRefs(text, 'mode', 'level'),
    '{{level}} {{#if level=a|b}}x{{else}}y{{/if}} {{#if !level}}z{{/if}} {{model}} {{#if model}}m{{/if}}',
  )
  assert.deepEqual([...templateKeys(text)].sort(), ['mode', 'model'])
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

test('默认对话：连续工具操作时注入可见进度要求', () => {
  const prompt = defaultChatPrompt('用户要求', '', true, false)
  assert.match(prompt, /用户要求[\s\S]*连续做两次以上工具操作前先用一句话说明当前目标/)
  assert.equal(defaultChatPrompt('用户要求', 'agent-1', true, false), '用户要求')
  assert.equal(defaultChatPrompt('用户要求', '', true, true), '用户要求')
})

test('引入：层级、太深和循环', () => {
  const chain = ['a', 'b', 'c', 'd', 'e'].map((id, i, all) => agent(id, { includes: all[i + 1] ? [all[i + 1]] : [] }))
  assert.equal(includeDepth(chain[0], chain), 4)
  assert.deepEqual(
    includeTree(chain[0], chain).map((r) => `${r.id}${r.depth}`),
    ['b1', 'c2', 'd3', 'e4'],
  )
  // 执行时只展开 3 层
  assert.deepEqual(
    includedAgents(chain[0], chain).map((x) => x.agent.id),
    ['b', 'c', 'd'],
  )
  assert.deepEqual(includeCycle(chain[0], chain), [])

  const a = agent('a', { name: 'A', includes: ['b'] })
  const b = agent('b', { name: 'B', includes: ['c'] })
  const c = agent('c', { name: 'C', includes: ['a'] })
  const loop = [a, b, c, agent('x', { includes: ['a'] })]
  assert.deepEqual(includeCycle(a, loop), ['a', 'b', 'c', 'a'])
  assert.equal(cycleText(includeCycle(b, loop), loop), 'B → C → A → B')
  // x 引入了循环里的 a，但自己不在循环里
  assert.deepEqual(includeCycle(loop[3], loop), [])
  assert.equal(includeCycles(loop).length, 1)
  const tree = includeTree(a, loop)
  assert.deepEqual(
    tree.map((r) => [r.id, r.depth, !!r.cycle]),
    [
      ['b', 1, false],
      ['c', 2, false],
      ['a', 3, true],
    ],
  )
  assert.deepEqual(includeCycle(agent('s', { includes: ['s'] }), []), ['s', 's'])
})

test('通用 Agent：停用的不算', () => {
  const list = [agent('a', { common: true }), agent('b', { common: true, enabled: false }), agent('c')]
  assert.deepEqual(
    commonAgents(list).map((a) => a.id),
    ['a'],
  )
})
