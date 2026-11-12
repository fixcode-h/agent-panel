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
import { runConversationTurn } from './engine.ts'
import { nodeRequests } from './engine/prompt-parts.ts'
import type { AgentCall, EngineHost } from './engine/host.ts'
import { applyPlan } from './plan.ts'
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
    askUser: true,
    messages: [],
  })
  let session = 'sess-1'
  let compactNext = false
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
      // 这一轮里会话被压缩了（手动压缩、CLI 自己压缩）：runner 会通知调用方
      if (compactNext) {
        compactNext = false
        delete task.promptSent
        c.onCompacted?.()
      }
      return { ok: true, text: '好' }
    },
    runBackground: async () => ({ ok: true, info: '' }),
    messageParent: async () => ({ ok: true, info: '' }),
    newSession: (s: string) => (session = s),
    compactNext: () => (compactNext = true),
  }
  return h as unknown as EngineHost & { newSession: (s: string) => void; compactNext: () => void }
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
  // 压缩发生在这一轮里（用户实测：压缩后父对话不再派子对话）：这一轮结束不能把压缩前的记录写回去，下一轮整份重发
  h.compactNext()
  await say(h, '压缩这一轮')
  assert.equal(sentOf(h)?.exec, undefined)
  await say(h, '压缩后第一轮')
  assert.match(calls[5].prompt, /## 计划怎么维护/)
  calls.splice(4, 2)
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
  // 保活进程里用户接着发（runner 调 nextPrompt）：和第一轮用同一套参数拼，增量只剩用户消息。
  // 以前这里漏传了角色，角色里写过的提问、收尾规则被发回去，还宣布「子对话的完成标准」不再适用
  for (const text of ['保活第一条', '保活第二条']) {
    const next = await calls[6].nextPrompt!(text)
    assert.match(next, new RegExp(text))
    assert.doesNotMatch(next, /## 停下之前先提问|## 收尾建议要交给用户选|## 不再适用的规则/)
    assert.ok(next.length < 300, `保活的下一条只该有消息：${next.length} 字`)
  }

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

// 审计发现：会变的状态和不变的规则拼在同一段，指纹一变整段重发（验证规则 2–4 千字跟着改动清单、计划全文跟着「已 N 分钟」）
test('续接只发增量：改动清单变了只重发「本轮该跑的测试步骤」，计划进度变了只重发「计划进度」', async () => {
  const calls: AgentCall[] = []
  const h = childHost(calls)
  const step = (id: string, appliesTo: string[]) => ({
    id,
    name: id,
    command: id,
    env: 'auto' as const,
    cwd: '',
    when: '',
    appliesTo,
    timeoutSec: 0,
    note: '',
    enabled: true,
    merge: false,
    scope: 'changed' as const,
    quick: false,
  })
  const verify = {
    steps: [step('前端检查', ['web/**']), step('后端检查', ['server/**'])],
    platform: 'linux',
    wslDistro: '',
    scaled: true,
    changedFiles: ['web/a.ts'],
  }
  ;(h as { verify?: unknown }).verify = verify
  applyPlan(h.task, { steps: [{ title: '改页面', status: 'running' }, { title: '收尾' }] })
  await say(h, '改页面')
  assert.match(calls[0].prompt, /## 验证按改动大小定[\s\S]*## 本轮该跑的测试步骤/)
  verify.changedFiles = ['web/a.ts', 'server/b.ts']
  await say(h, '再改后端')
  assert.match(calls[1].prompt, /## 本轮该跑的测试步骤[\s\S]*后端检查/)
  assert.doesNotMatch(calls[1].prompt, /## 验证按改动大小定/)
  // 进行中那一步的开始时间往前挪：只重发进度一句，计划全文不跟着重发
  const plan = h.task.plans.at(-1)!
  plan.steps[0].startedAt = new Date(Date.now() - 6 * 60_000).toISOString()
  await say(h, '接着改')
  assert.match(calls[2].prompt, /## 计划进度/)
  assert.doesNotMatch(calls[2].prompt, /## 执行计划|## 计划怎么维护|## 本轮该跑的测试步骤/)
  // 计划里的步骤都做完了（只剩面板加的收尾，或整份收起）：「计划进度」照样在，不会被当成作废的规则
  applyPlan(h.task, {
    steps: [
      { id: '1', title: '改页面', status: 'done' },
      { id: '2', title: '收尾', status: 'done' },
    ],
    partial: true,
  })
  await say(h, '都做完了')
  assert.doesNotMatch(calls[3].prompt, /## 不再适用的规则/)

  // 保活期间改动清单、推送回答变了：引擎每次重拼都读 host 的现值（这里只测引擎这一侧；服务端把这几项写成 getter，
  // 见 server/tasks/run.ts、runner.ts 的 taskPolicy，那一侧由 e2e 07-local 等下一句、预热后第一句的断言兜着）。
  // 推送的回答只对父对话有意义（子对话不碰远端），这段按顶层对话拼
  h.task.parentTaskId = ''
  h.task.changes = []
  ;(h as { verify?: unknown }).verify = {
    ...verify,
    get changedFiles() {
      return h.task.changes.map((c) => c.path)
    },
  }
  h.policy = {
    push: 'ask',
    tools: [],
    get answered() {
      return h.task.remotePush
    },
  }
  // 收尾种类同理（server/tasks/run.ts 按 wrapUpFrom 现算）：用户在授权卡上点了允许，推送收尾跟着出现
  Object.defineProperty(h, 'wrapUp', { get: () => (h.task.remotePush === 'allowed' ? 'push' : undefined) })
  await say(h, '新的一轮')
  const live = calls[4]
  assert.match(live.fresh ?? live.prompt, /改动清单为空/)
  assert.match(live.fresh ?? live.prompt, /调用面板工具 ask_push 请用户授权/)
  h.task.changes = [{ path: 'server/b.ts', add: 1, del: 0 }]
  h.task.remotePush = 'allowed'
  const next = await live.nextPrompt!('保活里接着改')
  assert.match(next, /## 用户这次的消息\n保活里接着改/)
  assert.match(next, /## 本轮该跑的测试步骤[\s\S]*server\/b\.ts/)
  assert.match(next, /用户已经同意推送[^\n]*收尾：推送到远端并合并主干已经在计划的最后一步/)
  assert.doesNotMatch(next, /## 验证按改动大小定/)
  // 收尾变了，计划那段跟着重发：讲清推送收尾由面板加在最后
  assert.match(next, /## 计划怎么维护[\s\S]*由面板加在最后/)

  // 预热也带 nextPrompt：预热发的是完整提示，用户第一条消息（经 wait_user_message 或保活交进来）只补消息和变了的段落，
  // 以前原样交给 CLI，没有「## 用户这次的消息」；预热结束也记下这个会话已有的段落
  h.prewarm = true
  h.prompt = '（预热）'
  delete h.task.promptSent
  await runConversationTurn(h, 'exec')
  h.prewarm = false
  const warm = calls[5]
  assert.match(warm.prompt, /## 计划怎么维护/)
  const first = await warm.nextPrompt!('预热后的第一句')
  assert.match(first, /^## 用户这次的消息\n预热后的第一句/)
  assert.doesNotMatch(first, /## 计划怎么维护/)
  assert.ok(sentOf(h)?.exec, '预热的会话记下了已发的段落')
})
