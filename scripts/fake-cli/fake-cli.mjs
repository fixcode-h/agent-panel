#!/usr/bin/env node
/**
 * 测试用的假 CLI：按 Claude Code / Codex / Command Code / Gemini CLI / Pi 的非交互输出格式吐事件，
 * 并在当前目录写一个文件，用来在没有安装或登录真实 CLI 的环境里测通执行流程。
 *
 * 任务描述里包含 FAIL 会以退出码 1 结束；包含 SLOW 会慢慢输出，方便测试「停止」。
 * 设置环境变量 FAKE_CLI_LOG 后，每次调用的参数、目录和 stdin 会追加写进这个文件。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { crc32, deflateSync } from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { wrapRequestIds } from './wrap-request.mjs'

const args = process.argv.slice(2)
// Claude Code 和 Gemini CLI 都输出 stream-json，Claude Code 带 -p，Gemini CLI 从 stdin 读任务描述、不带 -p；Pi 默认 --mode rpc
const kind =
  args[0] === 'app-server'
    ? 'codex'
    : args.includes('--mode')
      ? 'pi'
      : args.includes('stream-json')
        ? args.includes('-p')
          ? 'claude'
          : 'gemini'
        : 'commandcode'
// Pi 的 RPC 模式：stdin 一行一条命令，stdout 一行一条记录（和 --mode json 的会话事件同一套）
const piRpc = kind === 'pi' && args.includes('--mode') && args[args.indexOf('--mode') + 1] === 'rpc'
// 登录：按 FAKE_AUTH 把凭据文件写到各个 CLI 放凭据的地方（每次登录换一个邮箱），打印一个登录网址
const isLogin =
  (args[0] === 'auth' && args[1] === 'login') || args[0] === 'login' || (args[0] === '-p' && args[1] === 'hello')
if (isLogin && process.env.FAKE_AUTH) {
  const home = process.env.HOME
  const counter = `${process.env.FAKE_CLI_LOG}.login`
  const n = (existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0) + 1
  writeFileSync(counter, String(n))
  const email = `fake${n}@example.com`
  const put = (file, content) => {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content))
  }
  process.stderr.write('Starting local login server on http://localhost:1455\n')
  process.stderr.write(`Open this URL in your browser: https://example.com/oauth/authorize?n=${n}\n`)
  await new Promise((r) => setTimeout(r, 300))
  const kind = process.env.FAKE_AUTH
  if (kind === 'codex') {
    const jwt = `x.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.y`
    put(path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'auth.json'), { tokens: { id_token: jwt, n } })
  } else if (kind === 'claude') {
    const dir = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')
    put(path.join(dir, '.credentials.json'), { claudeAiOauth: { accessToken: `tok-${n}` } })
    const file = path.join(process.env.CLAUDE_CONFIG_DIR || home, '.claude.json')
    const cur = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
    put(file, { ...cur, oauthAccount: { emailAddress: email, organizationName: 'Org' } })
  } else if (kind === 'gemini') {
    const dir = path.join(process.env.GEMINI_CLI_HOME || home, '.gemini')
    put(path.join(dir, 'oauth_creds.json'), { access_token: `tok-${n}` })
    put(path.join(dir, 'google_accounts.json'), { active: email, old: [] })
  } else put(path.join(home, '.commandcode', 'auth.json'), { apiKey: `key-${n}` })
  // Gemini CLI 这样登录后会接着跑那条提示，不自己退出：让面板看到凭据变了就停掉它
  if (kind === 'gemini') await new Promise((r) => setTimeout(r, 20_000))
  process.exit(0)
}
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
// 评审这类只读子任务（角色设定里有「你负责独立评审」）：它的 input 里还带着子对话的用户原话（COMMIT、BEGIN_EDIT 这些场景标记），
// 不能让它跟着做场景动作，也不往子对话的工作目录里写文件。input 每轮都会换，所以写成函数、用时再算
const isReviewRole = () => [input, ...args].join('\n').includes('你负责独立评审')
let appThread = ''
let appResume = ''
let developer = ''
let policy = {}
// 插话收到的内容；Codex 的 turn/steer、Claude Code 执行中写进来的 user 消息
const steered = []
let interrupted = false
// 压缩、审查、分叉（Codex 的 thread/compact/start、review/start、thread/fork）
let appOp = ''
let appFork = null
let reviewTarget = null
if (args[0] === 'app-server') {
  const { createInterface } = await import('node:readline')
  const rl = createInterface({ input: process.stdin })
  const reqs = rl[Symbol.asyncIterator]()
  for (;;) {
    const { value: line, done } = await reqs.next()
    if (done) break
    const req = JSON.parse(line)
    if (req.method === 'initialize') console.log(JSON.stringify({ id: req.id, result: { userAgent: 'fake' } }))
    if (req.method === 'windowsSandbox/readiness')
      console.log(JSON.stringify({ id: req.id, result: { status: 'ready' } }))
    if (req.method === 'windowsSandbox/setupStart') {
      console.log(JSON.stringify({ id: req.id, result: { started: true } }))
      console.log(JSON.stringify({ method: 'windowsSandbox/setupCompleted', params: { success: true } }))
    }
    if (req.method === 'thread/start' || req.method === 'thread/resume' || req.method === 'thread/fork') {
      appResume = req.params.threadId ?? ''
      appThread = req.method === 'thread/fork' ? `fork-${randomUUID()}` : appResume || randomUUID()
      if (req.method === 'thread/fork') appFork = { from: appResume, lastTurnId: req.params.lastTurnId ?? null }
      developer = req.params.developerInstructions ?? ''
      policy = { approval: req.params.approvalPolicy, sandbox: req.params.sandbox }
      console.log(JSON.stringify({ id: req.id, result: { thread: { id: appThread } } }))
    }
    if (req.method === 'account/read') {
      console.log(
        JSON.stringify({
          id: req.id,
          result: { account: { type: 'chatgpt', email: 'fake@example.com' }, requiresOpenaiAuth: true },
        }),
      )
    }
    if (req.method === 'config/read') console.log(JSON.stringify({ id: req.id, result: { config: {} } }))
    if (req.method === 'account/rateLimits/read') {
      const w = (usedPercent, windowDurationMins) => ({ usedPercent, windowDurationMins, resetsAt: 2000000000 })
      console.log(
        JSON.stringify({
          id: req.id,
          result: { rateLimits: { primary: w(42, 300), secondary: w(7, 10080), planType: 'plus' } },
        }),
      )
    }
    if (req.method === 'skills/list') {
      const skill = {
        name: 'fake-skill',
        description: '测试用的技能',
        path: '/skills/fake/SKILL.md',
        scope: 'user',
        enabled: true,
      }
      console.log(JSON.stringify({ id: req.id, result: { data: [{ cwd: '', skills: [skill], errors: [] }] } }))
    }
    if (req.method === 'thread/compact/start' || req.method === 'review/start') {
      appOp = req.method === 'review/start' ? 'review' : 'compact'
      reviewTarget = req.params.target ?? null
      console.log(JSON.stringify({ id: req.id, result: { turn: { id: 't1', status: 'inProgress' } } }))
      input = appOp
      break
    }
    if (req.method === 'turn/start') {
      console.log(JSON.stringify({ id: req.id, result: { turn: { id: 't1', status: 'inProgress' } } }))
      input = req.params.input.map((x) => x.text).join('')
      // 执行中继续读：插话、中断
      ;(async () => {
        for (;;) {
          const { value, done } = await reqs.next()
          if (done) return
          const m = JSON.parse(value)
          if (m.method === 'turn/steer') {
            steered.push(m.params.input.map((x) => x.text).join(''))
            console.log(JSON.stringify({ id: m.id, result: { turnId: 't1' } }))
          } else if (m.method === 'turn/interrupt') {
            interrupted = true
            console.log(JSON.stringify({ id: m.id, result: {} }))
          }
        }
      })()
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
// Command Code 的 --experimental --rpc：常驻 JSON-RPC，一轮执行中还能 turn/steer。
// 收到 turn/start 后沿用下面一次性的输出逻辑；事件包成 {type:"event"}，最后发 turn/completed。
let rpcMode = false
let rpcSession = ''
let rpcSeq = 0
let rpcExit
// 面板保活：一轮结束后面板可能直接在同一进程里发下一次 turn/start（不重启动进程）。
// 真 CLI 支持这样，假的也按同样方式等下一轮
let rpcTurns = 0
/** 有下一轮 turn/start 时醒过来（没有就等 rpcTurnWait） */
let rpcTurnArrived = false
let rpcTurnWait = null
const waitRpcTurn = () =>
  new Promise((resolve) => {
    if (rpcTurnArrived) {
      rpcTurnArrived = false
      return resolve()
    }
    rpcTurnWait = resolve
  })
