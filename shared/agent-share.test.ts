import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Agent, Workflow } from '../shared/schema.ts'
import {
  AGENT_LOCAL_FIELDS,
  copyName,
  readShare,
  scrubAgent,
  scrubWorkflow,
  shareFileName,
  shareFingerprint,
  sharePackage,
} from '../shared/agent-share.ts'

const at = '2026-01-01T00:00:00.000Z'

function agent(over: Record<string, unknown> = {}) {
  return Agent.parse({
    id: 'a1',
    createdAt: at,
    updatedAt: at,
    name: '我的角色',
    instructions: '你是执行者。',
    categoryId: 'c1',
    tags: ['t1'],
    includes: ['a2'],
    extraArgs: ['--add-dir', 'D:/work/shared'],
    origin: '',
    ...over,
  })
}

function workflow(over: Record<string, unknown> = {}) {
  return Workflow.parse({
    id: 'w1',
    createdAt: at,
    updatedAt: at,
    name: '我的流程',
    mainAgentId: 'a1',
    categoryId: 'c1',
    tags: ['t1'],
    origin: 'builtin:general',
    builtinHash: 'abc',
    flows: [
      {
        id: 'main',
        name: '主流程',
        nodes: [
          { id: 'nd_1', title: '改代码', agentId: 'a1', x: 120, y: 40 },
          { id: 'nd_2', title: '跑测试', agentId: 'a2', steps: [{ id: 'st_1', agentId: 'a1', title: '编译' }] },
        ],
        edges: [{ id: 'e1', from: 'start', to: 'nd_1' }],
      },
    ],
    ...over,
  })
}

test('分享包：角色的本机字段不进包（分类、标签、引入、CLI 参数、来源）', () => {
  const pkg = sharePackage('agent', agent(), at)
  assert.equal(pkg.kind, 'agent')
  if (pkg.kind !== 'agent') return
  assert.equal(pkg.agent.name, '我的角色')
  assert.equal(pkg.agent.instructions, '你是执行者。')
  assert.deepEqual(pkg.agent.categoryId, '')
  assert.deepEqual(pkg.agent.tags, [])
  assert.deepEqual(pkg.agent.includes, [])
  assert.deepEqual(pkg.agent.extraArgs, [], 'CLI 参数可能写着本机路径，不随包走')
  assert.equal(pkg.agent.origin, '')
  assert.equal('id' in pkg.agent, false, '本机 id 不进包')
})

test('分享包：工作流剥掉主 Agent 和节点上选的角色，流程结构和坐标保留', () => {
  const pkg = sharePackage('workflow', workflow(), at)
  assert.equal(pkg.kind, 'workflow')
  if (pkg.kind !== 'workflow') return
  const w = pkg.workflow
  assert.equal(w.mainAgentId, '')
  assert.equal(w.categoryId, '')
  assert.deepEqual(w.tags, [])
  assert.equal(w.origin, undefined)
  assert.equal(w.builtinHash, undefined)
  assert.deepEqual(
    w.flows[0].nodes.map((n) => [n.id, n.agentId]),
    [
      ['nd_1', ''],
      ['nd_2', ''],
    ],
  )
  assert.equal(w.flows[0].nodes[1].steps[0].agentId, '')
  assert.equal(w.flows[0].nodes[0].x, 120, '画布位置保留，导入后形状不变')
  assert.deepEqual(w.flows[0].edges, [{ id: 'e1', from: 'start', to: 'nd_1' }])
})

test('分享包：同一内容反复导出的指纹一样，导出时间不影响指纹', () => {
  const a = sharePackage('agent', agent(), at)
  const b = sharePackage('agent', agent({ updatedAt: '2026-05-05T00:00:00.000Z' }), '2026-06-06T00:00:00.000Z')
  assert.equal(a.fingerprint, b.fingerprint)
  assert.equal(a.exportedAt === b.exportedAt, false, '导出时间各记各的')
})

