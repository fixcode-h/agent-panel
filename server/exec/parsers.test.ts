/**
 * CLI 输出解析测试：用 fixtures/ 里录下的输出样本跑一遍解析，检查整理出来的文字、思考、工具调用、用量和结果。
 * CLI 升级后输出格式变了，在这里最先发现。运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { claudeParser, commandCodeParser, parserFor, type CliEvent } from './parsers.ts'
import { getCli } from '../../shared/clis.ts'
import { codexAppSession, unwrapShell } from './codex-app.ts'

const CWD = '/work/shop'
const fixture = (name: string) =>
  readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))

/** 把事件整理成页面上看到的样子：回复文字、思考、工具调用、用量合计 */
function summarize(events: CliEvent[]) {
  let text = ''
  let thinking = ''
  const tools: { kind: string; label: string; detail: string; id?: string; output?: string; failed?: boolean }[] = []
  const files: { path: string; add: number; del: number }[] = []
  const usage = { input: 0, output: 0, read: 0, write: 0, cost: 0, context: 0, window: 0, model: '' }
  const results: { ok: boolean; error?: string }[] = []
  let session = ''
  let todos: { text: string; status: string }[] = []
  let patch = ''
  for (const e of events) {
    if (e.type === 'text_delta' || e.type === 'text') text += e.text
    else if (e.type === 'thinking') thinking += e.text
    else if (e.type === 'tool') {
      tools.push({ kind: e.tool.kind, label: e.tool.label, detail: e.tool.detail, id: e.id, failed: e.tool.failed })
      if (e.file) files.push(e.file)
    } else if (e.type === 'tool_result') {
      const tool = tools.find((x) => x.id === e.id)
      if (tool) Object.assign(tool, { output: e.output, failed: e.failed })
      if (e.patch) patch = e.patch
    } else if (e.type === 'usage') {
      usage.input += e.addInput ?? 0
      usage.output += e.addOutput ?? 0
      usage.read += e.addCacheRead ?? 0
      usage.write += e.addCacheWrite ?? 0
      usage.cost += e.addCost ?? 0
      if (e.context) usage.context = e.context
      if (e.window) usage.window = e.window
      if (e.model) usage.model = e.model
    } else if (e.type === 'session') session = e.id
    else if (e.type === 'todos') todos = e.todos
    else if (e.type === 'result') results.push({ ok: e.ok, error: e.error })
  }
  return { text, thinking, tools, files, usage, results, session, todos, patch }
}

test('Claude Code：stream-json 的文字、思考、工具、待办和用量', () => {
  const parse = claudeParser(CWD)
  const s = summarize(fixture('claude-stream.jsonl').flatMap((o) => parse(o)))
  assert.equal(s.session, 'sess-claude-1')
  // 流式输出过的文字不再从 assistant 消息里重复一遍；两条消息之间不多出空行
  assert.equal(s.text, '我先读一下角标组件。改好了：角标现在订阅购物车数量。')
  assert.equal(s.thinking, '先看看角标组件怎么订阅购物车。')
  assert.deepEqual(
    s.tools.map((x) => [x.kind, x.label, x.detail]),
    [
      ['read', 'src/CartBadge.tsx', ''],
      ['edit', 'src/CartBadge.tsx', '+2 -1'],
      ['other', '更新待办清单', '3 项'],
    ],
  )
  assert.match(s.tools[0].output ?? '', /CartBadge/)
  assert.deepEqual(s.files, [{ path: 'src/CartBadge.tsx', add: 2, del: 1 }])
  assert.match(s.patch, /^@@ -2,1 \+2,2 @@\n-  const n = useCart\(\)\.count/)
  assert.deepEqual(s.todos, [
    { text: '读角标组件', status: 'done' },
    { text: '正在改成订阅数量', status: 'running' },
    { text: '跑测试', status: 'pending' },
  ])
  // 流式过程中按每条消息累计，最后用 result 的总数补齐差额：合计等于 result 给的总数（输入含缓存）
  assert.deepEqual(
    { input: s.usage.input, output: s.usage.output, read: s.usage.read, write: s.usage.write },
    { input: 48050, output: 198, read: 47000, write: 1000 },
  )
  assert.equal(s.usage.cost, 0.0412)
  assert.equal(s.usage.window, 200000)
  assert.equal(s.usage.context, 16208, '上下文是最后一次请求的输入')
  assert.equal(s.usage.model, 'claude-sonnet-4-5')
  assert.deepEqual(s.results, [{ ok: true, error: undefined }])
})

test('Claude Code：出错的结果', () => {
  const parse = claudeParser(CWD)
  const s = summarize([
    ...parse({ type: 'system', subtype: 'init', session_id: 's2' }),
    ...parse({
      type: 'result',
      subtype: 'error_max_turns',
      is_error: true,
      session_id: 's2',
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    }),
  ])
  assert.deepEqual(s.results, [{ ok: false, error: 'error_max_turns' }])
})