if (args.includes('--rpc')) {
  rpcMode = true
  const ri = args.indexOf('--resume')
  rpcSession = ri >= 0 && !args.includes('--fork-session') ? args[ri + 1] : randomUUID()
  const { createInterface } = await import('node:readline')
  const reqs = createInterface({ input: process.stdin })[Symbol.asyncIterator]()
  const say = (o) => process.stdout.write(JSON.stringify(o) + '\n')
  let started = false
  let exited
  rpcExit = new Promise((r) => (exited = r))
  ;(async () => {
    for (;;) {
      const { value, done } = await reqs.next()
      if (done) return exited()
      const m = JSON.parse(value)
      if (m.method === 'initialize')
        say({
          jsonrpc: '2.0',
          id: m.id,
          result: {
            protocolVersion: 1,
            session: { id: rpcSession, model: 'cmd-fake', effort: 'low', permissionMode: 'accept-edits', turn: null },
          },
        })
      else if (m.method === 'turn/start') {
        input = typeof m.params?.input === 'string' ? m.params.input : ''
        say({ jsonrpc: '2.0', id: m.id, result: { turnId: 'turn_1' } })
        say({ jsonrpc: '2.0', method: 'turn/started', params: { seq: ++rpcSeq, turnId: 'turn_1' } })
        started = true
        rpcTurns++
        // 第一轮是启动这一轮（while (!started) 在等它），不是在等「下一轮」
        if (rpcTurns > 1) {
          if (rpcTurnWait) {
            const wake = rpcTurnWait
            rpcTurnWait = null
            wake()
          } else rpcTurnArrived = true
        }
      } else if (m.method === 'turn/steer') {
        steered.push(String(m.params?.input ?? ''))
        say({ jsonrpc: '2.0', id: m.id, result: { turnId: 'turn_1', queued: steered.length } })
      } else if (m.method === 'turn/interrupt') {
        interrupted = true
        say({ jsonrpc: '2.0', id: m.id, result: {} })
      } else if (m.method === 'session/exit') {
        say({ jsonrpc: '2.0', id: m.id, result: {} })
        return exited()
      }
    }
  })()
  while (!started) await new Promise((r) => setTimeout(r, 10))
}
// Pi 的 --list-models（面板带着 --offline 调）：一个提供方一行
if (args.includes('--list-models') && args.includes('--offline')) {
  console.log(
    [
      'provider   model           context  max-out  thinking  images',
      'anthropic  claude-fake     200K     64K      yes       yes',
      'ollama     qwen-fake:7b    128K     16.4K    no        no',
    ].join('\n'),
  )
  process.exit(0)
}
// Command Code 的 --list-models
if (args.includes('--list-models')) {
  // 和真的一样，providers.json 里自己接的接口（BYOK）也列出来，分组名带「(BYOK)」
  let byok = ''
  try {
    const file = path.join(process.env.HOME || homedir(), '.commandcode', 'providers.json')
    for (const [id, p] of Object.entries(JSON.parse(readFileSync(file, 'utf8')).provider ?? {}))
      byok += `\n${p.name || id} (BYOK)\n\n${Object.keys(p.models ?? {})
        .map((m) => `${id}/${m}               byok model`)
        .join('\n')}\n`
  } catch {}
  console.log(
    'Available models  ·  3 models\n\nOpen Source\n\nfake/flash               fast model (default)\nfake/pro                 strong model\n\nOpenAI\n\ngpt-fake                 openai model\n' +
      byok +
      '\nPass the full id, or just the short name after the last "/":\ncmd --model fake/pro',
  )
  process.exit(0)
}

// 续接参数：Pi 用 --session，其他 CLI 用 --resume（Codex 走 thread 参数）
const resumeIdx = args.indexOf(kind === 'pi' ? '--session' : '--resume')
const session =
  kind === 'codex'
    ? appThread
    : rpcSession || (resumeIdx >= 0 && !args.includes('--fork-session') ? args[resumeIdx + 1] : randomUUID())

// Pi 的 RPC 模式：先回 get_state（RPC 没有会话头），等 prompt 到了再往下走
let piRpcExit
// 面板发的是 compact（压缩）而不是 prompt 时记下来：下面按压缩回事件
let piCompact
// 「长命令挡住插话」的场景：真的 Pi 收到 abort 会先停下这一轮（agent_settled）再回 abort；之后的 prompt 是新的一句
let piSleepAbort
let piNextPrompt
// 分叉到某一轮之前（RPC 的 fork）：记下截在哪条用户消息，测试检查
let piForkAt
if (piRpc) {
  // 每个会话的用户消息 entryId 存在一个文件里（跨进程续接时还在），get_fork_messages 按它回
  const histFile = `${process.env.FAKE_CLI_LOG ?? path.join(tmpdir(), 'fake-pi')}.pi-sessions.json`
  const hist = () => (existsSync(histFile) ? JSON.parse(readFileSync(histFile, 'utf8')) : {})
  const saveHist = (h) => writeFileSync(histFile, JSON.stringify(h))
  let piSession = session
  let added = false
  const rl = (await import('node:readline')).createInterface({ input: process.stdin })
  const say = (o) => process.stdout.write(JSON.stringify(o) + '\n')
  let onPrompt
  let answered = false
  piRpcExit = new Promise((r) => rl.on('close', r))
  rl.on('line', (l) => {
    const m = JSON.parse(l)
    if (m.type === 'get_state') {
      say({ type: 'response', command: 'get_state', id: m.id, success: true, data: { sessionId: piSession } })
    } else if (m.type === 'get_fork_messages') {
      const h = hist()
      // 这一轮的 prompt 收到后第一次查：把它记成一条新的用户消息
      if (answered && !added && !piCompact) {
        added = true
        h[piSession] = [...(h[piSession] ?? []), `u-${randomUUID().slice(0, 8)}`]
        saveHist(h)
      }
      const messages = (h[piSession] ?? []).map((entryId) => ({ entryId, text: '' }))
      say({ type: 'response', command: 'get_fork_messages', id: m.id, success: true, data: { messages } })
    } else if (m.type === 'fork') {
      const h = hist()
      const list = h[piSession] ?? []
      const at = list.indexOf(m.entryId)
      if (at < 0) {
        say({ type: 'response', command: 'fork', id: m.id, success: false, error: `Entry ${m.entryId} not found` })
        return
      }
      piForkAt = m.entryId
      piSession = randomUUID()
      h[piSession] = list.slice(0, at)
      saveHist(h)
      say({ type: 'response', command: 'fork', id: m.id, success: true, data: { text: '', cancelled: false } })
    } else if (m.type === 'prompt') {
      input = String(m.message ?? '')
      say({ type: 'response', command: 'prompt', id: m.id, success: true, data: { disposition: 'started' } })
      if (answered) piNextPrompt?.(input)
      if (!answered) {
        answered = true
        onPrompt?.()
      }
    } else if (m.type === 'steer') {
      steered.push(String(m.message ?? ''))
      say({ type: 'response', command: 'steer', id: m.id, success: true, data: { disposition: 'queued' } })
    } else if (m.type === 'clear_queue') {
      // 收回还没取走的插话
      const steering = steered.splice(0)
      say({ type: 'response', command: 'clear_queue', id: m.id, success: true, data: { steering, followUp: [] } })
    } else if (m.type === 'abort' && input.includes('FAKE_PI_SLEEP')) {
      piSleepAbort?.(m.id)
    } else if (m.type === 'abort') {
      interrupted = true
      say({ type: 'response', command: 'abort', id: m.id, success: true })
    } else if (m.type === 'get_session_stats') {
      // 一轮结束后面板查一次准确的上下文占用
      say({
        type: 'response',
        command: 'get_session_stats',
        id: m.id,
        success: true,
        data: { sessionId: session, contextUsage: { tokens: 4321, contextWindow: 200000, percent: 2 } },
      })
    } else if (m.type === 'compact' && !answered) {
      answered = true
      piCompact = m.id
      onPrompt?.()
    }
  })
  await new Promise((r) => (onPrompt = r))
}

// Claude Code 用 --input-format stream-json 时，stdin 一行一个 JSON：第一行是任务描述，之后是面板回的 control_response
const streamIn = kind === 'claude' && args.includes('--input-format')
const lines = []
let wake
if (streamIn) {
  const rl = (await import('node:readline')).createInterface({ input: process.stdin })
  let started = false
  rl.on('line', (l) => {
    const m = JSON.parse(l)
    // 第一条是任务描述；之后的 user 消息是插话，control_request 的 interrupt 是中断
    if (started && m.type === 'user') return steered.push(String(m.message?.content ?? ''))
    if (m.type === 'control_request' && m.request?.subtype === 'interrupt') return void (interrupted = true)
    started = true
    lines.push(m)
    wake?.()
  })
  const next = async () => {
    while (!lines.length) await new Promise((r) => (wake = r))
    return lines.shift()
  }
  globalThis.nextLine = next
  const first = await next()
  input = typeof first.message.content === 'string' ? first.message.content : ''
} else if (kind !== 'codex' && !rpcMode && !piRpc) for await (const chunk of process.stdin) input += chunk
// 面板自动起标题（server/task-title.ts）：不记进调用日志，免得打乱各个测试数的调用次数；
// 用户消息里的 FAIL、SLOW 这些标记也不能生效，回复改成按用户消息的第一行起的标题
const titleFor = input.startsWith('给下面这段对话起一个标题。')
  ? (input.split('## 用户\n')[1] ?? '').split('\n')[0].slice(0, 20)
  : null
