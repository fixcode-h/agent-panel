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
import { Settings } from '../../shared/schema.ts'
import { cliSettings } from '../../shared/settings.ts'
import { codexAppSession, unwrapShell } from './rpc/codex.ts'

const CWD = '/work/shop'
const tick = () => new Promise((r) => setTimeout(r, 0))
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
    } else if (e.type === 'tool_delta') {
      // 快照是到目前为止的全部输出，其余是新增的一段
      const tool = tools.find((x) => x.id === e.id)
      if (tool) tool.output = e.snapshot ? e.text : (tool.output ?? '') + e.text
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

test('Claude Code：Bash 的 tool_use_result 带着退出码', () => {
  const parse = claudeParser(CWD)
  const [ok] = parse({
    type: 'user',
    message: {
      role: 'user',
      content: [{ tool_use_id: 't1', type: 'tool_result', content: 'Command exited with code 1', is_error: true }],
    },
    // Bash 的 tool_use_result 是 { code, stdout, stderr }：退出码在这里，不在 content 里
    tool_use_result: { code: 1, stdout: '', stderr: 'fatal: not a git repository' },
  })
  assert.equal(ok.type, 'tool_result')
  assert.equal((ok as { exitCode?: number }).exitCode, 1, '失败的工具行要能拿到退出码')
  // 不是 Bash 的结果、或者 CLI 没报 code 时不要凭空写一个 0
  const [edit] = parse({
    type: 'user',
    message: {
      role: 'user',
      content: [{ tool_use_id: 't2', type: 'tool_result', content: 'updated' }],
    },
    tool_use_result: { filePath: `${CWD}/src/a.ts`, structuredPatch: [] },
  })
  assert.equal((edit as { exitCode?: number }).exitCode, undefined)
})

test('Codex app-server：推理摘要、命令、改文件、计划和累计用量', async () => {
  const sent: any[] = []
  const events: CliEvent[] = []
  const session = codexAppSession({
    cwd: CWD,
    input: '修角标',
    model: '',
    effort: '',
    permission: '',
    extraArgs: [],
    platform: 'linux',
    onEvent: (e) => events.push(e),
  })
  session.start({ write: (s) => sent.push(JSON.parse(s)), end: () => {} })
  // 握手和开一轮是异步的：每处理一条消息让出一次，等下一步的请求发出去
  for (const m of fixture('codex-app.jsonl')) {
    session.handle(m)
    await tick()
  }
  const s = summarize(events)
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
    ],
  )
})

test('Pi：按配置文件里的事件映射解析会话事件', () => {
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
  // 命令执行中的输出：Pi 的 partialResult 是累计快照，按快照发出来，面板能在窗口里实时看到
  const live = fixture('pi-json.jsonl')
    .flatMap((o) => parse(o))
    .filter((e) => e.type === 'tool_delta')
  // 第一条是空快照（Pi 的 partialResult 是 content: []）：也要发出去，接收方才能清掉上一段旧输出；后面才是真正的输出
  assert.deepEqual(live, [
    { type: 'tool_delta', id: 'call_bash', text: '', snapshot: true },
    { type: 'tool_delta', id: 'call_bash', text: 'cat: missing.txt: No such file or directory\n', snapshot: true },
  ])
  // Pi 的 usage.input 只是「未命中缓存的部分」，input 统一按「含缓存」记，所以这里要加上 read（2300 + 6300）
  assert.deepEqual(
    {
      input: s.usage.input,
      output: s.usage.output,
      read: s.usage.read,
      context: s.usage.context,
      model: s.usage.model,
    },
    { input: 8600, output: 120, read: 6300, context: 2310, model: 'claude-sonnet-4-6' },
  )
  assert.ok(s.usage.cost > 0, '费用按每条回复加起来')
  // agent_end 只是一个底层 agent 跑完了，后面可能还有重试、压缩或插话；这一轮以 agent_settled 结束（见 pi-rpc.test）
  assert.deepEqual(s.results, [])
})

