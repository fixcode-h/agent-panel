/**
 * 真实 API 评测集（扩展 5）：在样例仓库上用真实 CLI 和真实模型跑一组固定任务（eval-tasks.mjs），
 * 产出 Agent 流程数据（扩展 4 的口径：推进次数、交代结束、评审退回、合回失败、等你时长）加 token 和耗时。
 * 改内置角色、回合规则、钩子文案前后各跑一次，用 --compare 对比两份结果。
 *
 * 不进 CI（要花钱、要等模型）。用法：
 *   EVAL_BASE_URL=https://api.example.com EVAL_API_KEY=your-api-key EVAL_MODEL=claude-sonnet-x \
 *     npm run eval:real -- [--label 改之前] [--only edit-fn,fix-bug] [--out 结果.json]
 *   npm run eval:real -- --compare 改之前.json 改之后.json
 *
 * 其他环境变量：EVAL_CLI（默认 claude，要本机装好）、EVAL_PROTOCOL（默认 anthropic）、
 * EVAL_TIMEOUT_MIN（每个任务最多等几分钟，默认 20）。不给 EVAL_BASE_URL 时用 CLI 自己登录的账号。
 *
 * 服务和 CLI 都在干净的环境里起（scripts/lib/test-env.mjs 去掉 ANTHROPIC_* 这类继承变量，HOME 和数据目录放临时目录）：
 * 云端会话里的会话凭据会被 CLI 优先拿去用，把请求发错地方。接口和密钥只经面板设置交给 CLI，不进日志和结果文件。
 * 评测替用户做的事：权限请求一律允许（推送授权一律拒绝），提问按任务里写的 answer 回答，节点确认直接通过。
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { agentStats } from '../../shared/agent-stats.ts'
import { fmtDuration } from '../lib/duration.mjs'
import { startServer } from '../e2e/spawn-server.mjs'
import { EVAL_TASKS, makeSample } from './eval-tasks.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const { values: opt } = parseArgs({
  options: {
    label: { type: 'string', default: '' },
    only: { type: 'string', default: '' },
    out: { type: 'string', default: '' },
    compare: { type: 'boolean', default: false },
    keep: { type: 'boolean', default: false },
  },
  allowPositionals: true,
  strict: false,
})

/** 结果里每个任务记的数：扩展 4 的那几项加 token、费用、耗时和做没做对 */
const METRICS = [
  ['ok', '做对'],
  ['convs', '对话数'],
  ['drives', '推进'],
  ['turns', '轮数'],
  ['endBlocked', '卡住'],
  ['reviewRejects', '评审退回'],
  ['mergeFails', '合回失败'],
  ['waitMs', '等你'],
  ['tokens', 'Token'],
  ['costUsd', '费用'],
  ['ms', '耗时'],
]

const fmt = (key, v) =>
  v === undefined
    ? '—'
    : key === 'ok'
      ? v
        ? '✓'
        : '✗'
      : key === 'waitMs' || key === 'ms'
        ? fmtDuration(v)
        : key === 'costUsd'
          ? `$${v.toFixed(3)}`
          : String(v)

function table(rows, head) {
  const widths = head.map((h, i) => Math.max(h.length * 2, ...rows.map((r) => String(r[i]).length)))
  const line = (r) => r.map((c, i) => String(c).padEnd(widths[i])).join('  ')
  return [line(head), ...rows.map(line)].join('\n')
}

/** --compare a.json b.json：逐个任务、逐项写「前 → 后」 */
function compare(files) {
  const [a, b] = files.map((f) => JSON.parse(readFileSync(f, 'utf8')))
  console.log(`对比：${a.label || files[0]}（${a.model}）→ ${b.label || files[1]}（${b.model}）\n`)
  const ids = [...new Set([...a.tasks, ...b.tasks].map((x) => x.id))]
  const rows = ids.map((id) => {
    const x = a.tasks.find((t) => t.id === id)
    const y = b.tasks.find((t) => t.id === id)
    return [
      id,
      ...METRICS.map(([k]) => {
        const p = fmt(k, x?.[k])
        const q = fmt(k, y?.[k])
        return p === q ? p : `${p}→${q}`
      }),
    ]
  })
  console.log(table(rows, ['任务', ...METRICS.map(([, l]) => l)]))
}