if (titleFor !== null) {
  if (process.env.FAKE_CLI_LOG) appendFileSync(process.env.FAKE_CLI_LOG + '.title', JSON.stringify({ kind }) + '\n')
  input = ''
}
if (process.env.FAKE_CLI_LOG && titleFor === null) {
  const log = process.env.FAKE_CLI_LOG
  const extra =
    kind === 'codex'
      ? { resume: appResume, developer, ...policy, op: appOp, fork: appFork, reviewTarget }
      : kind === 'pi'
        ? { op: piCompact ? 'compact' : undefined, forkAt: piForkAt }
        : { compactPct: process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE }
  // 用 API 时交给 CLI 的环境变量：测试检查接口地址和密钥传进来了
  const apiEnv = {
    anthropic: [process.env.ANTHROPIC_BASE_URL, process.env.ANTHROPIC_API_KEY, process.env.ANTHROPIC_AUTH_TOKEN],
    agentpanel: process.env.AGENT_PANEL_API_KEY,
    gemini: [process.env.GEMINI_API_KEY, process.env.GOOGLE_GEMINI_BASE_URL],
    trust: process.env.GEMINI_CLI_TRUST_WORKSPACE,
  }
  appendFileSync(
    log,
    JSON.stringify({ kind, args, cwd: process.cwd(), input, ...extra, apiEnv, pid: process.pid, start: Date.now() }) +
      '\n',
  )
  // 结束时间单独记一个文件，用来检查并行节点是否真的同时运行
  process.on('exit', () => appendFileSync(`${log}.end`, JSON.stringify({ pid: process.pid, end: Date.now() }) + '\n'))
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// 模拟一次调用要花的时间：默认和真实 CLI 一样有一点延迟，e2e 通过环境变量压到最小。
// 只有专门验证时序的用例（插话、停止、执行中发消息）才需要慢回合持续得久一点
const envMs = (name, def) => {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v >= 0 ? v : def
}
const TURN_MS = envMs('FAKE_TURN_MS', 150)
const SLOW_ROUND_MS = envMs('FAKE_SLOW_ROUND_MS', 250)
const SLOW_ROUNDS = envMs('FAKE_SLOW_ROUNDS', 40)
// 要改文件时才开独立分支：任务里有 BEGIN_EDIT、面板也给了 begin_edit 时，像真的 Agent 一样改文件前先调用；
// 开好后这一轮不再改文件（下面的 COMMIT 跳过），由面板在新目录里开新会话接着做
/** 调用面板自己的工具（panel MCP）：地址从 CLI 参数里的 MCP 配置取 */
async function panelCall(name, params) {
  const cfg = args.find((a) => a.startsWith('{"mcpServers"'))
  const servers = cfg ? JSON.parse(cfg).mcpServers : {}
  const url =
    servers[
      Object.keys(servers)
        .filter((k) => k.startsWith('panel'))
        .at(-1)
    ]?.url ??
    args
      .map((a) => a.match(/^mcp_servers\.(panel[\w-]*)\.url="(.*)"$/)?.[2])
      .filter(Boolean)
      .at(-1)
  // 没有面板 MCP（子任务、评审这类没有面板工具的角色）：像没这个工具一样报错，不要让整个进程崩掉
  if (!url) return { isError: true, content: [{ type: 'text', text: '这个角色没有面板工具' }] }
  const rpc = (id, method, params) =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    }).then(async (r) => {
      const text = await r.text()
      const data = text.split('\n').filter((l) => l.startsWith('data:'))
      return JSON.parse(data.length ? data[data.length - 1].slice(5).trim() : text)
    })
  await rpc(1, 'initialize', {})
  return (await rpc(2, 'tools/call', { name, arguments: params })).result
}
let beganEdit = false
if (input.includes('BEGIN_EDIT') && input.includes('begin_edit')) {
  const got = await panelCall('begin_edit', {})
  beganEdit = !got.isError
  if (process.env.FAKE_CLI_LOG)
    appendFileSync(process.env.FAKE_CLI_LOG + '.edit', JSON.stringify({ kind, cwd: process.cwd(), got }) + '\n')
}
// 子对话请父对话决定：任务里有 ASK_PARENT、面板给了 message_parent 时，带两个选项提问
if (input.includes('ASK_PARENT') && input.includes('message_parent') && !input.includes('用户的决定')) {
  await panelCall('message_parent', { text: '用 A 方案还是 B 方案？', question: true, options: ['A 方案', 'B 方案'] })
}
// 节点之间传话：任务里写了 SEND_MSG 给「目标」、面板也给了 send_message 时，像真的节点那样发一条
const sendTarget = /SEND_MSG 给「([^」]+)」/.exec(input)?.[1]
if (sendTarget && input.includes('send_message'))
  await panelCall('send_message', { to: sendTarget, text: '接口改名了，这边先按新名字写' })
// 执行计划：任务里有 PLAN_BG、面板给了 set_plan 时，列两步计划，第二步挂在后台命令上等结果
if (input.includes('PLAN_BG') && input.includes('set_plan')) {
  await panelCall('set_plan', {
    title: '后台等待',
    steps: [{ title: '改代码', status: 'done' }, { title: '跑测试' }],
  })
  await panelCall('run_background', { command: 'node -e "setTimeout(()=>{},300)"', name: '端到端测试', step: '2' })
}
// 计划结束就是结束了：下一件事直接开新计划，不需要先写总结（提示里已经写明「现在没有进行中的计划」）
if (input.includes('PLAN_NEXT') && input.includes('set_plan') && input.includes('现在没有进行中的计划'))
  await panelCall('set_plan', { title: '下一份计划', steps: [{ title: '继续改代码' }] })
// 后台命令要跑一会儿：这一轮说完时它还在跑，界面靠任务上的 jobs 转圈
if (input.includes('BG_LONG') && input.includes('run_background'))
  await panelCall('run_background', { command: 'node -e "setTimeout(()=>{},4000)"', name: '慢测试' })
// 子任务起的后台命令：子任务的 input 里有「派出的子 Agent」（它没有对话提示词里的长命令说明，不按 run_background 字样判断）。
// 命令不点名 step（引擎记子任务自己的步骤 id），看的是运行区和推回的归属
if (input.includes('SUB_BG') && input.includes('派出的子 Agent'))
  await panelCall('run_background', { command: 'node -e "setTimeout(()=>{},4000)"', name: '子任务慢测试' })
// 派一个会起后台命令的子任务（SUB_BG 只出现在子任务的指令里）
if (input.includes('SPAWN_SUB_BG') && input.includes('spawn_agents'))
  await panelCall('spawn_agents', {
    tasks: [{ title: '核对限流规则', instructions: 'SUB_BG 跑一条慢命令，跑完把结论交回' }],
  })