test('Pi：命令调用标成还在执行，空快照也要发出去清掉旧输出', () => {
  const parse = parserFor('pi', CWD)
  const [start] = parse({
    type: 'tool_execution_start',
    toolName: 'bash',
    toolCallId: 'b1',
    args: { command: 'npm test' },
  })
  assert.equal(start.type, 'tool')
  // 不标 running 的话界面只认 tool.running，即使后面有增量也不会边跑边显示
  assert.equal((start as { tool: { running?: boolean } }).tool.running, true)
  // CLI 用空快照表示「现在没有输出了」：跳过的话接收方还留着上一段
  const snapshot = (text: string) =>
    parse({ type: 'tool_execution_update', toolName: 'bash', toolCallId: 'b1', partialResult: text })
  assert.deepEqual(snapshot('a\n'), [{ type: 'tool_delta', id: 'b1', text: 'a\n', snapshot: true }])
  assert.deepEqual(snapshot(''), [{ type: 'tool_delta', id: 'b1', text: '', snapshot: true }])
})

test('Pi：命令的退出码从 result.structuredContent.exit_code 取', () => {
  const parse = parserFor('pi', CWD)
  const end = (structuredContent?: Record<string, unknown>) =>
    parse({
      type: 'tool_execution_end',
      toolCallId: 'b1',
      toolName: 'bash',
      result: {
        content: [{ type: 'text', text: 'x' }],
        details: {},
        ...(structuredContent ? { structuredContent } : {}),
      },
      isError: true,
    }).find((e) => e.type === 'tool_result') as { exitCode?: number } | undefined
  assert.equal(end({ output: 'x', exit_code: 1 })?.exitCode, 1)
  // read / edit 的 structuredContent 里没有退出码：不写，免得导出报告里出现「退出码 0」
  assert.equal(end(undefined)?.exitCode, undefined)
})

/** messageStamp 用到的输出指纹：输出长度不变但内容变了也要算一次变化 */
test('消息指纹：输出等长替换也算变化（推送靠它判断要不要重发）', async () => {
  const { messageStamp } = await import('../../shared/task.ts')
  const msg = (output: string) => ({
    id: 'm1',
    role: 'agent' as const,
    agentId: '',
    step: '',
    text: '',
    tools: [{ kind: 'run' as const, label: 'npm test', detail: '', output }],
    at: '2026-01-01T00:00:00.000Z',
  })
  // 进度行边跑边刷新时长度常常不变，只有长度的话不会推送，界面就卡住不动
  assert.notEqual(messageStamp(msg('1 passed')), messageStamp(msg('2 passed')))
  assert.equal(messageStamp(msg('2 passed')), messageStamp(msg('2 passed')))
})

test('Pi：面板工具是裸名字，记成 MCP 调用，不当成子 Agent', () => {
  const parse = parserFor('pi', CWD)
  const ev = parse({ type: 'tool_execution_start', toolName: 'wait_agents', toolCallId: 'w1', args: { seconds: 50 } })
  const tool = ev.find((e) => e.type === 'tool')
  assert.ok(tool && tool.type === 'tool')
  assert.equal(tool.tool.kind, 'other')
  assert.equal(tool.tool.label, 'panel · wait_agents')
})

test('带服务名前缀的面板工具也认得出：run_background 不能因为名字里有 run 被当成 CLI 自己的命令', () => {
  const parse = parserFor('pi', CWD)
  for (const name of ['panel_run_background', 'mcp__panel-1a2b__run_background', 'mcp_panel-1a2b_run_background']) {
    const ev = parse({
      type: 'tool_execution_start',
      toolName: name,
      toolCallId: name,
      args: { command: 'npx playwright install', name: '装浏览器' },
    })
    const tool = ev.find((e) => e.type === 'tool')
    assert.ok(tool && tool.type === 'tool', name)
    assert.equal(tool.tool.kind, 'other', name)
    assert.equal(tool.tool.label, 'panel · run_background', name)
  }
})

test('Pi：未命中的输入比命中的多时也加上缓存，工具参数只算速度，面板工具没接上要显示出来', () => {
  const parse = parserFor('pi', CWD)
  const usage = { input: 5000, output: 40, cacheRead: 1000, cacheWrite: 0, totalTokens: 6040, cost: { total: 0 } }
  const ev = parse({ type: 'message_end', message: { role: 'assistant', model: 'deepseek-flash', usage } })
  // Pi 的 usage.input 永远不含缓存：只靠「比缓存小才加」去猜，这一条会少记 1000，命中率就偏高
  assert.equal((ev.find((e) => e.type === 'usage') as { addInput?: number }).addInput, 6000)
  assert.deepEqual(
    parse({
      type: 'message_update',
      assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 1, delta: '{"pa' },
    }),
    [{ type: 'gen', text: '{"pa' }],
  )
  const [notice] = parse({
    type: 'extension_ui_request',
    id: 'x',
    method: 'setStatus',
    statusKey: 'agent-panel-tools',
    statusText: 'HTTP 401: {}',
  })
  assert.equal(notice.type, 'notice')
  assert.equal((notice as { failed?: boolean }).failed, true)
  assert.match((notice as { text: string }).text, /面板的工具没接上（HTTP 401: \{\}）/)
  // 缺哪些工具只有扩展知道（它写在 error 里）：这里不确定到底丢了多少，不能统说「所有面板工具都不可用」，
  // 压缩轮只有提问工具、缺其余编排工具时照样能提问
  assert.doesNotMatch((notice as { text: string }).text, /所有面板工具都不可用/)
})