test('Codex app-server：推理摘要、命令、改文件、计划和累计用量', () => {
  const sent: any[] = []
  const session = codexAppSession({
    cwd: CWD,
    input: '修角标',
    model: '',
    effort: '',
    permission: '',
    extraArgs: [],
    platform: 'linux',
  })
  session.start({ write: (s) => sent.push(JSON.parse(s)), end: () => {} })
  const s = summarize(fixture('codex-app.jsonl').flatMap((m) => session.handle(m)))
  // 握手：initialize → initialized → thread/start → turn/start
  assert.deepEqual(
    sent.map((m) => m.method),
    ['initialize', 'initialized', 'thread/start', 'turn/start'],
  )
  assert.equal(sent[3].params.threadId, 'thr_codex_1')
  assert.equal(s.session, 'thr_codex_1')
  assert.equal(s.text, '改好了：角标现在订阅购物车数量。')
  assert.equal(s.thinking, '**查找角标组件**\n\n看订阅方式')
  assert.deepEqual(
    s.tools.map((x) => [x.kind, x.label, x.detail]),
    [
      ['run', 'rg -n useCart src', ''],
      ['edit', 'src/CartBadge.tsx', '+2 -1'],
    ],
  )
  assert.deepEqual(s.files, [{ path: 'src/CartBadge.tsx', add: 2, del: 1 }])
  assert.deepEqual(
    s.todos.map((x) => x.status),
    ['done', 'running', 'pending'],
  )
  // 用量按累计值做差：重复推送同一个累计值不会算两遍
  assert.deepEqual(
    { input: s.usage.input, output: s.usage.output, read: s.usage.read },
    { input: 18500, output: 500, read: 15000 },
  )
  assert.equal(s.usage.context, 9800)
  assert.equal(s.usage.window, 272000)
  assert.deepEqual(s.results, [{ ok: true, error: undefined }])
  assert.equal(session.finished, true)
})

test('Codex：命令外面包着的 shell 去掉，只显示真正的命令', () => {
  assert.equal(unwrapShell('/bin/bash -lc "npm test"'), 'npm test')
  assert.equal(unwrapShell(['bash', '-lc', 'ls -la']), 'ls -la')
  assert.equal(unwrapShell('"C:\\\\Windows\\\\System32\\\\cmd.exe" /c dir'), 'dir')
  assert.equal(unwrapShell('powershell.exe -NoProfile -Command "Get-ChildItem"'), 'Get-ChildItem')
})

test('Command Code：事件流的文字、思考、工具结果和用量', () => {
  const parse = commandCodeParser(CWD)
  const s = summarize(fixture('commandcode.jsonl').flatMap((o) => parse(o)))
  assert.equal(s.session, 'sess-cmdc-1')
  // 流式输出过的段落结束时补一个空行，和下一段分开；没流式的整段补上
  assert.equal(s.text, '我来改一下角标组件。\n\n测试还有一个没过。')
  assert.equal(s.thinking, '先找角标组件。')
  assert.deepEqual(
    s.tools.map((x) => [x.kind, x.label, x.detail, !!x.failed]),
    [
      ['read', 'src/CartBadge.tsx', '', false],
      ['edit', 'src/CartBadge.tsx', '+2 -1', false],
      ['run', 'npm test', '', true],
    ],
  )
  assert.equal(s.tools[2].output, '1 test failed')
  // inputTokens 已经含缓存（12000 ≥ 9000 + 1000）；第二次比缓存小，说明是不含缓存的口径，要加上
  assert.deepEqual(
    { input: s.usage.input, output: s.usage.output, read: s.usage.read, write: s.usage.write },
    { input: 12000 + 12200, output: 350, read: 21000, write: 1000 },
  )
  assert.deepEqual(s.results, [{ ok: true, error: undefined }])
})

test('Command Code：模型请求的耗时（有开始和结束才报，用来显示「等待模型」）', () => {
  const parse = commandCodeParser(CWD)
  const ms = fixture('commandcode.jsonl')
    .flatMap((o) => parse(o))
    .flatMap((e) => (e.type === 'model' ? [e.ms] : []))
  // 样本里第一次请求有开始和结束；第二次只有结束（没开始），不报耗时
  assert.equal(ms.length, 1)
  assert.ok(ms[0] >= 0)
})

test('Gemini CLI：按配置文件里的事件映射解析 stream-json', () => {
  const parse = parserFor('gemini', CWD)
  const s = summarize(fixture('gemini-stream.jsonl').flatMap((o) => parse(o)))
  assert.equal(s.session, 'c25acda3-b4f1-4a8e-9f2d-1d7f4e7a9c01')
  // 用户消息不算回复
  assert.equal(s.text, '改好了：角标现在订阅购物车数量。')
  assert.deepEqual(
    s.tools.map((x) => [x.kind, x.label, x.detail]),
    [
      ['read', 'src/CartBadge.tsx', ''],
      ['edit', 'src/CartBadge.tsx', '+2 -1'],
      ['run', 'npm test', ''],
    ],
  )
  assert.equal(s.tools[2].failed, true)
  assert.match(s.tools[2].output ?? '', /denied by policy/, '失败时显示错误原因')
  assert.deepEqual(
    { input: s.usage.input, output: s.usage.output, read: s.usage.read, model: s.usage.model },
    { input: 12400, output: 450, read: 8000, model: 'gemini-2.5-pro' },
  )
  assert.deepEqual(s.results, [{ ok: true, error: undefined }])
  const failed = summarize(
    parse({ type: 'result', status: 'error', error: { type: 'FatalError', message: '配额用完了' }, stats: {} }),
  )
  assert.deepEqual(failed.results, [{ ok: false, error: '配额用完了' }])
})