test('分享包：内容变了指纹就变（判断「是不是同一版」靠它）', () => {
  const a = sharePackage('agent', agent(), at)
  const b = sharePackage('agent', agent({ instructions: '你是评审。' }), at)
  assert.notEqual(a.fingerprint, b.fingerprint)
})

test('分享包：读回自己导出的包能过校验', () => {
  for (const pkg of [sharePackage('agent', agent(), at), sharePackage('workflow', workflow(), at)]) {
    const read = readShare(JSON.parse(JSON.stringify(pkg)))
    assert.equal(read.ok, true, read.ok === false ? read.info : '')
  }
})

test('分享包：手改内容后指纹对不上，直接拒绝', () => {
  const pkg = sharePackage('agent', agent(), at)
  const tampered = { ...pkg, agent: { ...pkg.agent, instructions: '手改过的设定' } }
  const read = readShare(tampered)
  assert.equal(read.ok, false)
  assert.match(read.ok === false ? read.info : '', /指纹和内容对不上/)
})

test('分享包：本机字段不算内容（手改它们指纹不变），但导入时会被再剥一次，绕不出内置保护', () => {
  const pkg = sharePackage('agent', agent(), at)
  if (pkg.kind !== 'agent') return
  const tampered = { ...pkg, agent: { ...pkg.agent, origin: 'builtin:reviewer', categoryId: '别人的分类' } }
  const read = readShare(tampered)
  assert.equal(read.ok, true, '指纹只算会跨机器搬的内容')
  assert.equal(read.ok === true && read.pkg.kind === 'agent' ? scrubAgent(read.pkg.agent).origin : 'x', '')
})

test('分享包：格式版本不认识时拒绝，并说清两边的版本', () => {
  const pkg = { ...sharePackage('agent', agent(), at), version: 99 }
  const read = readShare(pkg)
  assert.equal(read.ok, false)
  assert.match(read.ok === false ? read.info : '', /99/)
})

test('分享包：不是分享包的结构时拒绝（zod 校验）', () => {
  assert.equal(readShare({ hello: 1 }).ok, false)
  assert.equal(readShare(null).ok, false)
  assert.equal(readShare('文本').ok, false)
})

test('分享包：另存为副本的名字避开已有的', () => {
  assert.equal(copyName('角色', []), '角色（副本）')
  assert.equal(copyName('角色', ['角色（副本）']), '角色（副本 2）')
  assert.equal(copyName('角色', ['角色（副本）', '角色（副本 2）']), '角色（副本 3）')
})

test('分享包：下载文件名去掉不能用在文件名里的字符', () => {
  const pkg = sharePackage('agent', agent({ name: 'a/b:c*?"<>| d' }), at)
  assert.equal(shareFileName(pkg), 'a-b-c-d.agent.json')
})

test('分享包：剥本机字段的工具对已剥过的内容幂等', () => {
  const once = scrubAgent(agent())
  assert.deepEqual(scrubAgent(once), once)
  const wf = scrubWorkflow(workflow())
  assert.deepEqual(scrubWorkflow(wf), wf)
})

test('分享包：工作流带上用到的角色，保留原 id 只为接回节点引用，本机字段一样剥掉', () => {
  const pkg = sharePackage('workflow', workflow(), at, [agent()])
  if (pkg.kind !== 'workflow') return
  assert.equal(pkg.agents.length, 1)
  assert.equal(pkg.agents[0].id, 'a1')
  assert.equal(pkg.agents[0].instructions, '你是执行者。')
  assert.deepEqual(pkg.agents[0].categoryId, '')
  assert.deepEqual(pkg.agents[0].extraArgs, [])
  // 角色设定变了，整个包的指纹也跟着变（同一份包和本地的是不是同一版）
  const other = sharePackage('workflow', workflow(), at, [agent({ instructions: '改过的设定' })])
  assert.notEqual(pkg.fingerprint, other.fingerprint)
})

