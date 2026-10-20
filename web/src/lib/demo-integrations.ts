import { INTEGRATIONS, getIntegration, type IntegrationLoginJob, type IntegrationView } from '@shared/integrations'

/**
 * 在线演示里的授权：不碰本机的 gh，模拟一次浏览器授权过程。
 * 页面上的流程和真实环境一样（检测、授权中、授权码、完成、退出）。
 */
let authed = false
let job: IntegrationLoginJob | null = null
let timer: ReturnType<typeof setTimeout> | undefined

const view = (id: string): IntegrationView => {
  const def = getIntegration(id) ?? INTEGRATIONS[0]
  return {
    id: def.id,
    name: def.name,
    description: def.description,
    command: def.command,
    docsUrl: def.docsUrl ?? '',
    installHint: Object.values(def.install)[0] ?? '',
    installed: true,
    version: def.id === 'github' ? 'gh version 2.97.0（演示）' : '演示',
    authed,
    account: authed ? 'demo-user' : '',
    browserAuth: def.auth.login.length > 0,
    tokenAuth: !!def.auth.token,
    canLogout: def.auth.logout.length > 0,
    hint: authed ? '' : (def.auth.hint ?? ''),
    detail: authed ? '' : '演示：还没有授权',
  }
}

const loginView = () => (job ? { ...job } : null)

function start(): IntegrationLoginJob {
  if (job?.status === 'running') return { ...job }
  clearTimeout(timer)
  const def = getIntegration('github')!
  job = {
    id: `demo-${crypto.randomUUID()}`,
    integration: def.id,
    status: 'running',
    url: 'https://github.com/login/device',
    code: 'ABCD-1234',
    output: '! First copy your one-time code: ABCD-1234\nPress Enter to open github.com in your browser…',
    startedAt: Date.now(),
  }
  const current = job
  timer = setTimeout(() => {
    if (job !== current || job.status !== 'running') return
    job.status = 'done'
    authed = true
  }, 2500)
  return { ...job }
}

export function demoIntegrations(method: string, seg: string[], body: any): unknown {
  const id = seg[1] ?? 'github'
  const [action, sub] = seg.slice(2)
  if (action === 'login') {
    if (sub === 'token' && method === 'POST') {
      if (!String(body?.token ?? '').trim()) throw new Error('Token 不对')
      authed = true
      job = null
      return view(id)
    }
    if (method === 'DELETE') {
      if (job?.status === 'running') {
        clearTimeout(timer)
        job = { ...job, status: 'failed', error: '已取消' }
      }
      return { ok: true }
    }
    if (method === 'POST') return start()
    return loginView()
  }
  if (action === 'logout' && method === 'POST') {
    authed = false
    job = null
    return view(id)
  }
  return INTEGRATIONS.map((def) => view(def.id))
}