// 子对话做完：任务里有 SUBMIT_MERGE、面板给了 submit_merge 时，像真的 Agent 一样先派「评审」（完整测试之前），
// 最新一次评审通过之后才请父对话收尾；REVIEW_BLOCK 时第一次评审给 🛑，要先被面板拦下、改完复看才合回去
{
  // 评审子是任务角色（isReviewRole）：它没有面板工具，也不应换收尾流程
  // 交回结果的那一轮 input 里只有「你派出的子任务都结束了…」，不再带用户原话，所以按 [fake-review] 标记驱动后续
  const back = [...input.matchAll(/\[fake-review\] (pass|fail)/g)].at(-1)?.[1]
  const asked = input.includes('SUBMIT_MERGE') && input.includes('submit_merge')
  if (!beganEdit && !isReviewRole() && (asked || back)) {
    const review = (instructions) =>
      panelCall('spawn_agents', { tasks: [{ agent: '评审', title: '评审改动', instructions }] })
    // 评审是计划里的独立步骤：派的时候标等待中，拿回结论后标完成（面板 submit_merge 前会校验这一步）
    const plan = (steps) => {
      if (process.env.FAKE_CLI_LOG)
        appendFileSync(process.env.FAKE_CLI_LOG + '.plan', JSON.stringify({ kind, steps }) + '\n')
      return panelCall('set_plan', { steps })
    }
    const planOf = (stage) => {
      const code = { title: '改代码', status: 'done' }
      const first = { title: '评审本次改动', status: 'done', review: true }
      const fix = { title: '按评审意见修改', status: 'done' }
      const again = { title: '复看评审', status: 'done', review: true }
      const test = { title: '跑完整测试', status: 'done' }
      if (stage === 'asked') return [code, { title: '评审本次改动', status: 'waiting', review: true }]
      // 评审不通过时先只列到「按评审意见修改」：带着一条没做完的复看去请收尾，会被「计划还有步骤没做完」拦住，测不到评审结论那一道
      if (stage === 'fix') return [code, first, fix]
      if (stage === 'again') return [code, first, fix, { title: '复看评审', status: 'waiting', review: true }]
      return blocked ? [code, first, fix, again, test] : [code, first, test]
    }
    // 交回结果那一轮没有用户原话：这次是不是 🛑 场景、计划里要不要故意漏标 review，都记在临时目录的文件里（按工作目录区分）
    const flag = path.join(tmpdir(), `fake-review-${path.basename(process.cwd())}`)
    if (input.includes('REVIEW_BLOCK')) writeFileSync(flag, '1')
    if (input.includes('NO_REVIEW_PLAN')) writeFileSync(flag + '-noreview', '1')
    const blocked = existsSync(flag)
    const noReview = existsSync(flag + '-noreview')
    const merge = async () => {
      writeFileSync('child-done.txt', 'done\n')
      const got = await panelCall('submit_merge', {
        note: '改完了',
        tests: 'npm test 通过',
        handoff: { files: 'child-done.txt — 子对话完成的标记', decisions: '只写一个文件' },
      })
      if (process.env.FAKE_CLI_LOG)
        appendFileSync(process.env.FAKE_CLI_LOG + '.merge', JSON.stringify({ kind, cwd: process.cwd(), got }) + '\n')
      return got
    }
    if (!back) {
      // 第一次评审：任务里有 REVIEW_BLOCK 时让它数落出必须改项。标记写在 instructions 里，
      // 因为评审的 input 还带着子对话的原始需求（含 REVIEW_BLOCK），光看整个 input 分不出是哪一次
      // NO_REVIEW_PLAN：计划里只写标题、不标 review，用来验证「计划里缺少评审步骤」那一道
      await plan(
        input.includes('NO_REVIEW_PLAN')
          ? [
              { title: '改代码', status: 'done' },
              { title: '评审本次改动', status: 'done' },
            ]
          : planOf('asked'),
      )
      await review(
        `看这次改动的限定范围 diff，第一行写验收结论，再按 🛑 / 💭 / 💅 分级。REVIEW_MARK:${input.includes('REVIEW_BLOCK') ? 'fail' : 'pass'}`,
      )
    } else if (back === 'fail') {
      // 按评审意见改：写一个这次分支独有的文件，否则分支和父分支没差异，合回去不会产生合并提交
      writeFileSync('review-fixed.txt', 'fixed\n')
      // 评审标完成 + 单列一条「按评审意见修改」
      await plan(planOf('fix'))
      // 🛑 没改完却直接请父对话收尾：面板按评审结论拦下，这一轮的拒绝也记下来供测试检查
      const rejected = await merge()
      if (process.env.FAKE_CLI_LOG)
        appendFileSync(
          process.env.FAKE_CLI_LOG + '.review',
          JSON.stringify({ kind, rejected: rejected.isError === true }) + '\n',
        )
      // 改完把复看写进计划（独立步骤、同样标 review）再派一次评审
      await plan(planOf('again'))
      await review('改完了，再看一遍限定范围的 diff，第一行给验收结论。REVIEW_MARK:pass')
    } else {
      if (noReview) {
        // 计划里只有标题、没标 review：先请一次收尾，面板要按「计划里缺少评审步骤」拦下
        const rejected = await merge()
        if (process.env.FAKE_CLI_LOG)
          appendFileSync(
            process.env.FAKE_CLI_LOG + '.review',
            JSON.stringify({ kind, rejected: rejected.isError === true, reason: 'plan' }) + '\n',
          )
      }
      await plan(planOf('pass'))
      await merge()
    }
  }
}
// 父对话收到子对话的收尾请求：像真的 Agent 一样看过验证结果后调用 finish_child 收尾。
// 一轮里可能同时有几个子对话的收尾请求，每个都要处理（只处理第一个会让后面的子对话等到超时）
if (input.includes('finish_child')) {
  for (const id of wrapRequestIds(input)) {
    const got = await panelCall('finish_child', { id })
    if (process.env.FAKE_CLI_LOG)
      appendFileSync(process.env.FAKE_CLI_LOG + '.finish', JSON.stringify({ kind, id, got }) + '\n')
  }
}
// 退出前把插话收到的内容记下来，测试检查插话真的交给了 CLI
process.on('exit', () => {
  if (process.env.FAKE_CLI_LOG && steered.length)
    appendFileSync(process.env.FAKE_CLI_LOG + '.steer', JSON.stringify({ kind, steered }) + '\n')
})
const out = (o) => {
  if (!rpcMode) return process.stdout.write(JSON.stringify(o) + '\n')
  if (o.type === 'event')
    return process.stdout.write(JSON.stringify({ type: 'event', seq: ++rpcSeq, event: o.event }) + '\n')
  if (o.type !== 'result') return
  const ok = o.subtype === 'success'
  const stopReason = ok ? 'end_turn' : 'run_error'
  const usage = o.usage ?? {}
  process.stdout.write(
    JSON.stringify({
      type: 'event',
      seq: ++rpcSeq,
      event: { type: 'run_end', result: { finalText: o.finalText, stopReason, usage } },
    }) + '\n',
  )
  process.stdout.write(
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: {
        seq: ++rpcSeq,
        turnId: 'turn_1',
        stopReason,
        finalText: o.finalText,
        ...(ok ? {} : { error: { message: o.error ?? '模拟的失败' } }),
      },
    }) + '\n',
  )
}
/** 一轮结束：非 RPC 直接退出；RPC 等下一次 turn/start（保活）或 session/exit，返回 true 表示进程要退出 */
const exitTurn = async (code = 0) => {
  if (rpcMode) return await Promise.race([rpcExit.then(() => true), waitRpcTurn().then(() => false)])
  process.exit(code)
}
/**
 * 专用回复（优化说明文件、AI 创建这些提示）跑完一轮后：RPC 常驻时等面板关 stdin，
 * 不要往下走去跑通用的回复逻辑；非 RPC 直接退出
 */
