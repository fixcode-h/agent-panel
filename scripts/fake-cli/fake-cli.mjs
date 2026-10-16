#!/usr/bin/env node
/**
 * 测试用的假 CLI：按 Claude Code / Codex / Command Code 的非交互输出格式吐事件，
 * 并在当前目录写一个文件，用来在没有安装或登录真实 CLI 的环境里测通执行流程。
 *
 * 任务描述里包含 FAIL 会以退出码 1 结束；包含 SLOW 会慢慢输出，方便测试「停止」。
 * 设置环境变量 FAKE_CLI_LOG 后，每次调用的参数、目录和 stdin 会追加写进这个文件。
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const kind = args[0] === 'app-server' ? 'codex' : args.includes('stream-json') ? 'claude' : 'commandcode'
if (args.includes('--version')) {
  // 假 npm 「更新」过以后报告新版本
  let ver = '0.0.1'
  try {
    if (process.env.FAKE_CLI_LOG) ver = readFileSync(process.env.FAKE_CLI_LOG + '.ver', 'utf8').trim()
  } catch {}
  console.log(`${kind}-fake ${ver}`)
  process.exit(0)
}

// Codex 的 app-server：按行读 JSON-RPC 请求，回答 initialize、model/list，并按 thread/start、turn/start 执行一轮；
// stdin 不关闭就一直等
let input = ''
let appThread = ''
let appResume = ''
let developer = ''
let policy = {}
if (args[0] === 'app-server') {
  const { createInterface } = await import('node:readline')
  for await (const line of createInterface({ input: process.stdin })) {
    const req = JSON.parse(line)
    if (req.method === 'initialize') console.log(JSON.stringify({ id: req.id, result: { userAgent: 'fake' } }))
    if (req.method === 'thread/start' || req.method === 'thread/resume') {
      appResume = req.params.threadId ?? ''
      appThread = appResume || randomUUID()
      developer = req.params.developerInstructions ?? ''
      policy = { approval: req.params.approvalPolicy, sandbox: req.params.sandbox }
      console.log(JSON.stringify({ id: req.id, result: { thread: { id: appThread } } }))
    }
    if (req.method === 'turn/start') {
      console.log(JSON.stringify({ id: req.id, result: { turn: { id: 't1', status: 'inProgress' } } }))
      input = req.params.input.map((x) => x.text).join('')
      break
    }
    if (req.method === 'model/list') {
      const effort = (e) => ({ reasoningEffort: e, description: e })
      const data = [
        {
          id: 'fake-pro',
          model: 'fake-pro',
          displayName: 'Fake Pro',
          description: '最强',
          hidden: false,
          isDefault: true,
          supportedReasoningEfforts: ['low', 'high', 'ultra'].map(effort),
        },
        {
          id: 'fake-mini',
          model: 'fake-mini',
          displayName: 'Fake Mini',
          description: '最快',
          hidden: false,
          supportedReasoningEfforts: ['low'].map(effort),
        },
        { id: 'fake-hidden', model: 'fake-hidden', displayName: 'Hidden', hidden: true, supportedReasoningEfforts: [] },
      ]
      console.log(JSON.stringify({ id: req.id, result: { data, nextCursor: null } }))
    }
  }
  if (!input) process.exit(0)
}
// Command Code 的 --list-models
if (args.includes('--list-models')) {
  console.log(
    'Available models  ·  3 models\n\nOpen Source\n\nfake/flash               fast model (default)\nfake/pro                 strong model\n\nOpenAI\n\ngpt-fake                 openai model\n\nPass the full id, or just the short name after the last "/":\ncmd --model fake/pro',
  )
  process.exit(0)
}

// Claude Code 用 --input-format stream-json 时，stdin 一行一个 JSON：第一行是任务描述，之后是面板回的 control_response
const streamIn = kind === 'claude' && args.includes('--input-format')
const lines = []
let wake
if (streamIn) {
  const rl = (await import('node:readline')).createInterface({ input: process.stdin })
  rl.on('line', (l) => {
    lines.push(JSON.parse(l))
    wake?.()
  })
  const next = async () => {
    while (!lines.length) await new Promise((r) => (wake = r))
    return lines.shift()
  }
  globalThis.nextLine = next
  const first = await next()
  input = typeof first.message.content === 'string' ? first.message.content : ''
} else if (kind !== 'codex') for await (const chunk of process.stdin) input += chunk
if (process.env.FAKE_CLI_LOG) {
  const log = process.env.FAKE_CLI_LOG
  const extra = kind === 'codex' ? { resume: appResume, developer, ...policy } : {}
  appendFileSync(
    log,
    JSON.stringify({ kind, args, cwd: process.cwd(), input, ...extra, pid: process.pid, start: Date.now() }) + '\n',
  )
  // 结束时间单独记一个文件，用来检查并行节点是否真的同时运行
  process.on('exit', () => appendFileSync(`${log}.end`, JSON.stringify({ pid: process.pid, end: Date.now() }) + '\n'))
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
// 工作流里只让第一个节点慢（后面的节点带着上游结果，也会含有 SLOW）
const slow = input.includes('SLOW') && !input.includes('上游节点的结果')
const fail = input.includes('FAIL')
const resumeIdx = args.indexOf('--resume')
const session = kind === 'codex' ? appThread : resumeIdx >= 0 ? args[resumeIdx + 1] : randomUUID()
// app-server 的通知
const note = (method, params) => out({ method, params: { threadId: session, turnId: 't1', ...params } })
const codexDone = (status, error) => {
  note('turn/completed', { turn: { id: 't1', status, error: error ? { message: error } : null, items: [] } })
  process.exit(0)
}
const file = `${kind}-output.txt`
const verdict = input.includes('最后单独一行写「验收结论')
  ? input.includes('第 1 轮验收')
    ? '\n验收结论：不通过'
    : '\n验收结论：通过'
  : ''
// LONGOUT：第一个节点输出一份很长的结果（测试交接内容超过上限时存成文件）
const long =
  input.includes('LONGOUT') && !input.includes('上游节点的结果') ? `\n${'很长的方案。'.repeat(1000)}结尾` : ''
const reply = `这是 ${kind} 的回复。收到 ${input.length} 个字符的任务描述。${verdict}${long}`

// 真的 CLI 一开始就报告会话 id，慢的时候也先报，测试「中断恢复」要用
if (slow && kind === 'claude')
  out({ type: 'system', subtype: 'init', session_id: session, model: 'claude-fake', cwd: process.cwd() })
for (let i = 0; i < (slow ? 40 : 1); i++) await sleep(slow ? 250 : 150)

// 「AI 创建」的提示：只回一段说明 + JSON。JSON 由用户消息里的 FAKE_JSON: 指定（一行），
// 带 FAKE_JSON2: 时，收到「不符合要求」的重试提示后改用它，用来测试自动修正
if (input.startsWith('你是「Agent 面板」里的配置助手')) {
  const pick = (tag) => input.match(new RegExp(`${tag}:(.*)`))?.[1]?.trim()
  const json = (input.includes('不符合要求') && pick('FAKE_JSON2')) || pick('FAKE_JSON') || '{}'
  const text = `这是按你的要求生成的配置。\n\n\`\`\`json\n${json}\n\`\`\``
  if (kind === 'claude') {
    out({ type: 'system', subtype: 'init', session_id: session, model: 'claude-fake', cwd: process.cwd() })
    out({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text }] } })
    out({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: text,
      session_id: session,
      total_cost_usd: 0,
      usage: {},
    })
  } else if (kind === 'codex') {
    note('item/reasoning/summaryTextDelta', { itemId: 'r0', delta: '想一想怎么配置', summaryIndex: 0 })
    for (const part of text.match(/[\s\S]{1,40}/g)) note('item/agentMessage/delta', { itemId: 'a0', delta: part })
    note('item/completed', { item: { id: 'a0', type: 'agentMessage', text } })
    codexDone('completed')
  } else {
    out({ type: 'event', event: { type: 'run_start', sessionId: session } })
    out({ type: 'event', event: { type: 'message_end', content: [{ type: 'text', text }] } })
    out({ type: 'result', subtype: 'success', sessionId: session, usage: {}, durationMs: 1, finalText: text })
  }
  process.exit(0)
}

// 像没登录的 CLI 一样报一句错，然后一直卡着不输出（测试空闲超时）
if (input.includes('HANG')) {
  process.stderr.write('Invalid API key · Please run /login\n')
  await new Promise(() => setInterval(() => {}, 60_000))
}

if (kind === 'claude') {
  out({ type: 'system', subtype: 'init', session_id: session, model: 'claude-fake', cwd: process.cwd() })
  out({
    type: 'stream_event',
    event: {
      type: 'message_start',
      message: {
        id: 'm1',
        model: 'claude-fake',
        usage: { input_tokens: 10, cache_read_input_tokens: 12000, cache_creation_input_tokens: 500 },
      },
    },
  })
  for (const part of ['先看看', '项目结构'])
    out({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: part } },
    })
  out({
    type: 'assistant',
    message: {
      id: 'm1',
      content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: `${process.cwd()}/README.md` } }],
    },
  })
  out({
    type: 'assistant',
    message: {
      id: 'm1',
      content: [
        {
          type: 'tool_use',
          id: 't0',
          name: 'TodoWrite',
          input: {
            todos: [
              { content: '读代码', status: 'completed', activeForm: '读代码中' },
              { content: '写文件', status: 'in_progress', activeForm: '正在写文件' },
            ],
          },
        },
      ],
    },
  })
  out({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 40 } } })
  writeFileSync(file, 'line1\nline2\n')
  // 任务里有 COMMIT 时像真的 Agent 一样自己提交一次（测试提交后改动仍然统计在内）
  if (input.includes('COMMIT')) {
    writeFileSync('committed.txt', 'one\ntwo\nthree\n')
    const g = (...a) => execFileSync('git', ['-c', 'user.name=a', '-c', 'user.email=a@a', ...a], { stdio: 'ignore' })
    g('add', 'committed.txt')
    g('commit', '-qm', 'agent commit')
  }
  out({
    type: 'assistant',
    message: {
      id: 'm1',
      content: [
        {
          type: 'tool_use',
          id: 't2',
          name: 'Write',
          input: { file_path: `${process.cwd()}/${file}`, content: 'line1\nline2\n' },
        },
      ],
    },
  })
  // 任务描述里有 ASK：先请求确认一条命令，再问一个问题，把面板的回答记下来
  if (input.includes('ASK') && streamIn) {
    const ask = async (name, toolInput) => {
      const id = randomUUID()
      out({
        type: 'control_request',
        request_id: id,
        request: { subtype: 'can_use_tool', tool_name: name, input: toolInput },
      })
      for (;;) {
        const m = await globalThis.nextLine()
        if (m.type === 'control_response' && m.response.request_id === id) return m.response.response
      }
    }
    const a1 = await ask('Bash', { command: 'rm -rf build', description: '清理构建目录' })
    const a2 = await ask('AskUserQuestion', {
      questions: [{ question: '用哪个数据库？', header: '数据库', options: [{ label: 'SQLite' }, { label: 'MySQL' }] }],
    })
    if (process.env.FAKE_CLI_LOG) appendFileSync(process.env.FAKE_CLI_LOG + '.ask', JSON.stringify([a1, a2]) + '\n')
  }
  out({
    type: 'assistant',
    message: { id: 'm1', content: [{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'npm test' } }] },
  })
  out({
    type: 'stream_event',
    event: {
      type: 'message_start',
      message: {
        id: 'm2',
        model: 'claude-fake',
        usage: { input_tokens: 20, cache_read_input_tokens: 13000, cache_creation_input_tokens: 0 },
      },
    },
  })
  out({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text', text: '' } } })
  for (const part of reply.match(/.{1,6}/g))
    out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: part } } })
  out({ type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: reply }] } })
  if (fail) {
    out({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: '模拟的失败',
      session_id: session,
      usage: {},
      total_cost_usd: 0,
    })
    process.exit(1)
  }
  out({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: reply,
    session_id: session,
    total_cost_usd: 0.0123,
    usage: { input_tokens: 30, cache_read_input_tokens: 25000, cache_creation_input_tokens: 500, output_tokens: 120 },
    modelUsage: { sonnet: { contextWindow: 500000 }, 'haiku-small': { contextWindow: 100000 } },
  })
} else if (kind === 'codex') {
  note('item/reasoning/summaryTextDelta', { itemId: 'r0', delta: '**规划**\n\n先看目录', summaryIndex: 0 })
  note('turn/plan/updated', {
    explanation: null,
    plan: [
      { step: '看目录', status: 'completed' },
      { step: '写文件', status: 'inProgress' },
    ],
  })
  note('item/completed', {
    item: { id: 'c0', type: 'commandExecution', command: "bash -lc 'ls -la'", exitCode: 0, status: 'completed' },
  })
  writeFileSync(file, 'a\nb\nc\n')
  note('item/completed', {
    item: {
      id: 'f0',
      type: 'fileChange',
      changes: [{ path: `${process.cwd()}/${file}`, kind: { type: 'add' }, diff: '+a\n+b\n+c\n' }],
      status: 'completed',
    },
  })
  note('item/started', { item: { id: 'a0', type: 'agentMessage', text: '' } })
  for (const part of reply.match(/.{1,6}/g)) note('item/agentMessage/delta', { itemId: 'a0', delta: part })
  note('item/completed', { item: { id: 'a0', type: 'agentMessage', text: reply } })
  const usage = {
    totalTokens: 24300,
    inputTokens: 24000,
    cachedInputTokens: 20000,
    cacheWriteInputTokens: 0,
    outputTokens: 300,
    reasoningOutputTokens: 100,
  }
  note('thread/tokenUsage/updated', { tokenUsage: { total: usage, last: usage, modelContextWindow: 258400 } })
  if (fail) codexDone('failed', '模拟的失败')
  codexDone('completed')
} else {
  const ev = (e) => out({ type: 'event', event: e })
  ev({ type: 'run_start', sessionId: session })
  // NETFAIL：像真的 Command Code 一样连接中途断开，退出码 6；NETDOWN 每次都断（续接也断）
  const downMark = path.join(tmpdir(), `fake-netdown-${session}`)
  if (input.includes('NETDOWN')) writeFileSync(downMark, '')
  if (existsSync(downMark) || (input.includes('NETFAIL') && resumeIdx < 0)) {
    process.stderr.write(
      'Note: "fake/flash" routes via Command Code; your providers.json also declares it — use "me/fake/flash" to route there instead.\nError: Unable to connect to the API. Please check your network connection.\nStream connection failed mid-response: terminated\n',
    )
    process.exit(6)
  }
  ev({ type: 'message_start' })
  ev({ type: 'thinking_start' })
  ev({ type: 'thinking_delta', delta: '想想先读哪个文件' })
  ev({ type: 'thinking_end', text: '想想先读哪个文件' })
  ev({ type: 'tool_queued', toolCallId: 'c1', toolName: 'read_file', input: { path: 'README.md' } })
  writeFileSync(file, 'x\n')
  ev({ type: 'tool_queued', toolCallId: 'c2', toolName: 'write_file', input: { path: file, content: 'x\n' } })
  ev({
    type: 'model_request_end',
    model: 'cmd-fake',
    usage: { inputTokens: 9000, outputTokens: 80, cacheReadTokens: 1000, cacheWriteTokens: 0 },
  })
  ev({ type: 'message_start' })
  for (const part of reply.match(/.{1,6}/g)) ev({ type: 'text_delta', delta: part })
  ev({ type: 'message_end', content: [{ type: 'text', text: reply }] })
  if (fail) {
    out({
      type: 'result',
      subtype: 'error',
      sessionId: session,
      usage: {},
      durationMs: 1,
      finalText: '',
      error: '模拟的失败',
    })
    process.exit(1)
  }
  out({
    type: 'result',
    subtype: 'success',
    sessionId: session,
    usage: { inputTokens: 10000, outputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 0 },
    durationMs: 10,
    finalText: reply,
  })
}
