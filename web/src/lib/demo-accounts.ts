import { CLIS } from '@shared/clis'
import type { CliAccounts, LoginJob, SavedAccount } from '@shared/schema'
import type { DetectedApi } from '@shared/accounts'
import { demoMs } from './demo-speed'

/**
 * 在线演示里的账号：没有本机的 CLI 和凭据，数据放在内存里，登录用一段假的过程演示
 */
interface Demo {
  live: string
  accounts: SavedAccount[]
}
const state = new Map<string, Demo>()
const jobs = new Map<string, LoginJob>()

const demo = (cli: string): Demo => {
  let s = state.get(cli)
  if (!s) {
    s = { live: 'demo@example.com', accounts: [] }
    s.accounts.push({
      id: 'a1',
      name: 'demo@example.com',
      email: 'demo@example.com',
      savedAt: new Date().toISOString(),
    })
    state.set(cli, s)
  }
  return s
}

const list = (cli: string): CliAccounts => {
  const def = CLIS.find((c) => c.id === cli)
  const s = demo(cli)
  const active = s.accounts.find((a) => a.email === s.live)
  return {
    cli,
    canLogin: !!def?.auth?.login.length,
    canApi: !!def?.auth?.api,
    live: { loggedIn: !!s.live, email: s.live, label: s.live },
    unsaved: !!s.live && !active,
    accounts: s.accounts.map((a) => ({ ...a, active: a.id === active?.id })),
  }
}

export function demoAccounts(method: string, seg: string[], body: Record<string, any>): unknown {
  // 一键更新：演示时没有真正的 CLI 配置文件可写
  if (seg[0] === 'apis' && seg[2] === 'apply') return { clis: [] }
  const [, cli, sub, id] = seg
  if (!cli) return CLIS.filter((c) => c.auth).map((c) => list(c.id))
  // 演示：像是在本机 Claude Code 和 Codex 的配置里识别到的两个网关
  if (cli === 'detected-apis')
    return [
      {
        cli: 'claude',
        source: '~/.claude/settings.json',
        api: {
          id: 'det-claude',
          name: 'Claude Code · settings.json',
          provider: '',
          protocol: 'anthropic',
          baseUrl: 'https://gateway.example.com/anthropic',
          apiKey: 'sk-demo-xxxxxxxxxxxxxxxx',
          authHeader: 'bearer',
          models: ['claude-sonnet-5-5'],
          modelMap: {},
          modelEfforts: {},
          maxConcurrent: 0,
        },
      },
      {
        cli: 'codex',
        source: '~/.codex/config.toml',
        api: {
          id: 'det-codex',
          name: 'Codex · openrouter',
          provider: 'openrouter',
          protocol: 'openai-responses',
          baseUrl: 'https://openrouter.ai/api/v1',
          apiKey: 'sk-or-demo-0000',
          authHeader: 'x-api-key',
          models: [],
          modelMap: {},
          modelEfforts: {},
          maxConcurrent: 0,
        },
      },
    ] satisfies DetectedApi[]
  if (cli === 'api-models') {
    const base = String(body.baseUrl ?? '')
    return {
      models:
        body.protocol === 'anthropic'
          ? ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']
          : body.protocol === 'gemini'
            ? ['gemini-3-pro', 'gemini-3-flash']
            : [`${base.includes('deepseek') ? 'deepseek' : 'gpt'}-chat`, 'gpt-6-sol', 'gpt-6-luna'],
    }
  }
  // 演示：模型探针不真发请求，直接报能通（前端在模型为空时不会调到这里）
  if (cli === 'api-probe') return { model: String(body.model ?? '') }
  // 演示：余额按 DeepSeek 的返回格式给一份假数据
  if (cli === 'api-balance')
    return {
      available: true,
      rows: [{ currency: 'CNY', total: '110.00', granted: '10.00', toppedUp: '100.00' }],
    }
  const s = demo(cli)
  // 演示里的凭据检查：一家能用、一家没配
  if (sub === 'check')
    return [
      { provider: 'anthropic', ready: true, status: 'ready', authType: 'oauth' },
      { provider: 'openai', ready: false, status: 'not_ready', reason: 'credentials_not_configured' },
    ]
  if (sub === 'login') {
    if (method === 'GET') return jobs.get(cli) ?? null
    if (method === 'DELETE') {
      jobs.delete(cli)
      return { ok: true }
    }
    const job: LoginJob = {
      id: crypto.randomUUID(),
      cli,
      status: 'running',
      url: 'https://example.com/oauth/authorize?demo=1',
      output: '在浏览器里完成登录（演示）',
      startedAt: Date.now(),
    }
    jobs.set(cli, job)
    setTimeout(() => {
      const n = s.accounts.length + 1
      s.live = `user${n}@example.com`
      s.accounts.push({ id: `a${n}`, name: s.live, email: s.live, savedAt: new Date().toISOString() })
      job.status = 'done'
    }, demoMs(2200))
    return job
  }
  if (sub === 'save') {
    if (s.live && !s.accounts.some((a) => a.email === s.live))
      s.accounts.push({
        id: `a${s.accounts.length + 1}`,
        name: s.live,
        email: s.live,
        savedAt: new Date().toISOString(),
      })
  } else if (sub === 'switch') s.live = s.accounts.find((a) => a.id === body.id)?.email ?? s.live
  else if (sub === 'logout') s.live = ''
  else if (sub === 'accounts' && method === 'PATCH')
    s.accounts = s.accounts.map((a) => (a.id === id ? { ...a, name: String(body.name ?? a.name) } : a))
  else if (sub === 'accounts' && method === 'DELETE') s.accounts = s.accounts.filter((a) => a.id !== id)
  return list(cli)
}