const endSpecialTurn = async () => {
  if (!rpcMode) process.exit(0)
  await rpcExit
  process.exit(0)
}
// 工作流里只让第一个节点慢（后面的节点带着上游结果，也会含有 SLOW）
const slow = input.includes('SLOW') && !input.includes('上游节点的结果')
const fail = input.includes('FAIL')
// app-server 的通知
const note = (method, params) => out({ method, params: { threadId: session, turnId: 't1', ...params } })
const codexDone = (status, error) => {
  note('turn/completed', { turn: { id: 't1', status, error: error ? { message: error } : null, items: [] } })
  process.exit(0)
}
const file = isReviewRole() ? path.join(tmpdir(), `${kind}-output.txt`) : `${kind}-output.txt`
// 「AI 创建」的回复：一段说明 + JSON
const assistText = () => {
  const pick = (tag) => input.match(new RegExp(`${tag}:(.*)`))?.[1]?.trim()
  const json = (input.includes('不符合要求') && pick('FAKE_JSON2')) || pick('FAKE_JSON') || '{}'
  return `这是按你的要求生成的配置。\n\n\`\`\`json\n${json}\n\`\`\``
}
// 回复按当前 input 算：RPC 保活时同一进程会跑下一轮，input 已经换成新的那句
const turnReply = () => {
  if (titleFor !== null) return `「${titleFor}·AI」`
  if (input.startsWith('你是「Agent 面板」里的配置助手')) return assistText()
  // FAKE_EMPTY：第一轮只回一句「我先…」就收尾（复现模型只报准备语、不调工具），
  // 面板催了之后（提示里带「只说了要做什么就结束了这一轮」）才正常回复。用来测空回合自动接一轮。
  // 第一轮连工具都不发（noTools），否则 zero 工具永远不成立，这条分支就测不到。
  if (input.includes('FAKE_EMPTY') && !input.includes('只说了要做什么就结束了这一轮'))
    return '我先把工作区更新到最新，顺便确认分支和本地改动的基线。'
  const verdict = input.includes('最后单独一行写「验收结论')
    ? input.includes('第 1 轮验收')
      ? '\n验收结论：不通过'
      : '\n验收结论：通过'
    : ''
  // LONGOUT：第一个节点输出一份很长的结果（测试交接内容超过上限时存成文件）
  const long =
    input.includes('LONGOUT') && !input.includes('上游节点的结果') ? `\n${'很长的方案。'.repeat(1000)}结尾` : ''
  // 后面有条件连线的节点要给出结论：任务里有 BRANCHNO 时给「不通过」，用户补充了 GATEFIXED（修好了）后给「通过」
  const branch = input.includes('「结论：通过」或「结论：不通过」')
    ? `\n结论：${input.includes('BRANCHNO') && !input.includes('GATEFIXED') ? '不通过' : '通过'}`
    : ''
  // 主 Agent 的调度轮：评估节点时写 dispatch 决定。节点说明里有 MAINREWORK 时第一次评估退回，
  // 有 MAINDELEGATE:<工作流 id> 时第一次评估委派给它，有分支时按 BRANCHNO 选；流程完成时给一段最终结果
  const firstEval = input.includes('这是对它的第 1 次评估')
  const dispatch = input.includes('## 事件：这个对话的第一条要求')
    ? '\n```dispatch\n' + JSON.stringify({ action: 'run', input: '按需求执行' }) + '\n```'
    : input.includes('## 事件：节点完成')
      ? '\n```dispatch\n' +
        JSON.stringify(
          input.includes('MAINREWORK') && firstEval
            ? { action: 'rework', feedback: '补上错误处理' }
            : /MAINDELEGATE:(\S+)/.test(input) && firstEval
              ? { action: 'delegate', workflow: /MAINDELEGATE:(\S+)/.exec(input)[1], input: '帮忙检查一遍' }
              : input.includes('dispatch 里必须写 branch')
                ? { action: 'continue', branch: input.includes('BRANCHNO') ? 'fail' : 'pass', note: '注意兼容旧数据' }
                : { action: 'continue' },
        ) +
        '\n```'
      : input.includes('## 事件：流程完成')
        ? '\n最终结果：主 Agent 整理好了'
        : input.includes('## 事件：子 Agent 提问')
          ? '\n主 Agent 的回答：用方案一'
          : ''
  // 子对话收尾前派的评审（agent 写「评审」）：按分级给意见，最后一行给验收结论。
  // 结论由派它的子对话在 instructions 里用 REVIEW_MARK:pass / REVIEW_MARK:fail 指定（取最后一次），
  // 不能光看「input 里有没有 REVIEW_BLOCK」：评审的 input 里也带着子对话的原始需求。
  // 结尾的 [fake-review] pass/fail 是给下一轮识别用的：它会把这段输出作为子任务结果交回给派它的子对话。
  // 角色设定走 CLI 的 system prompt（在 args 里，不在 input），所以两份拼起来看才认得出来它是评审
  const roleText = [input, ...args].join('\n')
  const mark = [...roleText.matchAll(/REVIEW_MARK:(pass|fail)/g)].at(-1)?.[1] ?? 'pass'
  const review = roleText.includes('你负责独立评审')
    ? mark === 'fail'
      ? '\n验收结论：不通过\n🛑 必须改：child-done.txt 只写了一行，补上改了什么。\n[fake-review] fail'
      : '\n验收结论：通过\n💭 建议：提交说明可以再具体一点。\n[fake-review] pass'
    : ''
  // 评审子任务按约定把验收结论写在第一行：门禁先读首行，长报告被截断时也不会丢结论
  if (review)
    return `${review.trim()}

这是 ${kind} 的回复。收到 ${input.length} 个字符的任务描述。`
  return `这是 ${kind} 的回复。收到 ${input.length} 个字符的任务描述。${verdict}${branch}${dispatch}${long}${notesGot}`
}
// 没有插话协议的 CLI（Command Code、Gemini CLI）、Pi 的工具地址写在面板这一轮临时接上的配置里
// 写配置文件接的 CLI 每一轮用自己的名字（panel-xxxxxx），按参数和文件名找这一轮的那一项
// Pi 的桥接扩展在面板自己的临时目录里，用 -e 的绝对路径加载
const panelExt = () => args.find((a, i) => args[i - 1] === '-e' && /agent-panel-panel[\w-]*\.ts$/.test(a))
const panelMcpUrl = () =>
  kind === 'pi'
    ? /new URL\('([^']+)'\)/.exec(readFileSync(panelExt(), 'utf8'))[1]
    : (() => {
        const cfg = JSON.parse(readFileSync(kind === 'gemini' ? '.gemini/settings.json' : '.mcp.json', 'utf8'))
        const keys = Object.keys(cfg.mcpServers).filter((k) => k.startsWith('panel'))
        const hit = cfg.mcpServers[keys.at(-1)]
        return hit.httpUrl ?? hit.url
      })()

// 没有插话协议的 CLI（Command Code）：用户在执行中补充的要求会登记给它，模型用面板的工具取走。
// FAKE_NOTES 时反复取（等页面把补充发过来，最多 6 秒），拿到的话写进回复和日志
let notesGot = ''
if (input.includes('FAKE_NOTES') && !rpcMode && (kind === 'commandcode' || kind === 'gemini' || kind === 'pi')) {
  const url = panelMcpUrl()
  // 像真实 CLI 一样按 SSE 读：面板的提问工具用流式响应（等用户回答期间发心跳），别的接口是普通 JSON
  const rpc = (id, method, params) =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    }).then(async (r) => {
      const text = await r.text()
      const data = text.split('\n').filter((l) => l.startsWith('data:'))
      return JSON.parse(data.length ? data[data.length - 1].slice(5).trim() : text)
    })
  await rpc(1, 'initialize', {})
  const tools = (await rpc(2, 'tools/list', {})).result.tools.map((x) => x.name)
  for (let i = 0; i < 40 && !notesGot; i++) {
    const text = (await rpc(3, 'tools/call', { name: 'read_user_notes', arguments: {} })).result.content[0].text
    if (text === '没有新的补充') await sleep(150)
    else notesGot = `\n取到的补充：${text}`
  }
  if (process.env.FAKE_CLI_LOG)
    appendFileSync(
      process.env.FAKE_CLI_LOG + '.notes',
      JSON.stringify({ kind, tools, got: notesGot, hint: input.includes('read_user_notes') }) + '\n',
    )
}

// 一次性执行（stdin 传一个任务、跑一轮就退出）用的回复；RPC 保活时每轮用 turnReply() 重算
const reply = turnReply()
// 空回合：这一轮只回一句准备语，连工具都不调（复现「只回一句话就结束」）
const emptyTurn = input.includes('FAKE_EMPTY') && !input.includes('只说了要做什么就结束了这一轮')
// 一个字都不回、也不报用量的一轮：CLI 报这一轮「成功」，面板什么都没收到。
// 复现「网关吞掉请求后空成功收尾」——那一轮会被当成已完成并保活，用户后面发的消息全落进死回合。
// 面板重试时会带上「上一次请求没有返回任何内容」，那时正常回复
const silentTurn = () => input.includes('FAKE_SILENT') && !input.includes('上一次请求没有返回任何内容')

// 真的 CLI 一开始就报告会话 id，慢的时候也先报，测试「中断恢复」要用
if (slow && kind === 'claude')
  out({ type: 'system', subtype: 'init', session_id: session, model: 'claude-fake', cwd: process.cwd() })
for (let i = 0; i < (slow ? SLOW_ROUNDS : 1) && !interrupted; i++) await sleep(slow ? SLOW_ROUND_MS : TURN_MS)
// 被中断：像真的 CLI 一样结束这一轮，进程自己退出
if (interrupted) {
  if (kind === 'codex') {
    out({
      method: 'turn/completed',
      params: { threadId: session, turnId: 't1', turn: { id: 't1', status: 'interrupted', items: [] } },
    })
  } else if (kind === 'claude') {
    out({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'interrupted',
      session_id: session,
      usage: {},
    })
  } else if (rpcMode) {
    // 告诉面板这一轮被中断了，然后等 session/exit
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'turn/completed',
        params: { seq: ++rpcSeq, turnId: 'turn_1', stopReason: 'interrupted' },
      }) + '\n',
    )
    await rpcExit
  } else if (piRpc) {
    // Pi 中断后以 agent_settled(aborted) 结束这一轮
    out({ type: 'agent_settled', aborted: true })
    await piRpcExit
  }
  process.exit(0)
}
// Codex 的压缩和审查
if (kind === 'codex' && appOp === 'compact') {
  note('item/completed', { item: { id: 'cc', type: 'contextCompaction' } })
  codexDone('completed')
}
if (kind === 'codex' && appOp === 'review') {
  note('item/started', { item: { id: 'a9', type: 'agentMessage', text: '' } })
  note('item/agentMessage/delta', { itemId: 'a9', delta: '{"findings":[]}' })
  note('item/completed', { item: { id: 'rv', type: 'exitedReviewMode', review: '审查结论：没有发现问题。' } })
  codexDone('completed')
}
// Claude Code 的 /compact
if (kind === 'claude' && input === '/compact') {
  out({ type: 'system', subtype: 'init', session_id: session, model: 'claude-fake', cwd: process.cwd() })
  out({
    type: 'system',
    subtype: 'compact_boundary',
    session_id: session,
    compact_metadata: { trigger: 'manual', pre_tokens: 9000 },
  })
  out({ type: 'result', subtype: 'success', is_error: false, result: '', session_id: session, usage: {} })
  process.exit(0)
}

