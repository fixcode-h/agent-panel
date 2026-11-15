import { INTEGRATIONS, getIntegration, type IntegrationLoginJob, type IntegrationView } from '@shared/integrations'

/**
 * 在线演示里的授权：不碰本机的 gh、cloudflared，模拟一次浏览器授权过程。
 * 页面上的流程和真实环境一样（检测、授权中、授权码、完成、退出）。
 */
const authed = new Set<string>()
const jobs = new Map<string, IntegrationLoginJob>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()

const VERSION: Record<string, string> = {
  github: 'gh version 2.97.0（演示）',
  cloudflared: 'cloudflared version 2026.1.0（演示）',
  vercel: 'Vercel CLI 65.2.0（演示）',
}

/** 演示里授权后显示的账号：和真实后端的 account 一样，认不出时留空 */
const ACCOUNT: Record<string, string> = {
  github: 'demo-user',
  vercel: 'demo-vercel',
}

const view = (id: string): IntegrationView => {
  const def = getIntegration(id) ?? INTEGRATIONS[0]
  const on = authed.has(def.id)
  return {
    id: def.id,
    name: def.name,
    description: def.description,
    command: def.command,
    docsUrl: def.docsUrl ?? '',
    installHint: Object.values(def.install)[0] ?? '',
    canInstall: !!def.setup,
    installed: true,
    version: VERSION[def.id] ?? '演示',
    authed: on,
    account: on ? (ACCOUNT[def.id] ?? '') : '',
    browserAuth: def.auth.login.length > 0,
    tokenAuth: !!def.auth.token,
    canLogout: !!def.auth.logout?.length || !!def.auth.logoutFile,
    hint: on ? '' : (def.auth.hint ?? ''),
    detail: on ? '' : '演示：还没有授权',
  }
}

const loginView = (id: string) => jobs.get(id) ?? null

function start(id: string): IntegrationLoginJob {
  const running = jobs.get(id)
  if (running?.status === 'running') return { ...running }
  clearTimeout(timers.get(id))
  const def = getIntegration(id) ?? INTEGRATIONS[0]
  // cloudflared 没有一次性授权码：浏览器里选完域名就写完证书
  const cloudflare = def.id === 'cloudflared'
  // vercel 的 device code flow：打印一条带 user_code 的授权链接，在链接里输码
  const vercel = def.id === 'vercel'
  const job: IntegrationLoginJob = {
    id: `demo-${crypto.randomUUID()}`,
    integration: def.id,
    status: 'running',
    url: cloudflare
      ? 'https://dash.cloudflare.com/argotunnel'
      : vercel
        ? 'https://vercel.com/oauth/device?user_code=ABCD-1234'
        : 'https://github.com/login/device',
    code: cloudflare ? '' : 'ABCD-1234',
    output: cloudflare
      ? 'A browser window should have opened at the following URL. If it failed to open, visit it manually.'
      : vercel
        ? 'Visit https://vercel.com/oauth/device?user_code=ABCD-1234'
        : '! First copy your one-time code: ABCD-1234\nPress Enter to open github.com in your browser…',
    startedAt: Date.now(),
  }
  jobs.set(id, job)
  // 不跟着 demoMs 缩短：界面检查要截「授权中」这一刻（显示授权码）
  timers.set(
    id,
    setTimeout(() => {
      if (jobs.get(id) !== job || job.status !== 'running') return
      job.status = 'done'
      authed.add(def.id)
    }, 2500),
  )
  return { ...job }
}

export function demoIntegrations(method: string, seg: string[], body: any): unknown {
  const id = seg[1] ?? 'github'
  const [action, sub] = seg.slice(2)
  if (action === 'login') {
    if (sub === 'token' && method === 'POST') {
      if (!String(body?.token ?? '').trim()) throw new Error('Token 不对')
      authed.add(id)
      jobs.delete(id)
      return view(id)
    }
    if (method === 'DELETE') {
      const job = jobs.get(id)
      if (job?.status === 'running') {
        clearTimeout(timers.get(id))
        jobs.set(id, { ...job, status: 'failed', error: '已取消' })
      }
      return { ok: true }
    }
    if (method === 'POST') return start(id)
    return loginView(id)
  }
  // 演示里都当已安装，不会走到一键安装
  if (action === 'install') return null
  if (action === 'logout' && method === 'POST') {
    authed.delete(id)
    jobs.delete(id)
    return view(id)
  }
  return INTEGRATIONS.map((def) => view(def.id))
}
