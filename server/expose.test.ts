import assert from 'node:assert/strict'
import test from 'node:test'
import { Workflow } from '../shared/schema.ts'
import {
  applyExpose,
  applyAgentExpose,
  applyNodeExpose,
  exposeSlots,
  exposeValue,
  exposeValues,
  fillSkills,
  fillSlots,
} from '../shared/expose.ts'

/**
 * 工作流暴露项：项目设置里填的值落到工作流说明、节点参数和技能槽上，
 * 并且在新建对话时定下来（快照），之后改设置不影响已经开始的对话。
 */
const workflow = (expose: unknown[]) =>
  Workflow.parse({
    id: 'wf',
    createdAt: '',
    updatedAt: '',
    name: '带配置的工作流',
    document: '项目结构按 {{projectStructure}} 来看，文档放 {{docRoot}}。',
    expose,
    flows: [
      {
        id: 'main',
        name: '主流程',
        nodes: [
          {
            id: 'a',
            title: '实现',
            agentId: 'w',
            instructions: '在 {{docRoot}} 下写文档。',
            params: { retries: 1, strict: false },
          },
        ],
        edges: [{ id: 'e1', from: 'start', to: 'a' }],
      },
    ],
  })

test('没填时用默认值，填了用项目的值', () => {
  const e = { key: 'docRoot', label: '文档目录', type: 'text', options: [], default: 'docs' } as const
  assert.equal(exposeValue(e as never, {}), 'docs')
  assert.equal(exposeValue(e as never, { docRoot: 'doc' }), 'doc')
  // 填了空字符串也当没填
  assert.equal(exposeValue(e as never, { docRoot: '  ' }), 'docs')
})

test('多选的默认值是数组，拼成逗号分隔的文本', () => {
  const e = { key: 'tags', label: '标签', type: 'multi', options: ['a', 'b'], default: ['a', 'b'] } as const
  assert.equal(exposeValue(e as never, {}), 'a, b')
})

test('没配到的槽保持原样，能一眼看出漏配；技能列表里残留的槽直接丢掉', () => {
  assert.equal(fillSlots('看 {{docRoot}}', {}), '看 {{docRoot}}')
  assert.equal(fillSlots('看 {{ docRoot }}', { docRoot: 'docs' }), '看 docs')
  assert.deepEqual(fillSkills(['project-documentation', '{{missing}}'], {}), ['project-documentation'])
  assert.deepEqual(fillSkills(['{{slot}}'], { slot: 'project-testing' }), ['project-testing'])
})

test('节点参数的覆盖按原来的类型写回，不会变成字符串', () => {
  const w = workflow([
    { key: 'retries', label: '重试', type: 'text', target: 'node', targetId: 'a' },
    { key: 'strict', label: '严格', type: 'bool', target: 'node' },
  ])
  const n = applyNodeExpose(w.flows[0].nodes[0], w, { retries: '3', strict: 'true' })
  assert.equal(n.params.retries, 3)
  assert.equal(n.params.strict, true)
})

test('节点参数的覆盖只作用于指定的节点；没填值的不动', () => {
  const w = workflow([{ key: 'retries', label: '重试', type: 'text', target: 'node', targetId: 'b' }])
  const n = applyNodeExpose(w.flows[0].nodes[0], w, { retries: '3' })
  assert.equal(n.params.retries, 1)
})

test('Agent 参数的覆盖写进节点参数，布尔值转成真正的布尔', () => {
  const w = workflow([{ key: 'reasoning', label: '深度思考', type: 'bool', target: 'agent', targetId: 'think' }])
  assert.equal(applyAgentExpose(w.flows[0].nodes[0], w, { reasoning: 'true' }).params.think, true)
  assert.equal(applyAgentExpose(w.flows[0].nodes[0], w, { reasoning: 'false' }).params.think, false)
})

test('解析后的工作流：说明和节点指令都换好值，说明后面追加文档类配置，expose 清空', () => {
  const w = workflow([
    { key: 'projectStructure', label: '项目结构', type: 'select', options: ['通用', 'UE'], default: '通用', target: 'skill' },
    { key: 'docRoot', label: '文档目录', type: 'text', default: 'docs' },
    { key: 'rule', label: '交付规则', type: 'text', target: 'document', targetId: '交付' },
  ])
  const out = applyExpose(w, { projectStructure: 'UE', rule: '打标签再发布' })
  assert.equal(out.document.includes('按 UE 来看'), true)
  assert.equal(out.document.includes('文档放 docs'), true)
  assert.equal(out.document.includes('## 交付\n打标签再发布'), true)
  assert.equal(out.flows[0].nodes[0].instructions, '在 docs 下写文档。')
  assert.deepEqual(out.expose, [])
})

test('技能槽只取 target=skill 的项：别的项已经落进说明和节点参数了', () => {
  const w = workflow([
    { key: 'projectStructure', label: '项目结构', type: 'select', options: ['通用', 'UE'], default: '通用', target: 'skill' },
    { key: 'docRoot', label: '文档目录', type: 'text', default: 'docs', target: 'document', targetId: '文档' },
  ])
  assert.deepEqual(exposeSlots(w, {}), { projectStructure: '通用' })
})

test('没有配置项的工作流原样返回，不做无谓的复制', () => {
  const w = workflow([])
  assert.equal(applyExpose(w, {}), w)
})

test('配置的值只解析一次：之后再改项目设置，已经解析出的快照不变', () => {
  const w = workflow([{ key: 'docRoot', label: '文档目录', type: 'text', default: 'docs' }])
  const params = { docRoot: 'docs' }
  const snapshot = applyExpose(w, params)
  params.docRoot = 'doc'
  assert.equal(snapshot.flows[0].nodes[0].instructions, '在 docs 下写文档。')
  assert.equal(exposeValues(w, params).docRoot, 'doc')
})