test('分享包：旧版导出的工作流文件还能读，标 legacy 提示没有指纹', () => {
  const raw = {
    format: 'agent-panel/workflow',
    version: 1,
    exportedAt: at,
    workflow: workflow(),
    agents: [{ ...agent(), id: 'a1' }],
  }
  const read = readShare(JSON.parse(JSON.stringify(raw)))
  assert.equal(read.ok, true, read.ok === false ? read.info : '')
  if (!read.ok) return
  assert.equal(read.legacy, true)
  assert.equal(read.pkg.kind, 'workflow')
  assert.equal(read.pkg.agents[0].id, 'a1', '旧文件里的角色 id 要留着，导入时接引用用')
})

test('分享包：旧版文件结构坏了时说清是哪一版的问题', () => {
  const read = readShare({ format: 'agent-panel/workflow', version: 1, workflow: { name: '' } })
  assert.equal(read.ok, false)
  assert.match(read.ok === false ? read.info : '', /旧版导出的工作流文件/)
})

test('分享包：角色包里带了「用到的角色」就拒绝（那是工作流包的字段，指纹对得上也不导入）', () => {
  const pkg = sharePackage('agent', agent(), at)
  if (pkg.kind !== 'agent') return
  const agents = [{ ...agent(), id: 'a1' }]
  // 连指纹一起算对：这条检查要能独立于指纹拦下结构不对的包
  const tampered = { ...pkg, agents, fingerprint: shareFingerprint({ kind: 'agent', agent: pkg.agent, agents }) }
  const read = readShare(tampered)
  assert.equal(read.ok, false)
  assert.match(read.ok === false ? read.info : '', /角色包里不该带其它角色/)
})

test('分享包：剥本机字段的清单只有一份（复位表即字段清单）', () => {
  const scrubbed = scrubAgent(agent())
  for (const key of AGENT_LOCAL_FIELDS) {
    const v = (scrubbed as unknown as Record<string, unknown>)[key]
    assert.ok(v === '' || v === undefined || (Array.isArray(v) && v.length === 0), `${key} 应当被复位`)
  }
})

test('分享包：读出来的包已经剥好本机字段，调用方直接落库也塞不进内置来源', () => {
  const pkg = sharePackage('agent', agent(), at)
  if (pkg.kind !== 'agent') return
  // 手改包：把 origin 改成内置来源、extraArgs 塞本机路径（这两项不参与指纹，能过校验）
  const tampered = {
    ...pkg,
    agent: { ...pkg.agent, origin: 'builtin:worker', extraArgs: ['--add-dir', 'D:/work/secret'] },
  }
  const read = readShare(tampered)
  assert.equal(read.ok, true)
  if (!read.ok || read.pkg.kind !== 'agent') return
  assert.equal(read.pkg.agent.origin, '')
  assert.deepEqual(read.pkg.agent.extraArgs, [])
})

test('分享包：工作流包里带的角色读出来也剥干净了', () => {
  const pkg = sharePackage('workflow', workflow(), at, [agent({ origin: 'builtin:worker', extraArgs: ['D:/x'] })])
  const read = readShare(pkg)
  assert.equal(read.ok, true)
  if (!read.ok || read.pkg.kind !== 'workflow') return
  assert.equal(read.pkg.agents[0].id, 'a1', '原 id 留着接引用')
  assert.equal(read.pkg.agents[0].origin, '')
  assert.deepEqual(read.pkg.agents[0].extraArgs, [])
})

test('分享包：旧版「团队」成员上的本机 id 不进包，也不影响跨机器指纹', () => {
  const a = sharePackage('workflow', workflow({ members: [{ agentId: 'a1', responsibility: '写测试' }] }), at)
  const b = sharePackage(
    'workflow',
    workflow({ members: [{ agentId: 'other-machine', responsibility: '写测试' }] }),
    at,
  )
  if (a.kind !== 'workflow' || b.kind !== 'workflow') return
  assert.equal(a.workflow.members[0].agentId, '')
  assert.equal(a.fingerprint, b.fingerprint, '同一份内容在两台机器上指纹要一样')
})
