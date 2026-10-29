/**
 * 端到端测试的共享环境：每个分片（scripts/e2e/*.mjs）自己调一次 runShard()，
 * 各自建临时数据目录、假 CLI 日志、独立端口和服务，互不干扰，可以并行跑。
 *
 * 这里负责：临时目录和假项目仓库、假的 GitHub Releases、启动服务、HTTP 辅助、
 * 看门狗和收尾（失败时也要把服务关掉），以及各分片都要用的基础数据（设置、Agent、工作流、项目）。
 */
import http from 'node:http'
import { cleanTestEnv } from '../lib/test-env.mjs'
import net from 'node:net'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fmtDuration } from '../lib/duration.mjs'
import { clearCliOutputs, CLI_OUTPUT_FILES } from '../fake-cli/outputs.mjs'
import { startServer } from './spawn-server.mjs'
import { readLog } from './read-log.mjs'
import { fileURLToPath } from 'node:url'

// 端到端测试自己建仓库、自己跑服务：不能继承外面的 git dir。
// 在 WSL 里带 GIT_DIR / GIT_WORK_TREE 跑测试时，下面建假项目的 `git init` 会把这两个值
// 写进共享仓库的 .git/config（core.worktree = WSL 路径），主目录所有 git 命令都会失败；
// 拉起的服务也会继承它们，服务里建的 worktree 同样落到主仓库上（见 docs/lessons/testing.md）。
// GIT_CONFIG_COUNT 是面板给后台命令注入的防推送配置，测试里自己的 git 不需要它
delete process.env.GIT_DIR
delete process.env.GIT_WORK_TREE
delete process.env.GIT_INDEX_FILE
delete process.env.GIT_COMMON_DIR
delete process.env.GIT_CONFIG_COUNT

// 合并被假 CLI 的输出文件挡住时，清掉重试的次数：说明这一轮刚写完，重试几次就过去了；
// 一直被挡住说明不是残留造成的，要把原始错误抛出去，不能靠重试掩盖
const CLI_OUTPUT_RETRY_LIMIT = 3

// 1×1 的透明 PNG，用来测图片文件按原图读取
export const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
)

/**
 * 跑一个分片：fn(api) 里写这个分片的断言。
 * 看门狗、失败退出、收尾都在这里统一处理，各分片不用自己管。
 */
