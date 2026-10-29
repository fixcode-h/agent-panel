import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FULL_EVERY,
  MAX_SENT,
  compactedSilently,
  nextSent,
  promptDelta,
  promptSections,
  rememberSent,
} from './prompt-delta.ts'
import { nodeRequests, runConversationTurn, type AgentCall, type EngineHost } from './engine.ts'
import { Agent, Task } from './schema.ts'

const rules = ['## 授权情况\n推送：先问一次', '## 计划怎么维护\n- 先列计划再动手', '## 执行方式\n直接做']
const msg = (text: string) => `## 用户这次的消息\n${text}`

/** 续接会话只发变了的段落：消息照发、没变的省掉、没有了的声明作废，会话换了或轮数够了发完整的 */
function checkParagraphDelta() {
  // 续接同一个会话：没变的规则段落不再发，这一轮的消息一定发
  {
    const first = [msg('改登录页'), ...rules]
    const sent = nextSent(first, 's1', false, undefined)
    const d = promptDelta([msg('再加个测试'), ...rules], sent, 's1')
    assert.ok(d)
    assert.match(d, /再加个测试/)
    assert.doesNotMatch(d, /先列计划再动手/)
    assert.match(d, /其余规则和之前在这个会话里给过的完全一样/)
  }
  // 变了的段落重发，没有了的规则段落声明作废
  {
    const sent = nextSent([msg('a'), ...rules], 's1', false, undefined)
    const d = promptDelta([msg('b'), '## 授权情况\n推送：已同意', rules[1]], sent, 's1')
    assert.ok(d)
    assert.match(d, /已同意/)
    assert.doesNotMatch(d, /先列计划再动手/)
    // 执行方式这次没有了：模型不能还按它做
    assert.match(d, /## 不再适用的规则\n.*「执行方式」/)
  }
  // 会话换了、没有记录、续接够了轮数：发完整的
  {
    const parts = [msg('a'), ...rules]
    const sent = nextSent(parts, 's1', false, undefined)
    assert.equal(promptDelta(parts, sent, 's2'), null)
    assert.equal(promptDelta(parts, undefined, 's1'), null)
    assert.equal(promptDelta(parts, sent, undefined), null)
    assert.equal(promptDelta(parts, { ...sent, turns: FULL_EVERY }, 's1'), null)
    // 增量轮次累加，完整的从 0 重新计
    assert.equal(nextSent(parts, 's1', true, { ...sent, turns: 3 }).turns, 4)
    assert.equal(nextSent(parts, 's1', false, { ...sent, turns: 3 }).turns, 0)
  }
  // 用户消息里的「## 」不会被切成规则段落省掉
  {
    const text = '## 背景\n登录页报错'
    const sent = nextSent([msg(text), ...rules], 's1', false, undefined)
    // 下一轮用户又发了一模一样的内容：整条消息照发
    const d = promptDelta([msg(text), ...rules], sent, 's1')
    assert.match(d ?? '', /## 背景\n登录页报错/)
    assert.deepEqual(
      promptSections([msg(text)]).map((s) => s.key),
      ['## 用户这次的消息'],
    )
  }
  // CLI 自己压缩了没报事件：上下文一下少了一大半才算，正常波动和小会话不算
  assert.equal(compactedSilently(120_000, 30_000), true)
  assert.equal(compactedSilently(120_000, 90_000), false)
  assert.equal(compactedSilently(8_000, 1_000), false)
  assert.equal(compactedSilently(120_000, 0), false)
  // 记录的会话数有上限，最久没用的先丢
  {
    let all: ReturnType<typeof rememberSent> | undefined
    const v = { session: 's', hashes: {}, turns: 0 }
    for (let i = 0; i < MAX_SENT + 5; i++) all = rememberSent(all, `k${i}`, v)
    assert.equal(Object.keys(all!).length, MAX_SENT)
    assert.ok(!all!.k0 && all![`k${MAX_SENT + 4}`])
    // 再用一次的挪到最后，不会被先丢
    all = rememberSent(all, 'k5', v)
    all = rememberSent(all, 'new', v)
    assert.ok(all.k5 && !all.k6)
  }
}

const iso = new Date().toISOString()
const agent = (id: string, extra: object) =>
  Agent.parse({ id, name: id, createdAt: iso, updatedAt: iso, cli: 'pi', model: '', prompt: id, ...extra })

function childHost(calls: AgentCall[]) {
  const task = Task.parse({
    id: 'c1',
    createdAt: iso,
    updatedAt: iso,
    projectId: 'p1',
    title: 't',
    mode: 'chat',
    status: 'running',
    agentId: 'exec',
    parentTaskId: 'p',
    messages: [],
  })
  let session = 'sess-1'
  const h = {
    task,
    agents: [agent('exec', { canPlan: true })],
    workflows: [],
    prompt: '',
    policy: { push: 'ask', tools: [] },
    newId: () => Math.random().toString(36).slice(2),
    changed: () => {},
    runAgent: async (c: AgentCall) => {
      calls.push(c)
      task.sessions[c.sessionKey] = session
      return { ok: true, text: '好' }
    },
    runBackground: async () => ({ ok: true, info: '' }),
    messageParent: async () => ({ ok: true, info: '' }),
    newSession: (s: string) => (session = s),
  }
  return h as unknown as EngineHost & { newSession: (s: string) => void }
}

const sentOf = (h: EngineHost) => h.task.promptSent

async function say(h: EngineHost, text: string) {
  h.task.messages.push({ id: text, role: 'user', agentId: '', step: '', text, tools: [], at: iso } as never)
  h.prompt = text
  await runConversationTurn(h, 'exec')
}

// 测试预算满了：段落增量和子对话增量是同一个能力（续接只发变了的），合成一个用例
test('续接只发增量：段落按变化发、子对话第二轮起只发增量（完整的放 fresh 备用），派子任务只带最新一条需求', async () => {
  checkParagraphDelta()
  const calls: AgentCall[] = []
  const h = childHost(calls)
  await say(h, '改登录页')
  await say(h, '再加个测试')
  assert.equal(calls[0].fresh, undefined)
  assert.match(calls[0].prompt, /## 计划怎么维护/)
  // 第二轮：消息在，规则不在；完整的放在 fresh 里
  assert.match(calls[1].prompt, /再加个测试/)
  assert.doesNotMatch(calls[1].prompt, /## 计划怎么维护|## 长命令放到后台/)
  assert.ok(calls[1].prompt.length * 10 < calls[0].prompt.length)
  assert.match(calls[1].fresh ?? '', /## 计划怎么维护/)
  // 输入构成按来源记字数：第二轮的规则只算真正发了的那一点
  const [s0, s1] = h.task.turns.map((x) => x.sources!)
  assert.ok(s0.user > 0 && s0.rules > 1000)
  assert.ok(s1.rules * 10 < s0.rules && s1.user > 0)
  // 会话在别处换了（例如保活的进程里开了新会话）：下一轮整份重发
  h.task.sessions.exec = 'sess-other'
  await say(h, '第三轮')
  assert.match(calls[2].prompt, /## 计划怎么维护/)
  // 压缩后 runner 清了记录：同样整份重发
  delete h.task.promptSent
  await say(h, '第四轮')
  assert.match(calls[3].prompt, /## 计划怎么维护/)
  // runner 续不上、开了新会话时用的是 fresh（完整的）：记在新会话名下，之后接着省
  h.newSession('sess-2')
  await say(h, '第五轮')
  await say(h, '第六轮')
  assert.equal(sentOf(h)?.exec.session, 'sess-2')
  assert.doesNotMatch(calls[5].prompt, /## 计划怎么维护/)
  // 角色引入的「通用约束」里已经写了提问和收尾建议：面板不再重复，只补完成标准
  assert.match(calls[0].prompt, /## 停下之前先提问/)
  h.agents = [
    agent('exec', { canPlan: true, includes: ['rules'] }),
    agent('rules', { instructions: '### 子对话停下来等用户时必须先提问\n…\n### 子对话的收尾建议也交给用户选\n…' }),
  ]
  await say(h, '第七轮')
  const full = calls[6].fresh ?? calls[6].prompt
  assert.doesNotMatch(full, /## 停下之前先提问|## 收尾建议要交给用户选/)
  assert.match(full, /## 子对话的完成标准/)

  // 对话里派子任务、跑工作流：用户需求取最新的一条，更早的只留开头
  const long = '很长'.repeat(1000)
  const task = Task.parse({
    id: 't',
    createdAt: iso,
    updatedAt: iso,
    projectId: 'p',
    title: 't',
    mode: 'chat',
    status: 'running',
    messages: ['第一件事 ' + long, ...Array.from({ length: 20 }, (_, i) => `第 ${i} 条 ${long}`), '现在做这个'].map(
      (text, i) => ({ id: `m${i}`, role: 'user', agentId: '', step: '', text, tools: [], at: iso }),
    ),
  })
  const r = nodeRequests(task)
  assert.equal(r.original, '现在做这个')
  // 第一条（子对话里是父对话交代的任务）+ 最近 3 条中间的
  assert.equal(r.extra.length, 4)
  assert.match(r.extra[0], /^第一件事/)
  assert.match(r.extra[3], /^第 19 条/)
  assert.ok(r.extra.join('').length < 3000)
  // 工作流任务照旧全带
  const wf = nodeRequests({ ...task, mode: 'workflow' } as Task)
  assert.equal(wf.extra.length, 21)
})