// 「AI 优化说明文件」：回一句说明和完整的新文件（在原内容后面补一节），只用 Command Code 的格式
if (input.startsWith('你在帮忙优化项目根目录下的说明文件') && kind === 'commandcode') {
  const old = input.match(/<<<文件开始\n([\s\S]*)\n文件结束>>>/)?.[1] ?? ''
  const text = `补上了常用命令。\n\n\`\`\`markdown\n${old}\n\n## 常用命令\n\n\`\`\`bash\nnpm test\n\`\`\`\n\`\`\``
  out({ type: 'event', event: { type: 'run_start', sessionId: session } })
  out({ type: 'event', event: { type: 'message_end', content: [{ type: 'text', text }] } })
  out({ type: 'result', subtype: 'success', sessionId: session, usage: {}, durationMs: 1, finalText: text })
  await endSpecialTurn()
}
// 「AI 创建」的提示：只回一段说明 + JSON。JSON 由用户消息里的 FAKE_JSON: 指定（一行），
// 带 FAKE_JSON2: 时，收到「不符合要求」的重试提示后改用它，用来测试自动修正
// Pi 走下面的正常流程（先调工具再回复），用来测工具行在 AI 创建里也会结束
if (input.startsWith('你是「Agent 面板」里的配置助手') && kind !== 'pi') {
  const text = assistText()
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

// UI 设计的对话：按 -c mcp_servers.design.url 调设计工具（MCP）改，回复只写普通文字。
// 要求里 FAKE_MCP:<一组 [工具名, 参数]> 时依次调这些工具；FAKE_DESIGN:<一行 JSON> 时把 root、components、ops、images、
// style、question 换成对应的工具调用，reply 作为回复。工具报错后有 FAKE_DESIGN2: 时接着按它改（像 AI 看到错误后修正），
// 收到「还有问题」的重试提示时直接用 FAKE_DESIGN2:
const mcpUrl = args.map((a) => a.match(/^mcp_servers\.design\.url="(.*)"$/)?.[1]).find(Boolean)
if (/^你是(游戏|网页) UI 设计助手/.test(input) && kind === 'codex' && mcpUrl) {
  let id = 0
  const rpc = async (method, params) => {
    const r = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    })
    return (await r.json()).result
  }
  const tool = async (name, args) => {
    const r = await rpc('tools/call', { name, arguments: args })
    note('item/completed', {
      item: {
        id: `t${id}`,
        type: 'mcpToolCall',
        server: 'design',
        tool: name,
        arguments: args,
        status: r.isError ? 'failed' : 'completed',
        ...(r.isError ? { error: { message: r.content[0].text } } : { result: { content: r.content } }),
      },
    })
    return r
  }
  await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fake' } })
  const tools = (await rpc('tools/list', {})).tools.map((t) => t.name)
  const pick = (tag) => [...input.matchAll(new RegExp(`${tag}:(.*)`, 'g'))].at(-1)?.[1]?.trim()
  let text
  if (/FAKE_MCP:/.test(input)) {
    const results = []
    for (const [name, a] of JSON.parse(pick('FAKE_MCP'))) results.push((await tool(name, a)).content[0].text)
    const check = await tool('check', {})
    text = `工具改好了（${tools.length} 个工具）：${results.join('；')}；检查：${check.content[0].text}`
  } else {
    const apply = async (j) => {
      let failed = false
      const call = async (name, a) => (failed = (await tool(name, a)).isError || failed)
      for (const c of j.components ?? [])
        await call('create_components', { items: [{ name: c.Name, size: c.DesignSize, root: c.Root }] })
      if (j.images?.length) await call('add_images', { images: j.images })
      if (j.root) {
        const cur = JSON.parse((await tool('get_tree', {})).content[0].text)
        await call('replace_widget', { name: cur.Name, widget: j.root })
      }
      if (j.ops?.length) await call('edit', { ops: j.ops })
      if (j.style) await call('set_design', { style: j.style })
      if (j.designSize) await call('set_design_size', j.designSize)
      if (j.question) await call('ask_user', { questions: [j.question] })
      return failed
    }
    const second = pick('FAKE_DESIGN2')
    let j = JSON.parse((input.includes('还有问题') && second) || pick('FAKE_DESIGN') || '{}')
    if ((await apply(j)) && second && !input.includes('还有问题')) await apply((j = JSON.parse(second)))
    await tool('check', {})
    text = j.reply ?? '好了'
  }
  for (const part of text.match(/[\s\S]{1,40}/g)) note('item/agentMessage/delta', { itemId: 'a0', delta: part })
  note('item/completed', { item: { id: 'a0', type: 'agentMessage', text } })
  codexDone('completed')
}
// UI 项目提示词：生成时给两条，翻译时把每条中文原样配上 EN: 前缀
if (input.startsWith('你在帮用户整理游戏 UI 生图用的提示词') && kind === 'codex') {
  const items = input.includes('翻译成给生图 AI 用的英文')
    ? JSON.parse(input.match(/条数和顺序不变：\n(.*)/)[1]).map((x) => ({ ...x, en: `EN:${x.zh}` }))
    : [
        { category: 'style', zh: '蒸汽朋克', en: 'steampunk' },
        { category: 'material', zh: '黄铜齿轮', en: 'brass gears' },
      ]
  const text = `\`\`\`json\n${JSON.stringify({ prompts: items })}\n\`\`\``
  note('item/completed', { item: { id: 'a0', type: 'agentMessage', text } })
  codexDone('completed')
}
// Codex 的 image_gen：每张图一个 imageGeneration 条目，第一张写到 savedPath，其余只给 base64；
// 描述里有 IMGFAIL 时报生成失败
if (input.startsWith('请用内置的 image_gen') && kind === 'codex') {
  let png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='
  // 图标表：纯绿底，每个图标一个 20×20 的色块放在各自的格子正中；描述里有 MISS3 时第 3 个图标「漏画」
  const grid = input.match(
    /(\d+) separate, individual icons of the same size, laid out one after another in a strict, evenly spaced grid of (\d+) columns × (\d+) rows/,
  )
  if (grid) {
    const [n, cols, rows] = grid.slice(1).map(Number)
    const W = cols * 40
    const H = rows * 40
    const raw = Buffer.alloc((W * 3 + 1) * H)
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = Math.floor(y / 40) * cols + Math.floor(x / 40)
        const inside = x % 40 >= 10 && x % 40 < 30 && y % 40 >= 10 && y % 40 < 30
        const on = inside && i < n && !(input.includes('MISS3') && i === 2)
        raw.set(on ? [200, 40 + i * 30, 40] : [0, 255, 0], y * (W * 3 + 1) + 1 + x * 3)
      }
    const chunk = (type, body) => {
      const head = Buffer.alloc(8)
      head.writeUInt32BE(body.length, 0)
      head.write(type, 4, 'ascii')
      const crc = Buffer.alloc(4)
      crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0)
      return Buffer.concat([head, body, crc])
    }
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(W, 0)
    ihdr.writeUInt32BE(H, 4)
    ihdr[8] = 8
    ihdr[9] = 2
    png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]).toString('base64')
  }
  const n = Number(input.match(/生成 (\d+) 张图片/)?.[1] ?? 1)
  for (let i = 0; i < n; i++) {
    const id = `ig${i}`
    if (input.includes('IMGFAIL')) {
      note('item/completed', {
        item: { id, type: 'imageGeneration', status: 'failed', failure: { message: '内容不符合政策' } },
      })
      continue
    }
    let savedPath
    if (i === 0) {
      savedPath = `${process.cwd()}/fake-${process.pid}.png`
      writeFileSync(savedPath, Buffer.from(png, 'base64'))
    }
    note('item/started', { item: { id, type: 'imageGeneration', status: 'inProgress', revisedPrompt: 'a button' } })
    note('item/completed', {
      item: {
        id,
        type: 'imageGeneration',
        status: 'completed',
        revisedPrompt: 'a button',
        result: savedPath ? '' : png,
        savedPath,
      },
    })
  }
  codexDone('completed')
}

// 像没登录的 CLI 一样报一句错，然后一直卡着不输出（测试空闲超时）
if (input.includes('HANG')) {
  process.stderr.write('Invalid API key · Please run /login\n')
  await new Promise(() => setInterval(() => {}, 60_000))
}