export async function runShard(shardName, fn) {
  // 假 CLI 靠 shebang 直接执行，脚本里也用 mkdir -p、tar 这类 Unix 命令：
  // Windows 上先给出能照着做的提示，不要跑到一半才报一堆看不懂的错
  if (process.platform === 'win32') {
    console.error(
      '端到端测试请在 WSL / macOS / Linux 上运行（Windows 上可以在 WSL 里装好依赖后跑 `npm run test:e2e:wsl`）。',
    )
    process.exit(1)
  }

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const fake = path.join(root, 'scripts/fake-cli/fake-cli.mjs')
  const tmp = mkdtempSync(path.join(tmpdir(), 'agent-panel-e2e-'))
  const dataDir = path.join(tmp, 'data')
  const homeDir = path.join(tmp, 'home')
  mkdirSync(homeDir, { recursive: true })
  const projectDir = path.join(tmp, 'project')
  const log = path.join(tmp, 'calls.jsonl')
  // 自己探测空闲端口：只给还需要「先拿端口再启动」的用例（见下面 api.freePort）。
  // 主服务不再用它：探测（listen 后立刻 close）和真正监听之间有窗口，并行的分片会拿到同一个端口
  const freePort = () =>
    new Promise((resolve, reject) => {
      const probe = net.createServer()
      probe.on('error', reject)
      probe.listen(0, '127.0.0.1', () => {
        const p = probe.address().port
        probe.close(() => resolve(p))
      })
    })

  // 项目目录：一个已有提交、并且有一处未提交改动的 git 仓库
  mkdirSync(projectDir, { recursive: true })
  const git = (...a) => execFileSync('git', a, { cwd: projectDir, stdio: 'pipe' })
  /** 在别的目录（任务的独立分支目录）里跑 git */
  const gitIn = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' })
  git('init', '-q')
  writeFileSync(path.join(projectDir, 'README.md'), '# demo\n')
  writeFileSync(path.join(projectDir, 'pre.txt'), 'old\n')
  git('add', '.')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
  writeFileSync(path.join(projectDir, 'pre.txt'), 'changed before the task\n')

  // 假的 GitHub Releases：三个版本，包是现做的 tar.gz，用来测试设置里的版本更新
  const appDir = path.join(tmp, 'app')
  const relDir = path.join(tmp, 'releases')
  mkdirSync(path.join(appDir, 'dist'), { recursive: true })
  mkdirSync(path.join(appDir, 'data'), { recursive: true })
  mkdirSync(relDir, { recursive: true })
  writeFileSync(path.join(appDir, 'server.mjs'), '// old\n')
  writeFileSync(path.join(appDir, 'dist/old.html'), 'old')
  writeFileSync(path.join(appDir, 'data/keep.json'), '{"keep":true}')
  // Windows 托盘程序：上次更新挪开的 AgentPanel.exe.old 还在运行，删不掉也不能被覆盖（这里用非空目录模拟）
  writeFileSync(path.join(appDir, 'AgentPanel.exe'), 'tray-old')
  mkdirSync(path.join(appDir, 'AgentPanel.exe.old'), { recursive: true })
  writeFileSync(path.join(appDir, 'AgentPanel.exe.old', 'busy'), '')
  for (const v of ['0.11.9-dev', '0.11.8', '0.11.4']) {
    const d = path.join(relDir, `agent-panel-${v}`)
    mkdirSync(path.join(d, 'dist'), { recursive: true })
    // 0.11.8 的服务端加载就出错：更新时试跑不通过，要退回原来的版本
    writeFileSync(path.join(d, 'server.mjs'), v === '0.11.8' ? 'process.exit(3)\n' : `// new ${v}\n`)
    writeFileSync(path.join(d, 'dist/index.html'), `<p>${v}</p>`)
    writeFileSync(path.join(d, 'start.sh'), '#!/bin/sh\n')
    writeFileSync(path.join(d, 'AgentPanel.exe'), `tray-${v}`)
    execFileSync('tar', ['-czf', `${d}.tar.gz`, `agent-panel-${v}`], { cwd: relDir })
    // 校验文件：0.11.4 的哈希故意写错
    const hash = createHash('sha256')
      .update(readFileSync(`${d}.tar.gz`))
      .digest('hex')
    writeFileSync(`${d}.sums`, `${v === '0.11.4' ? '0'.repeat(64) : hash}  agent-panel-${v}.tar.gz\n`)
  }
  // 旧版本平铺的数据文件，启动时应搬进 config/
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(path.join(dataDir, 'project-categories.json'), '[]')
  // 旧版本把所有任务放在一个 tasks.json 里，启动后拆成每个任务一个文件
  const legacyAt = '2026-10-01T00:00:00.000Z'
  writeFileSync(
    path.join(dataDir, 'tasks.json'),
    JSON.stringify([
      {
        id: 'legacy-1',
        projectId: 'legacy-project',
        title: '旧任务',
        mode: 'chat',
        status: 'done',
        messages: [{ id: 'm1', role: 'user', text: '旧的要求', at: legacyAt }],
        createdAt: legacyAt,
        updatedAt: legacyAt,
      },
    ]),
  )
  // 上一版每个任务一个完整文件（tasks/items/），启动后按项目分目录、对话单独存
  mkdirSync(path.join(dataDir, 'tasks/items'), { recursive: true })
  writeFileSync(
    path.join(dataDir, 'tasks/items/legacy-2.json'),
    JSON.stringify({
      id: 'legacy-2',
      projectId: '',
      title: '旧聊天',
      mode: 'chat',
      status: 'done',
      messages: [
        { id: 'm1', role: 'user', text: '旧的聊天', at: legacyAt },
        { id: 'm2', role: 'agent', text: '旧的回答', at: legacyAt },
      ],
      createdAt: legacyAt,
      updatedAt: legacyAt,
    }),
  )
  const relServer = http.createServer((req, res) => {
    const host = `http://127.0.0.1:${relServer.address().port}`
    if (req.url.startsWith('/releases')) {
      res.setHeader('content-type', 'application/json')
      const rel = (v, pre, day) => ({
        tag_name: `v${v}`,
        prerelease: pre,
        draft: false,
        published_at: `2026-10-${day}T00:00:00Z`,
        body: `## 新功能\n- **${v}** — 说明`,
        html_url: `${host}/r/${v}`,
        assets: [
          { name: `agent-panel-${v}.tar.gz`, browser_download_url: `${host}/dl/agent-panel-${v}.tar.gz`, size: 100 },
          { name: `agent-panel-${v}.zip`, browser_download_url: `${host}/dl/agent-panel-${v}.zip`, size: 100 },
          { name: 'SHA256SUMS', browser_download_url: `${host}/dl/agent-panel-${v}.sums`, size: 100 },
        ],
      })
      res.end(JSON.stringify([rel('0.11.9-dev', true, 16), rel('0.11.8', false, 15), rel('0.11.4', false, 10)]))
    } else if (req.url.startsWith('/dl/') && existsSync(path.join(relDir, req.url.slice(4)))) {
      res.end(readFileSync(path.join(relDir, req.url.slice(4))))
    } else {
      res.statusCode = 404
      res.end()
    }
  })
  await new Promise((r) => relServer.listen(0, '127.0.0.1', r))

  // 服务的环境变量：端口不在里面，由 spawn-server.mjs 决定（PORT=0 让系统分配，服务再把实际端口报回来）
  const serverEnv = {
    // 去掉继承的接口变量（scripts/lib/test-env.mjs）：机器上带着 ANTHROPIC_BASE_URL 时账号断言会变
    ...cleanTestEnv().env,
    AGENT_PANEL_DATA: dataDir,
    // 断言按空数据写的，不装内置工作流和 Agent（单元测试里单独测）
    // 账号测试会读写 CLI 的凭据文件：用临时的用户目录，不碰真正的 ~/.claude、~/.codex
    HOME: homeDir,
    USERPROFILE: homeDir,
    CLAUDE_CONFIG_DIR: '',
    CODEX_HOME: '',
    // 断言里用的是中文提示，固定用中文界面跑
    LANG: 'zh_CN.UTF-8',
    FAKE_CLI_LOG: log,
    AGENT_PANEL_NPM: path.join(root, 'scripts/fake-cli/fake-npm.mjs'),
    AGENT_PANEL_RELEASES_URL: `http://127.0.0.1:${relServer.address().port}/releases`,
    AGENT_PANEL_APP_DIR: appDir,
    AGENT_PANEL_VERSION: '0.11.5',
    AGENT_PANEL_NO_RESTART: '1',
    // 空闲超时按「分钟」设置，测试里一分钟只算 1.5 秒
    AGENT_PANEL_MINUTE_MS: '1500',
    // 假 CLI 的模拟耗时：普通回合 80ms（默认 150ms），慢回合 2.4s（默认 10s）。
    // 需要「任务还在跑」的用例都是等 CLI 启动后再操作（waitFor），不靠等满整段时间
    FAKE_TURN_MS: '80',
    FAKE_SLOW_ROUND_MS: '120',
    FAKE_SLOW_ROUNDS: '20',
    AGENT_PANEL_REDIRECT_MS: '600',
    // 交给 CLI 后多久没有任何输出算「没有响应」：默认 90 秒，测试里缩短
    AGENT_PANEL_NO_RESPONSE_MS: '2000',
    // 对话页切走后的宽限也缩短，测试不用等一分钟
    AGENT_PANEL_PRESENCE_GRACE_MS: '1200',
  }
  // 开发机的 shell 里可能恰好有 PORT（很常见的变量名）：端口由 spawn-server 决定（PORT=0 让系统分配），
  // 继承下来会让 8 个分片都去抢同一个端口，全量 e2e 全红
  delete serverEnv.PORT
  /**
   * 退出前要收尾的资源：临时起的 server、子进程。都登记进来，断言失败时统一关掉。
   * 不登记的话，没关的 server 会一直占着事件循环，进程明明已经失败却不退出，CI 会挂到超时才结束
   */
  const cleanups = new Set()
  const onExit = (fn) => {
    cleanups.add(fn)
    // 返回值可以立刻关掉这个资源，同时从登记表里去掉，退出时不会再关第二次
    return () => {
      if (!cleanups.delete(fn)) return
      fn()
    }
  }
  const cleanupAll = () => {
    // 后起的先关（临时 server 可能依赖先起的那几个）
    for (const fn of [...cleanups].reverse()) {
      cleanups.delete(fn)
      try {
        fn()
      } catch {}
    }
  }
  onExit(() => {
    relServer.closeAllConnections()
    relServer.close()
  })
  process.on('exit', cleanupAll)
  // 主流程之外抛出的错误（后台 promise、写文件失败）也走同一套收尾，不要留下半开的服务
  const fail = (e) => {
    console.error(e)
    process.exitCode = 1
    cleanupAll()
    process.exit(1)
  }
  process.on('uncaughtException', fail)
  process.on('unhandledRejection', fail)

  // 服务自己 listen(0) 把实际端口报回来，并回报分片唯一的 instance：端口被残留服务或并行的分片占着时
  // 立刻失败，不会出现「有东西在 /health 上回 {ok:true} 就当自己的服务起来了」的假通过
  let main
  try {
    main = await startServer({
      root,
      shardName,
      env: serverEnv,
      // 服务起来之后又退出（崩溃、被其他用例杀掉）时马上让分片失败，不等下一个请求超时
      onUnexpectedExit: (e) => fail(e),
    })
  } catch (e) {
    // 端口被占、服务启动即退出：直接失败并说清是哪种，不要等到第一个 waitFor 超时
    fail(e)
    return
  }
  const { port, baseUrl } = main
  onExit(() => main.stop())

  const call = async (method, url, body) => {
    // 下面大部分用例测的是按连线自动执行（每次调用的顺序、提示词都按这个断言）；没有编排器的那条单独写明 dispatch: true
    if (
      (method === 'POST' || method === 'PUT') &&
      /^\/workflows(\/[^/]+)?$/.test(url) &&
      body &&
      body.dispatch === undefined
    )
      body = { ...body, dispatch: false }
    const r = await fetch(baseUrl + url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body && JSON.stringify(body),
    })
    // 响应体先读文本再解析：不是 JSON 时把请求和响应开头带进错误里——
    // 以前直接 r.json() 只会报一个「Unexpected non-whitespace character after JSON」的栈，看不出是哪个请求
    const text = r.status === 204 ? '' : await r.text()
    // 204 之外的空响应也直接抛：静默返回 null 的话，调用方会在 .id 上拿一个没有上下文的 TypeError
    if (!text && r.status !== 204) throw new Error(`${method} ${url} -> ${r.status} 响应是空的`)
    let j = null
    if (text) {
      try {
        j = JSON.parse(text)
      } catch {
        throw new Error(`${method} ${url} -> ${r.status} 响应不是 JSON：${text.slice(0, 200)}`)
      }
    }
    if (!r.ok) throw new Error(`${method} ${url} -> ${r.status} ${JSON.stringify(j)}`)
    return j
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  /**
   * 等一个条件成立：条件一到就继续，不用整段时间都等满；超时才失败并打印当时的实际状态。
   * 固定 sleep 既慢又容易偶发失败（机器慢一点就不够），等状态出现更准
   */
  async function waitFor(fn, { timeout = 10000, interval = 50, label = '条件', describe } = {}) {
    const t0 = Date.now()
    for (;;) {
      const result = await fn()
      if (result) return result
      if (Date.now() - t0 > timeout) {
        const state = describe ? await describe().catch((e) => `（读状态失败：${e}）`) : ''
        // 带上等了多久和上限：失败时一眼看出是「差一点」还是「早就卡住了」，不用靠重跑猜
        const took = `等了 ${fmtDuration(Date.now() - t0)}，上限 ${fmtDuration(timeout)}`
        throw new Error(`等待超时（${took}）：${label}${state ? `，当前状态：${JSON.stringify(state)}` : ''}`)
      }
      await sleep(interval)
    }
  }
  async function waitDone(id, timeout = 20000) {
    const t0 = Date.now()
    for (;;) {
      const t = await call('GET', `/tasks/${id}`)
      if (t.status !== 'running') return t
      if (Date.now() - t0 > timeout) throw new Error(`任务 ${id} 超时仍在执行`)
      // 轮询间隔短一点：任务本身很快，150ms 会让每一步都多等一截
      await sleep(60)
    }
  }
  /** 等到条件成立（任务停下且 ok(t) 为真）：开独立分支后面板会马上接着开下一轮，中间可能短暂停下 */
  async function waitTask(id, ok, timeout = 30000) {
    const t0 = Date.now()
    for (;;) {
      const t = await call('GET', `/tasks/${id}`)
      if (t.status !== 'running' && ok(t)) return t
      if (Date.now() - t0 > timeout) {
        // 超时时带上最后几条消息和分支状态：不然只看得到「超时：done」，查不出卡在哪一步
        const tail = (t.messages ?? [])
          .slice(-6)
          .map(
            (m) => `  [${m.role}${m.panel ? `/${m.panel}` : ''}] ${(m.text ?? '').replace(/\s+/g, ' ').slice(0, 300)}`,
          )
          .join('\n')
        throw new Error(
          `任务 ${id} 超时：${t.status}（resolved=${!!t.resolved}，worktree=${t.worktree?.state ?? '无'}）\n${tail}`,
        )
      }
      await sleep(60)
    }
  }
  /**
   * 合并子对话的独立分支：每次尝试前先清掉项目目录里假 CLI 的输出文件。
   * 只清一次不够——任务还在执行时假 CLI 会再写一份（CI 上就是这样让合并撞上未跟踪文件的），
   * 所以清和重试放在同一个循环里；被这些文件挡住时清掉再来，连着被挡住才当成真的合不上。
   */
  async function mergeTask(id, { label = '合并独立分支', timeout = 15000 } = {}) {
    let merged
    let blocked = 0
    await waitFor(
      async () => {
        clearCliOutputs(projectDir)
        try {
          merged = await call('POST', `/tasks/${id}/worktree/merge`)
          return true
        } catch (e) {
          const message = String(e)
          // 这一轮还没跑完：等它结束再合，这期间假 CLI 会再往项目目录写一份输出文件
          if (/正在执行/.test(message)) return false
          if (CLI_OUTPUT_FILES.some((f) => message.includes(f)) && ++blocked < CLI_OUTPUT_RETRY_LIMIT) return false
          throw e
        }
      },
      { interval: 50, timeout, label },
    )
    return merged
  }
  const calls = () => {
    const ends = new Map(readLog(`${log}.end`).map((e) => [e.pid, e.end]))
    return readLog(log).map((c) => ({ ...c, end: ends.get(c.pid) }))
  }
  // 假 CLI 只有认了 BEGIN_EDIT 的那一轮才调面板 begin_edit，并把返回写进 .edit 记录（见 fake-cli.mjs）。
  // 「没走到开分支」和「调用了但失败」结论正好相反：前者是用例的提示词/等待提前了，后者是产品侧
  const edits = () => readLog(`${log}.edit`)

  // 看门狗：某一步卡住（等一个永远不返回的请求）时打印最后完成的步骤并失败退出，
  // 别让一整轮 e2e 把 CI 拖到 workflow 的超时。分片并行后每个分片各有一个，互不影响
  const WATCHDOG_MS = Number(process.env.AGENT_PANEL_E2E_WATCHDOG_MS ?? 10 * 60_000)
  // 计时：step 在该步断言全部跑完后调用，所以两次 step 的时间差就是上一步的耗时。
  // 没有这个数字就不知道优化该往哪放，也不知道改完到底快了多少
  const startedAt = Date.now()
  const timings = []
  let lastStepAt = startedAt
  let lastStep = '启动服务'
  const step = (name) => {
    const now = Date.now()
    const ms = now - lastStepAt
    lastStepAt = now
    timings.push({ name, ms })
    lastStep = name
    console.log(`✓ ${name}（${fmtDuration(ms)}）`)
  }
  const watchdog = setTimeout(() => {
    console.error(`[${shardName}] 超过 ${Math.round(WATCHDOG_MS / 60000)} 分钟没有跑完，最后完成：${lastStep}`)
    cleanupAll()
    process.exit(1)
  }, WATCHDOG_MS)

  // ---- 各分片共用的基础数据 ----
  // 基础 CLI 配置：都指向假 CLI，带一个环境变量（断言会检查它传给了子进程）
  const cli = (extra = {}) => ({
    enabled: true,
    command: fake,
    defaultModel: '',
    permission: '',
    extraArgs: [],
    env: [{ key: 'FOO', value: 'bar' }],
    ...extra,
  })
  const putSettings = async () => {
    const settings = {
      stepTimeoutMinutes: 5,
      clis: { claude: cli({ defaultModel: 'sonnet' }), codex: cli(), commandcode: cli(), pi: cli() },
    }
    await call('PUT', '/settings', settings)
    return { cli, settings }
  }
  /** 建一个 Agent：分片要自己造 Agent（例如能分派子对话的统筹）时也用它 */
  const agent = (o) =>
    call('POST', '/agents', {
      description: '',
      model: '',
      icon: 'bot',
      categoryId: '',
      instructions: '',
      extraArgs: [],
      enabled: true,
      ...o,
    })
  const createAgents = async () => {
    const A = await agent({ name: '甲', cli: 'claude', instructions: '你是甲，负责规划。' })
    const B = await agent({ name: '乙', cli: 'codex', model: 'gpt-5.6', instructions: '你是乙，负责实现。' })
    const C = await agent({ name: '丙', cli: 'commandcode', extraArgs: ['--effort', 'low'] })
    return { agent, A, B, C }
  }
  const createWorkflow = async (A, B, C) => {
    const node = (id, title, agentId, instructions, more = {}) => ({
      id,
      title,
      agentId,
      instructions,
      x: 0,
      y: 0,
      ...more,
    })
    let eid = 0
    const edges = (...pairs) => pairs.map(([from, to]) => ({ id: `e${++eid}`, from, to }))
    const flow = (id, name, nodes, es) => ({ id, name, nodes, edges: edges(...es) })
    const wf = await call('POST', '/workflows', {
      name: '三阶段',
      description: '',
      mainAgentId: A.id,
      members: [
        { agentId: B.id, responsibility: '' },
        { agentId: C.id, responsibility: '' },
      ],
      flows: [
        flow(
          'main',
          '主流程',
          [
            node('n1', '分析', '', '先分析。'),
            node('n2', '实现', B.id, '写代码。'),
            node('n3', '文档', C.id, '写文档。'),
            node('n4', '验收', '', '检查结果。'),
            node('n5', '没连上', '', ''),
          ],
          [
            ['start', 'n1'],
            ['n1', 'n2'],
            ['n1', 'n3'],
            ['n2', 'n4'],
            ['n3', 'n4'],
            ['n4', 'end'],
          ],
        ),
      ],
      entryFlowId: 'main',
      document: '# 目标\n测试\n',
    })
    return { node, edges, flow, wf }
  }
  const createProject = async (wf) =>
    call('POST', '/projects', {
      name: '测试项目',
      description: '',
      path: projectDir,
      categoryId: '',
      workflowId: wf.id,
      // 下面大部分子对话的测试按共用目录写；独立 worktree 有单独的测试
      childIsolation: 'claim',
    })
  /** 大部分分片要的完整基础数据：设置、Agent、工作流、项目 */
  const setupBase = async () => {
    const { cli: cliOf, settings } = await putSettings()
    const agents = await createAgents()
    const wfParts = await createWorkflow(agents.A, agents.B, agents.C)
    const project = await createProject(wfParts.wf)
    return { cli: cliOf, settings, ...agents, ...wfParts, project }
  }

  const api = {
    root,
    fake,
    tmp,
    dataDir,
    homeDir,
    projectDir,
    appDir,
    relDir,
    relPort: relServer.address().port,
    log,
    port,
    baseUrl,
    freePort,
    PNG_1PX,
    git,
    gitIn,
    call,
    sleep,
    waitFor,
    waitDone,
    waitTask,
    mergeTask,
    calls,
    edits,
    readLog,
    step,
    onExit,
    clearCliOutputs,
    cli,
    agent,
    putSettings,
    createAgents,
    createWorkflow,
    createProject,
    setupBase,
  }

  const reportTimings = () => {
    const total = Date.now() - startedAt
    const top = [...timings].sort((a, b) => b.ms - a.ms).slice(0, 10)
    console.log(`\n[${shardName}] 总耗时 ${fmtDuration(total)}，共 ${timings.length} 步`)
    if (top.length) {
      console.log('最慢的 10 步：')
      top.forEach((t, i) => console.log(`  ${String(i + 1).padStart(2)}. ${fmtDuration(t.ms).padStart(7)}  ${t.name}`))
    }
    // 分片并行时由 runner 通过这个环境变量把每个分片的计时收集到一个文件里
    const out = process.env.AGENT_PANEL_E2E_TIMINGS
    if (out) {
      try {
        mkdirSync(path.dirname(out), { recursive: true })
        writeFileSync(out, JSON.stringify({ shard: shardName, total, steps: timings, top }, null, 2))
      } catch (e) {
        console.error(`[${shardName}] 写计时文件失败：`, e)
      }
    }
  }

  try {
    await fn(api)
    console.log(`[${shardName}] 全部通过`)
  } catch (e) {
    console.error(e)
    process.exitCode = 1
  } finally {
    clearTimeout(watchdog)
    cleanupAll()
    reportTimings()
    // 收尾后可能还有句柄拖着事件循环（测试自己起的 fetch 连接池、子进程管道）。
    // unref 的定时器只有在这种情况下才会触发：到点就直接按退出码退出，不再等它们自然关闭
    setTimeout(() => {
      if (process.exitCode) console.error('收尾后还有管道 / 连接没关，按退出码强制退出')
      process.exit(process.exitCode ?? 0)
    }, 2000).unref()
  }
}