if (opt.compare) {
  const files = process.argv.slice(2).filter((x) => !x.startsWith('--'))
  if (files.length !== 2) {
    console.error('用法：--compare 前.json 后.json')
    process.exit(1)
  }
  compare(files)
  process.exit(0)
}

const cli = process.env.EVAL_CLI || 'claude'
const model = process.env.EVAL_MODEL || ''
const baseUrl = process.env.EVAL_BASE_URL || ''
const timeoutMs = Number(process.env.EVAL_TIMEOUT_MIN || 20) * 60_000
const only = new Set(opt.only.split(',').filter(Boolean))
const tasks = EVAL_TASKS.filter((x) => !only.size || only.has(x.id))
if (!tasks.length) {
  console.error(`没有要跑的任务：--only 里的 id 要是 ${EVAL_TASKS.map((x) => x.id).join('、')} 之一`)
  process.exit(1)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tmp = mkdtempSync(path.join(tmpdir(), 'agent-panel-eval-'))
const dataDir = path.join(tmp, 'data')
const homeDir = path.join(tmp, 'home')
mkdirSync(homeDir, { recursive: true })
const server = await startServer({
  root,
  shardName: 'eval',
  timeoutMs: 120_000,
  // GH_TOKEN 这类凭据也清空：评测里的 Agent 不该碰到真实仓库
  env: { AGENT_PANEL_DATA: dataDir, HOME: homeDir, USERPROFILE: homeDir, GH_TOKEN: '', GITHUB_TOKEN: '' },
})
/** 关服务并删临时目录：等服务进程真的退出再删，不然它还在写数据目录，删到一半报 ENOTEMPTY */
const cleanup = async () => {
  const exited = server.child.exitCode !== null ? Promise.resolve() : new Promise((r) => server.child.once('exit', r))
  server.stop()
  await Promise.race([exited, sleep(10_000)])
  if (!opt.keep) rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
}
process.on('SIGINT', () => void cleanup().finally(() => process.exit(130)))

async function call(method, url, body) {
  const r = await fetch(server.baseUrl + url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body && JSON.stringify(body),
  })
  const text = r.status === 204 ? '' : await r.text()
  if (!r.ok) throw new Error(`${method} ${url} -> ${r.status} ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : null
}

// 设置：接口经面板的 API 配置交给 CLI；内置角色按档位选模型，三档都指到同一个模型，免得用到接口里没有的默认模型
const tier = { model, effort: '' }
// 整份设置一起存（PUT 是整份替换）：先取当前的，只改评测要的几项
const settings = await call('GET', '/settings')
await call('PUT', '/settings', {
  ...settings,
  defaultCli: cli,
  ...(baseUrl
    ? {
        apis: [
          {
            id: 'eval',
            name: 'Eval',
            protocol: process.env.EVAL_PROTOCOL || 'anthropic',
            baseUrl,
            apiKey: process.env.EVAL_API_KEY || '',
            models: model ? [model] : [],
          },
        ],
      }
    : {}),
  clis: {
    ...settings.clis,
    [cli]: {
      ...settings.clis?.[cli],
      enabled: true,
      defaultModel: model,
      ...(model ? { tiers: { high: tier, medium: tier, low: tier } } : {}),
      ...(baseUrl ? { authMode: 'api', apiId: 'eval' } : {}),
    },
  },
})
// 自带工作流是服务起来后在后台装的：等它装上，最多一分钟
let general
for (let i = 0; i < 120 && !general; i++) {
  general = (await call('GET', '/workflows')).find((w) => w.origin === 'builtin:project-general')
  if (!general) await sleep(500)
}
if (!general) {
  await cleanup()
  throw new Error('等了一分钟还没装上内置的「通用项目」工作流，看服务日志')
}

/** 替用户处理一个请求：推送一律拒绝，提问按任务的 answer 答，别的一律允许（能一直允许的就一直允许） */
function answerFor(req, task) {
  if (req.purpose === 'push') return { allow: false }
  if (req.kind === 'question') {
    const text = task.answer || '按你推荐的做，不用再问我。'
    return req.questions?.length > 1
      ? { allow: true, answers: req.questions.map(() => text) }
      : { allow: true, answer: text }
  }
  return { allow: true, always: !!req.rule }
}

/** 这个对话和名下所有子对话（GET /tasks/flow 里 rootId 指向它的） */
async function family(id) {
  const briefs = await call('GET', '/tasks/flow')
  return briefs.filter((b) => b.id === id || b.rootId === id)
}

const busy = (tk) => tk.status === 'running' || tk.working || (tk.requests ?? []).length > 0

/** 跑一个任务：建样例仓库和项目、发起对话、替用户应答，等整棵对话树连续几次都停下来 */
async function runTask(task) {
  const dir = path.join(tmp, 'repos', task.id)
  mkdirSync(dir, { recursive: true })
  makeSample(dir, task.files)
  const project = await call('POST', '/projects', {
    name: `评测 · ${task.title}`,
    description: '',
    path: dir,
    categoryId: '',
    workflowId: general.id,
    testSteps: [{ id: 'unit', name: '单元测试', command: 'node --test', quick: true }],
  })
  const started = Date.now()
  const top = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'chat',
    agentId: general.mainAgentId,
    workflowId: general.id,
    prompt: task.prompt,
  })
  let calm = 0
  let timedOut = false
  // 面板停下后可能马上推它接着做：连续 3 次（15 秒）都没在跑、没有请求挂着才算真停了
  while (calm < 3) {
    if (Date.now() - started > timeoutMs) {
      timedOut = true
      break
    }
    await sleep(5000)
    let anyBusy = false
    for (const b of await family(top.id)) {
      const tk = await call('GET', `/tasks/${b.id}`)
      for (const req of tk.requests ?? [])
        await call('POST', `/tasks/${tk.id}/requests/${req.id}`, answerFor(req, task)).catch((e) =>
          // 请求可能刚被面板收掉：报出来，不当成评测失败
          console.warn(`  应答请求失败（${tk.title}）：${e.message}`),
        )
      if (busy(tk)) anyBusy = true
    }
    calm = anyBusy ? 0 : calm + 1
  }
  if (timedOut) await call('POST', `/tasks/${top.id}/stop`).catch(() => {})
  const briefs = await family(top.id)
  const s = agentStats(briefs)
  // 顶层对话执行失败（CLI 没装、接口不通）时仓库多半没动，只读那题会被误判成做对：先认失败
  const end = await call('GET', `/tasks/${top.id}`)
  const err = (end.messages ?? []).findLast((m) => m.error)?.text?.split('\n')[0]
  const failed = end.status === 'failed' ? `对话失败：${err || '看面板里的报错'}` : ''
  const ok = task.check(dir)
  return {
    id: task.id,
    title: task.title,
    ok: ok === true && !timedOut && !failed,
    why: timedOut ? `超时（${fmtDuration(timeoutMs)}）` : failed || (ok === true ? '' : ok),
    convs: s.total,
    drives: s.drives,
    turns: s.turns,
    endDone: s.endDone,
    endBlocked: s.endBlocked,
    reviewRejects: s.reviewRejects,
    mergeFails: s.mergeFails,
    waitMs: s.waitMs,
    tokens: s.tokens,
    costUsd: s.costUsd,
    ms: Date.now() - started,
    briefs,
  }
}

const results = []
try {
  console.log(`评测 ${tasks.length} 个任务：${cli}${model ? ` · ${model}` : ''}，临时目录 ${tmp}`)
  for (const task of tasks) {
    console.log(`- ${task.id}（${task.title}）…`)
    const r = await runTask(task).catch((e) => ({ id: task.id, title: task.title, ok: false, why: e.message }))
    results.push(r)
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.why || ''}`.trimEnd())
  }
} finally {
  await cleanup()
}

const out =
  opt.out ||
  path.join(
    root,
    '.tmp/eval',
    `${new Date().toISOString().replace(/[:.]/g, '-')}${opt.label ? `-${opt.label}` : ''}.json`,
  )
mkdirSync(path.dirname(out), { recursive: true })
writeFileSync(
  out,
  JSON.stringify({ label: opt.label, cli, model, at: new Date().toISOString(), tasks: results }, null, 2),
)
console.log(
  `\n${table(
    results.map((r) => [r.id, ...METRICS.map(([k]) => fmt(k, r[k]))]),
    ['任务', ...METRICS.map(([, l]) => l)],
  )}`,
)
console.log(`\n结果写在 ${path.relative(root, out)}；改动后再跑一次，用 --compare 对比`)
process.exit(results.every((r) => r.ok) ? 0 : 1)