// 没有提问通道的 CLI（Command Code、Gemini CLI）：面板在工作目录里写了 MCP 配置，按 FAKE_ASK:<参数 JSON> 调 ask_user，
// 等用户回答后把工具返回的话当作回复
const askArgs = input.match(/FAKE_ASK:(.*)/)?.[1]
if (askArgs && (kind === 'gemini' || kind === 'commandcode' || kind === 'pi')) {
  const url = panelMcpUrl()
  // 像真实 CLI 一样按 SSE 读：面板的提问工具用流式响应（等用户回答期间发心跳），别的接口是普通 JSON
  const rpc = (id, method, params) =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    }).then(async (r) => {
      const text = await r.text()
      const data = text.split('\n').filter((l) => l.startsWith('data:'))
      return JSON.parse(data.length ? data[data.length - 1].slice(5).trim() : text)
    })
  await rpc(1, 'initialize', {})
  const tools = (await rpc(2, 'tools/list', {})).result.tools.map((x) => x.name)
  const got = (await rpc(3, 'tools/call', { name: 'ask_user', arguments: JSON.parse(askArgs) })).result.content[0].text
  if (process.env.FAKE_CLI_LOG)
    appendFileSync(
      process.env.FAKE_CLI_LOG + '.askbridge',
      JSON.stringify({ kind, tools, got, hint: input.includes('ask_user') }) + '\n',
    )
  const text = `收到：${got}`
  if (kind === 'pi') {
    const msg = { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', usage: {} }
    // RPC 模式没有会话头，以 agent_settled 结束；JSON 模式还是以会话头开始
    if (!piRpc) out({ type: 'session', version: 3, id: session, cwd: process.cwd() })
    if (piRpc) out({ type: 'turn_start' })
    out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } })
    if (piRpc) out({ type: 'message_end', message: msg })
    out({ type: 'agent_end', messages: [msg] })
    if (piRpc) {
      out({ type: 'agent_settled', aborted: false })
      await piRpcExit
    }
  } else if (kind === 'gemini') {
    const at = new Date().toISOString()
    out({ type: 'init', timestamp: at, session_id: session, model: 'gemini-fake' })
    out({ type: 'message', timestamp: at, role: 'assistant', content: text, delta: true })
    out({
      type: 'result',
      timestamp: at,
      status: 'success',
      stats: { total_tokens: 1, input_tokens: 1, output_tokens: 1, duration_ms: 1, tool_calls: 1 },
    })
  } else {
    out({ type: 'event', event: { type: 'run_start', sessionId: session } })
    out({ type: 'event', event: { type: 'message_end', content: [{ type: 'text', text }] } })
    out({ type: 'result', subtype: 'success', sessionId: session, usage: {}, durationMs: 1, finalText: text })
  }
  process.exit(0)
}

// Gemini CLI 的 --output-format stream-json
if (kind === 'gemini') {
  const at = new Date().toISOString()
  out({ type: 'init', timestamp: at, session_id: session, model: 'gemini-fake' })
  out({ type: 'message', timestamp: at, role: 'user', content: input })
  out({
    type: 'tool_use',
    timestamp: at,
    tool_name: 'read_file',
    tool_id: 'g1',
    parameters: { absolute_path: `${process.cwd()}/README.md` },
  })
  out({ type: 'tool_result', timestamp: at, tool_id: 'g1', status: 'success', output: '# README' })
  writeFileSync(file, 'g\n')
  out({
    type: 'tool_use',
    timestamp: at,
    tool_name: 'write_file',
    tool_id: 'g2',
    parameters: { file_path: file, content: 'g\n' },
  })
  out({ type: 'tool_result', timestamp: at, tool_id: 'g2', status: 'success', output: '' })
  for (const part of reply.match(/.{1,6}/g))
    out({ type: 'message', timestamp: at, role: 'assistant', content: part, delta: true })
  out({
    type: 'result',
    timestamp: at,
    status: fail ? 'error' : 'success',
    ...(fail ? { error: { type: 'FatalError', message: '模拟的失败' } } : {}),
    stats: { total_tokens: 5200, input_tokens: 5000, output_tokens: 200, duration_ms: 10, tool_calls: 2 },
  })
  process.exit(fail ? 1 : 0)
}

// Pi 的会话事件（--mode json / --mode rpc 共用）：JSON 模式第一行是会话头，RPC 模式用 get_state 拿会话 id
if (kind === 'pi') {
  const usage = (input, output) => ({
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
  })
  const assistant = (content, extra = {}) => ({
    role: 'assistant',
    content,
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'pi-fake',
    usage: usage(4000, 100),
    stopReason: 'stop',
    ...extra,
  })
  // 压缩：和真的 Pi 一样先发 compaction_start / compaction_end，再回 compact 的结果
  if (piCompact) {
    const result = { summary: '摘要', firstKeptEntryId: 'e1', tokensBefore: 9000, estimatedTokensAfter: 1200 }
    out({ type: 'compaction_start', reason: 'manual' })
    out({ type: 'compaction_end', reason: 'manual', result, aborted: false, willRetry: false })
    out({ type: 'response', command: 'compact', id: piCompact, success: true, data: result })
    await piRpcExit
    process.exit(0)
  }
  // 模型在前台跑 sleep 等 CI：插话要等这条命令跑完才会被取走，面板应当 abort 掉它、把插话作为新的一句交回来
  if (piRpc && input.includes('FAKE_PI_SLEEP')) {
    out({ type: 'agent_start' })
    out({ type: 'turn_start' })
    out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '等 CI 跑完' } })
    out({
      type: 'tool_execution_start',
      toolCallId: 's1',
      toolName: 'bash',
      args: { command: 'sleep 120; gh pr checks 14' },
    })
    const abortId = await new Promise((r) => {
      piSleepAbort = r
      setTimeout(() => r(null), 20000)
    })
    if (abortId === null) {
      out({
        type: 'tool_execution_end',
        toolCallId: 's1',
        toolName: 'bash',
        result: { content: [{ type: 'text', text: 'done' }] },
        isError: false,
      })
      out({ type: 'agent_settled', aborted: false })
      await piRpcExit
      process.exit(0)
    }
    out({
      type: 'tool_execution_end',
      toolCallId: 's1',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'Command aborted' }] },
      isError: true,
    })
    const stopped = assistant([], { stopReason: 'aborted' })
    out({ type: 'message_end', message: stopped })
    out({ type: 'agent_end', messages: [stopped] })
    out({ type: 'agent_settled', aborted: true })
    const next = new Promise((r) => (piNextPrompt = r))
    out({ type: 'response', command: 'abort', id: abortId, success: true })
    const text = await next
    if (process.env.FAKE_CLI_LOG)
      appendFileSync(process.env.FAKE_CLI_LOG + '.redirect', JSON.stringify({ text }) + '\n')
    out({ type: 'turn_start' })
    const reply = assistant([{ type: 'text', text: '好的，马上推送' }])
    out({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '好的，马上推送' },
    })
    out({ type: 'message_end', message: reply })
    out({ type: 'agent_end', messages: [reply] })
    out({ type: 'agent_settled', aborted: false })
    await piRpcExit
    process.exit(0)
  }
  // RPC 模式没有会话头，面板用 get_state 拿会话 id
  if (!piRpc) out({ type: 'session', version: 3, id: session, timestamp: new Date().toISOString(), cwd: process.cwd() })
  out({ type: 'agent_start' })
  out({ type: 'turn_start' })
  out({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: input }] } })
  out({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: '先看看' } })
  out({ type: 'tool_execution_start', toolCallId: 'p1', toolName: 'read', args: { path: 'README.md' } })
  out({
    type: 'tool_execution_end',
    toolCallId: 'p1',
    toolName: 'read',
    result: { content: [{ type: 'text', text: '# README' }] },
    isError: false,
  })
  writeFileSync(file, 'p\n')
  out({ type: 'tool_execution_start', toolCallId: 'p2', toolName: 'write', args: { path: file, content: 'p\n' } })
  out({
    type: 'tool_execution_end',
    toolCallId: 'p2',
    toolName: 'write',
    result: { content: [{ type: 'text', text: `Successfully wrote 2 bytes to ${file}` }] },
    isError: false,
  })
  for (const part of reply.match(/.{1,6}/gs))
    out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: part } })
  const last = fail
    ? assistant([], { stopReason: 'error', errorMessage: '模拟的失败' })
    : assistant([{ type: 'text', text: reply }])
  out({ type: 'message_end', message: last })
  out({ type: 'agent_end', messages: [last] })
  if (piRpc) {
    out({ type: 'agent_settled', aborted: !!interrupted })
    // 常驻进程：等面板关 stdin 再退出（和真的 Pi 一样）
    await piRpcExit
  }
  // Pi 出错时退出码也是 0
  process.exit(0)
}