test('Gemini CLI：按配置文件拼参数', () => {
  const def = getCli('gemini')!
  const args = def.buildArgs({
    model: 'gemini-2.5-pro',
    permission: 'yolo',
    extraArgs: ['--debug'],
    resume: 'sess-1',
    addDirs: ['/a', '/b'],
  })
  assert.deepEqual(args, [
    '--output-format',
    'stream-json',
    '-m',
    'gemini-2.5-pro',
    '--approval-mode',
    'yolo',
    '--resume',
    'sess-1',
    '--include-directories',
    '/a,/b',
    '--debug',
  ])
  // Command Code 也是配置文件写的：走常驻 RPC（带 --experimental --rpc），跳过确认换成专门的参数，没写 maxTurns 时用默认值
  assert.deepEqual(
    getCli('commandcode')!.buildArgs({ model: '', permission: 'yolo', extraArgs: [], resume: 's', fork: {} }),
    [
      '--experimental',
      '--rpc',
      '--skip-onboarding',
      '--trust',
      '--no-auto-update',
      '--dangerously-skip-permissions',
      '--resume',
      's',
      '--fork-session',
      '--max-turns',
      '200',
    ],
  )
})

test('Pi：按配置文件里的事件映射解析 --mode json', () => {
  const parse = parserFor('pi', CWD)
  const s = summarize(fixture('pi-json.jsonl').flatMap((o) => parse(o)))
  assert.equal(s.session, '01a14e97-a046-7582-8d1a-98d858e416c5')
  // 用户消息、流式之外的整段消息都不重复算进回复
  assert.equal(s.text, 'Updating the note.Done: added a second line.')
  assert.equal(s.thinking, 'Need to read the file first.')
  assert.deepEqual(
    s.tools.map((x) => [x.kind, x.label, x.detail]),
    [
      ['read', 'notes.txt', ''],
      // Pi 的 edit 是 edits 数组，每处是 oldText / newText
      ['edit', 'notes.txt', '+2 -1'],
      ['run', 'cat missing.txt', ''],
    ],
  )
  assert.equal(s.tools[0].output, 'hello\n')
  assert.deepEqual(s.files, [{ path: 'notes.txt', add: 2, del: 1 }])
  assert.equal(s.tools[2].failed, true)
  assert.match(s.tools[2].output ?? '', /Command exited with code 1/)
  assert.deepEqual(
    {
      input: s.usage.input,
      output: s.usage.output,
      read: s.usage.read,
      context: s.usage.context,
      model: s.usage.model,
    },
    { input: 2300, output: 120, read: 6300, context: 2310, model: 'claude-sonnet-4-6' },
  )
  assert.ok(s.usage.cost > 0, '费用按每条回复加起来')
  assert.deepEqual(s.results, [{ ok: true, error: undefined }])
})

test('Pi：接口出错时自动重试，最后一次的结果算数', () => {
  const parse = parserFor('pi', CWD)
  const s = summarize(fixture('pi-error.jsonl').flatMap((o) => parse(o)))
  // 每次重试都有一个 agent_end，面板以最后一个为准
  assert.ok(s.results.length > 1)
  assert.deepEqual(s.results.at(-1), { ok: false, error: 'Connection error.' })
})

test('Pi：按配置文件拼参数', () => {
  const def = getCli('pi')!
  assert.deepEqual(
    def.buildArgs({
      model: 'anthropic/claude-sonnet-4-6',
      effort: 'high',
      permission: 'readonly',
      extraArgs: ['--verbose'],
      resume: 'sess-1',
      systemPrompt: '你是审查员',
    }),
    [
      '-p',
      '--mode',
      'json',
      '--model',
      'anthropic/claude-sonnet-4-6',
      '--thinking',
      'high',
      '--tools',
      'read,grep,find,ls,ask_user',
      '--session',
      'sess-1',
      '--append-system-prompt',
      '你是审查员',
      '--verbose',
    ],
  )
  // 全部工具时不限制工具（--tools 会连扩展的工具一起限制）；分叉用 --fork
  assert.deepEqual(def.buildArgs({ model: '', permission: 'full', extraArgs: [], resume: 's', fork: {} }), [
    '-p',
    '--mode',
    'json',
    '--fork',
    's',
  ])
  assert.deepEqual(def.buildArgs({ model: '', permission: 'edit', extraArgs: [] }).slice(3), [
    '--tools',
    'read,edit,write,grep,find,ls,ask_user',
  ])
})