test('Pi：按配置文件拼参数（默认走 RPC）', () => {
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
      '--mode',
      'rpc',
      '--model',
      'anthropic/claude-sonnet-4-6',
      '--thinking',
      'high',
      '--tools',
      '+grep,+find,+ls',
      '--exclude-tools',
      'bash,powershell,edit,write',
      '--session',
      'sess-1',
      '--append-system-prompt',
      '你是审查员',
      '--verbose',
    ],
  )
  // 权限用「+工具」在默认工具上加、--exclude-tools 去掉，不写白名单：白名单会把面板桥接的工具（提问、编排）一起挡掉
  // 全部工具时补上 grep / find / ls（Pi 默认只有 read、bash、edit、write）；分叉用 --fork；对话标题用 --name
  assert.deepEqual(
    def.buildArgs({ model: '', permission: 'full', extraArgs: [], resume: 's', fork: {}, title: '修登录页' }),
    ['--mode', 'rpc', '--tools', '+grep,+find,+ls', '--name', '修登录页', '--fork', 's'],
  )
  assert.deepEqual(def.buildArgs({ model: '', permission: 'edit', extraArgs: [] }).slice(2), [
    '--tools',
    '+grep,+find,+ls',
    '--exclude-tools',
    'bash,powershell',
  ])
  // codemode 开关要并进同一个 --tools：Pi 有多个 --tools 时只认最后一个
  assert.deepEqual(
    def.buildArgs({ model: '', permission: 'edit', extraArgs: [], options: { codemode: true } }).slice(2),
    ['--tools', '+grep,+find,+ls,+codemode,+tool_search', '--exclude-tools', 'bash,powershell'],
  )
})

test('Pi：离线运行、codemode 是默认开着的开关，关掉离线就不加 PI_OFFLINE', () => {
  const env = (options: Record<string, boolean>) =>
    cliSettings(Settings.parse({ clis: { pi: { options } } }), 'pi').env.filter((e) => e.key === 'PI_OFFLINE')
  assert.deepEqual(env({}), [{ key: 'PI_OFFLINE', value: '1' }])
  assert.deepEqual(env({ offline: false }), [])
  assert.deepEqual(cliSettings(Settings.parse({}), 'pi').options, { offline: true, codemode: true })
})

test('Pi 的重试事件：带上次数和原因，重试成功后算恢复而不是失败', () => {
  const parse = parserFor('pi', CWD)
  // 每次重试都要能看出第几次、总共几次、因为什么失败（事后统计「总是失败」靠这几个字段）
  assert.deepEqual(
    parse({ type: 'auto_retry_start', attempt: 2, maxAttempts: 3, delayMs: 4000, errorMessage: '502 Bad Gateway' }),
    [
      {
        type: 'notice',
        kind: 'retry',
        attempt: 2,
        maxAttempts: 3,
        error: '502 Bad Gateway',
        text: '模型请求失败，4 秒后第 2/3 次重试：502 Bad Gateway',
        failed: false,
      },
    ],
  )
  assert.deepEqual(parse({ type: 'auto_retry_end', success: false, attempt: 3, finalError: 'Connection closed.' }), [
    {
      type: 'notice',
      kind: 'retry_failed',
      attempt: 3,
      error: 'Connection closed.',
      text: '自动重试 3 次后仍然失败：Connection closed.',
      failed: true,
    },
  ])
  // 重试成功是独立事件：不进提示列表，runner 用它把前面那张「正在重试」收成已恢复
  assert.deepEqual(parse({ type: 'auto_retry_end', success: true, attempt: 1 }), [
    { type: 'retry_ok', attempt: 1, text: '第 1 次重试成功了，接着做。' },
  ])
})