if (kind === 'claude') {
  out({ type: 'system', subtype: 'init', session_id: session, model: 'claude-fake', cwd: process.cwd() })
  // 空回合：这一轮只说一句准备语就结束，不调任何工具（零工具 + 零改动才能触发面板的空回合判定）
  if (emptyTurn) {
    out({
      type: 'stream_event',
      event: { type: 'message_start', message: { id: 'm1', model: 'claude-fake', usage: { input_tokens: 10 } } },
    })
    out({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: reply }] } })
    out({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 20 } } })
    out({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: reply,
      session_id: session,
      total_cost_usd: 0,
      usage: { input_tokens: 10, output_tokens: 20 },
    })
    process.exit(0)
  }
  // 一个字都不回：只报这一轮成功，没有正文也没有用量（网关把请求吞掉时就是这样）
  if (silentTurn()) {
    out({ type: 'result', subtype: 'success', is_error: false, session_id: session })
    process.exit(0)
  }
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
  // 任务里有 COMMIT 时像真的 Agent 一样自己提交一次（测试提交后改动仍然统计在内）；评审这种只读子任务不做
  if (input.includes('COMMIT') && !beganEdit && !isReviewRole()) {
    writeFileSync('committed.txt', 'one\ntwo\nthree\n')
    const g = (...a) => execFileSync('git', ['-c', 'user.name=a', '-c', 'user.email=a@a', ...a], { stdio: 'ignore' })
    g('add', 'committed.txt')
    g('commit', '-qm', input.includes('子对话') ? '子对话提交' : 'agent commit')
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
      questions: [
        { question: '用哪个数据库？', header: '数据库', options: [{ label: 'SQLite' }, { label: 'MySQL' }] },
        { question: '要不要加缓存？', header: '缓存', options: [{ label: '加' }, { label: '不加' }] },
      ],
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
  out({
    type: 'assistant',
    uuid: `u-${session}-${input.length}`,
    message: { id: 'm2', content: [{ type: 'text', text: reply }] },
  })
  out({
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'allowed',
      unifiedWindows: {
        five_hour: { utilization: 0.25, resetsAt: 2000000000 },
        seven_day: { utilization: 0.5, resetsAt: 2000100000 },
      },
    },
  })
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
  note('item/started', {
    item: { id: 'c0', type: 'commandExecution', command: "bash -lc 'ls -la'", status: 'inProgress' },
  })
  note('item/commandExecution/outputDelta', { itemId: 'c0', delta: 'total 8\n' })
  note('item/commandExecution/outputDelta', { itemId: 'c0', delta: 'README.md\n' })
  note('item/completed', {
    item: {
      id: 'c0',
      type: 'commandExecution',
      command: "bash -lc 'ls -la'",
      exitCode: 0,
      status: 'completed',
      aggregatedOutput: 'total 8\nREADME.md\n',
    },
  })
  note('turn/diff/updated', { diff: '' })
  note('account/rateLimits/updated', {
    rateLimits: { primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 2000000000 }, secondary: null },
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
  // BIG_CONTEXT：上下文占用大的对话（交接摘要的叫醒判定要用）。
  // 面板交回子任务结果的那一轮接的是同一个会话，上下文不会比派子任务那轮小；这里也按大值报，
  // 免得「最后一轮只有一句交回说明」把上下文算小，叫醒已完成的子对话时误判成小上下文
  const big = input.includes('BIG_CONTEXT') || input.includes('你派出的子任务都结束了')
  const usage = {
    totalTokens: big ? 48300 : 24300,
    inputTokens: big ? 48000 : 24000,
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
  // 跑一轮：回复内容按当前 input 算（验收结论、dispatch、补充这些都带在里面）。
  // RPC 常驻时同一进程可以接着跑下一轮（面板保活复用）。返回 true 表示进程要退出
  const commandTurn = async () => {
    // NETFAIL：像真的 Command Code 一样连接中途断开，退出码 6；NETDOWN 每次都断（续接也断）
    const downMark = path.join(tmpdir(), `fake-netdown-${session}`)
    if (input.includes('NETDOWN')) writeFileSync(downMark, '')
    if (existsSync(downMark) || (input.includes('NETFAIL') && resumeIdx < 0)) {
      process.stderr.write(
        'Note: "fake/flash" routes via Command Code; your providers.json also declares it — use "me/fake/flash" to route there instead.\nError: Unable to connect to the API. Please check your network connection.\nStream connection failed mid-response: terminated\n',
      )
      if (rpcMode) {
        const error = { message: 'Stream connection failed mid-response: terminated' }
        process.stdout.write(
          JSON.stringify({ type: 'event', seq: ++rpcSeq, event: { type: 'run_error', error } }) + '\n',
        )
        process.stdout.write(
          JSON.stringify({
            jsonrpc: '2.0',
            method: 'turn/completed',
            params: { seq: ++rpcSeq, turnId: 'turn_1', stopReason: 'run_error', error },
          }) + '\n',
        )
      }
      process.exit(6)
    }
    // STALL_ONCE：收下这一轮后一个字都不回，像向模型的请求卡住了（测「CLI 没有响应」）。
    // 面板停掉它、接回会话重开时提示里带上「一直没有回应」，这次照常回复
    if (input.includes('STALL_ONCE') && !input.includes('一直没有回应'))
      await new Promise(() => setInterval(() => {}, 60_000))
    const r = turnReply()
    // 一个字都不回：只报这一轮正常结束，没有正文也没有用量（网关把请求吞掉、带图请求被拒时就是这样）
    if (silentTurn()) {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'turn/completed',
          params: { seq: ++rpcSeq, turnId: 'turn_1', stopReason: 'end_turn' },
        }) + '\n',
      )
      return await exitTurn(0)
    }
    // 空回合：只说一句准备语，连工具都不能发（否则零工具不成立，面板的空回合判定永远测不到）
    if (emptyTurn) {
      ev({ type: 'run_start', sessionId: session })
      ev({ type: 'model_request_start' })
      ev({ type: 'message_start' })
      ev({ type: 'message_end', content: [{ type: 'text', text: r }] })
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'turn/completed',
          params: { seq: ++rpcSeq, turnId: 'turn_1', stopReason: 'end_turn' },
        }) + '\n',
      )
      // 和正常一轮一样收尾：RPC 常驻时等面板发下一轮或关 stdin，直接 return 会让面板等不到这一轮结束
      return await exitTurn(0)
    }
    const bad = input.includes('FAIL')
    ev({ type: 'run_start', sessionId: session })
    ev({ type: 'model_request_start' })
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
    ev({ type: 'model_request_start' })
    ev({ type: 'message_start' })
    for (const part of r.match(/.{1,6}/g)) ev({ type: 'text_delta', delta: part })
    ev({ type: 'message_end', content: [{ type: 'text', text: r }] })
    // FAKE_WAIT / 打开对话页的预热：像按提示停在 wait_user_message 上一样，等用户下一句再接着输出
    let finalReply = r
    if ((input.includes('FAKE_WAIT') || input.includes('面板预热')) && !bad) {
      const url = panelMcpUrl()
      const call = (id, method, params) =>
        fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
          body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        }).then(async (res) => {
          const text = await res.text()
          const data = text.split('\n').filter((l) => l.startsWith('data:'))
          return JSON.parse(data.length ? data[data.length - 1].slice(5).trim() : text)
        })
      await call(1, 'initialize', {})
      const got = (await call(3, 'tools/call', { name: 'wait_user_message' })).result.content[0].text
      if (process.env.FAKE_CLI_LOG)
        appendFileSync(
          process.env.FAKE_CLI_LOG + '.wait',
          JSON.stringify({ kind, got, hint: input.includes('wait_user_message') }) + '\n',
        )
      if (!got.includes('用户已经离开了这个对话')) {
        const text = `\n等到的下一句：${got}`
        ev({ type: 'message_start' })
        for (const part of text.match(/.{1,6}/g)) ev({ type: 'text_delta', delta: part })
        ev({ type: 'message_end', content: [{ type: 'text', text }] })
        finalReply += text
      }
    }
    if (bad) {
      out({
        type: 'result',
        subtype: 'error',
        sessionId: session,
        usage: {},
        durationMs: 1,
        finalText: '',
        error: '模拟的失败',
      })
      return await exitTurn(1)
    }
    out({
      type: 'result',
      subtype: 'success',
      sessionId: session,
      usage: { inputTokens: 10000, outputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 0 },
      durationMs: 10,
      finalText: finalReply,
    })
    return await exitTurn(0)
  }
  // RPC 常驻：一轮结束后面板可能在同一进程里发下一次 turn/start（保活复用），循环到关 stdin
  if (!rpcMode) await commandTurn()
  else for (;;) if (await commandTurn()) break
}
