import { CLIS } from '@shared/clis'
import type { CliAccounts, LoginJob, SavedAccount } from '@shared/schema'

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
  const [, cli, sub, id] = seg
  if (!cli) return CLIS.filter((c) => c.auth).map((c) => list(c.id))
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
  const s = demo(cli)
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
    }, 2200)
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
