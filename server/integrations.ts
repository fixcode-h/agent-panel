import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import {
  INTEGRATIONS,
  getIntegration,
  type Integration,
  type IntegrationLoginJob,
  type IntegrationView,
} from '../shared/integrations.ts'
import { t } from '../shared/i18n.ts'
import { resolveCommand } from './cli-source.ts'
import { capture, childEnv, runProcess } from './exec/process.ts'
import { log } from './log.ts'
import { DATA_DIR } from './store.ts'

/**
 * 外部 CLI 的授权：检测是否装了、是否已经登录，在面板里跑一次浏览器授权或 token 授权。
 * 登录状态由这些 CLI 自己保存（例如 gh 存在自己的配置目录里），面板不保存也不经手凭据。
 */

const platform: 'win32' | 'darwin' | 'linux' =
  process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'

/** 检测结果缓存几秒：设置页轮询时不用每次都起进程 */
const CACHE_MS = 5_000
const cache = new Map<string, { at: number; view: IntegrationView }>()
const invalidate = (id?: string) => (id ? cache.delete(id) : cache.clear())

/** 输出里出现的 token 一律打码：gh 自己会遮，但别的工具不一定 */
const SECRET = /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g
const sanitize = (s: string) => s.replace(SECRET, '***')

const baseEnv = (def: Integration) => childEnv(Object.entries(def.env ?? {}).map(([key, value]) => ({ key, value })))

const quietEnv = (def: Integration) =>
  childEnv(Object.entries({ ...def.env, ...def.quietEnv }).map(([key, value]) => ({ key, value })))

const installHint = (def: Integration) => def.install[platform] ?? Object.values(def.install)[0] ?? ''

/** 面板下载到数据目录里的可执行文件（例如 cloudflared），不在 PATH 里也认 */
const dataBin = (def: Integration) =>
  def.dataBin ? path.join(DATA_DIR, 'bin', process.platform === 'win32' ? `${def.command}.exe` : def.command) : ''

/** 实际用来跑命令的文件：PATH 里找到的优先，没有就用数据目录里下载的 */
function commandPath(def: Integration) {
  return resolveCommand(def.command) ?? (dataBin(def) && existsSync(dataBin(def)) ? dataBin(def) : undefined)
}

/** 凭据文件（相对用户目录）的完整路径 */
const credentialFile = (def: Integration) => (def.auth.file ? path.join(homedir(), def.auth.file) : '')

const lines = (s: string, max = 4) =>
  s
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(-max)

/** 只跑一次登录检测：登录中轮询时不用每次都读版本 */
async function readAuth(def: Integration) {
  // 凭据就是一个文件时没有可问的命令：文件在即已登录，也没有账号可认
  if (def.auth.file) return { authed: existsSync(credentialFile(def)), account: '', output: '' }
  const s = await capture(def.command, def.auth.status ?? [], homedir(), quietEnv(def), 15_000)
  const output = sanitize([s.stdout, s.stderr].filter(Boolean).join('\n'))
  const authed = s.code === 0
  const account = authed && def.auth.account ? (output.match(def.auth.account)?.[1] ?? '') : ''
  return { authed, account, output }
}

/** 检测一个工具：装了没有、什么版本、登录没有、登录着哪个账号 */
async function detect(def: Integration): Promise<IntegrationView> {
  const view: IntegrationView = {
    id: def.id,
    name: def.name,
    description: def.description,
    command: def.command,
    docsUrl: def.docsUrl ?? '',
    installHint: installHint(def),
    installed: false,
    version: '',
    authed: false,
    account: '',
    browserAuth: def.auth.login.length > 0,
    tokenAuth: !!def.auth.token,
    canLogout: !!def.auth.logout?.length || !!def.auth.logoutFile,
    hint: def.auth.hint ?? '',
    detail: '',
  }
  if (!commandPath(def)) return view
  const v = await capture(commandPath(def)!, def.versionArgs, homedir(), baseEnv(def), 8_000)
  view.installed = !v.spawnError
  view.version = (v.stdout || v.stderr).split('\n')[0]?.trim().slice(0, 160) ?? ''
  if (!view.installed) return view
  const auth = await readAuth(def)
  view.authed = auth.authed
  view.account = auth.account
  // 没登录、或者认不出账号（例如多个登录）时，把检测输出留给用户看
  if (!view.authed || !view.account) view.detail = lines(auth.output).join('\n')
  return view
}

function fallback(def: Integration, error: string): IntegrationView {
  return {
    id: def.id,
    name: def.name,
    description: def.description,
    command: def.command,
    docsUrl: def.docsUrl ?? '',
    installHint: installHint(def),
    installed: false,
    version: '',
    authed: false,
    account: '',
    browserAuth: def.auth.login.length > 0,
    tokenAuth: !!def.auth.token,
    canLogout: !!def.auth.logout?.length || !!def.auth.logoutFile,
    hint: def.auth.hint ?? '',
    detail: error,
  }
}

/** 所有授权工具的状态；refresh 时跳过缓存（刚授权完、刚改过配置） */
export async function listIntegrations(refresh = false): Promise<IntegrationView[]> {
  return Promise.all(
    INTEGRATIONS.map(async (def) => {
      const hit = cache.get(def.id)
      if (!refresh && hit && Date.now() - hit.at < CACHE_MS) return hit.view
      const view = await detect(def).catch((e) => fallback(def, (e as Error).message))
      cache.set(def.id, { at: Date.now(), view })
      return view
    }),
  )
}

// ---- 浏览器授权 ----

interface Login extends IntegrationLoginJob {
  abort: AbortController
  write?: (s: string) => void
  cancel: () => void
}
const logins = new Map<string, Login>()
const view = ({ abort, write, cancel, ...rest }: Login): IntegrationLoginJob => rest

const URL_RE = /https?:\/\/[^\s"'<>]+/g
/** 输出里的授权网址：本机回调地址不算 */
const findUrl = (text: string) =>
  (text.match(URL_RE) ?? []).find((u) => !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(u)) ?? ''

const LOGIN_TIMEOUT = 5 * 60_000

async function startLogin(id: string): Promise<IntegrationLoginJob> {
  const def = getIntegration(id)
  if (!def) throw new Error(t('没有这个授权工具'))
  const running = logins.get(id)
  if (running?.status === 'running') return view(running)
  const now = await detect(def).catch(() => null)
  if (!now?.installed) throw new Error(t('没有检测到 {name}，先安装再授权', { name: def.name }))

  const job: Login = {
    id: randomUUID(),
    integration: id,
    status: 'running',
    url: '',
    code: '',
    output: '',
    startedAt: Date.now(),
    abort: new AbortController(),
    cancel: () => finish(false, t('已取消')),
  }
  logins.set(id, job)

  let settled = false
  let poll: ReturnType<typeof setInterval>
  const finish = (ok: boolean, error?: string) => {
    if (settled) return
    settled = true
    clearInterval(poll)
    job.status = ok ? 'done' : 'failed'
    if (!ok) job.error = error
    job.abort.abort()
    invalidate(id)
    if (ok) log.info('integrations', '授权完成', { tool: id })
  }

  let pressed = false
  const press = () => {
    if (pressed || !job.write) return
    pressed = true
    job.write('\n')
  }
  const take = (text: string) => {
    job.output = sanitize((job.output + text + '\n').slice(-4000))
    job.url ||= findUrl(job.output)
    job.code ||= def.auth.code ? (job.output.match(def.auth.code)?.[1] ?? '') : ''
    // 有的 CLI 停在「按回车打开浏览器」上，输出在 stderr 且不一定按行，这里主动敲一下
    if (!pressed && (def.auth.ready?.test(job.output) || /Press Enter/i.test(text))) press()
  }
  // 没有 ready 规则的工具也敲一下回车：多数授权命令不读它，多写一个换行不影响
  const readyTimer = setTimeout(press, 1_500)

  poll = setInterval(async () => {
    const s = await readAuth(def).catch(() => null)
    if (s?.authed) finish(true)
    else if (Date.now() - job.startedAt > LOGIN_TIMEOUT) finish(false, t('超过 5 分钟没有完成授权，已取消'))
  }, 1_200)

  void runProcess({
    command: commandPath(def) ?? def.command,
    args: def.auth.login,
    cwd: homedir(),
    env: baseEnv(def),
    signal: job.abort.signal,
    keepStdinOpen: true,
    timeoutMs: LOGIN_TIMEOUT + 10_000,
    onSpawn: (io) => {
      job.write = io.write
    },
    onLine: take,
    onStderr: (s) => take(s.trimEnd()),
  }).then(async (r) => {
    clearTimeout(readyTimer)
    if (settled) return
    // 刚写完凭据就退出时，给读取状态留一点时间，别把成功判成失败
    if (r.code === 0) await new Promise((ok) => setTimeout(ok, 600))
    const s = await detect(def).catch(() => null)
    if (s?.authed) return finish(true)
    if (r.spawnError) return finish(false, r.spawnError)
    finish(
      false,
      r.killed === 'stopped'
        ? t('已取消')
        : [t('{name} 没有完成授权（退出码 {code}）', { name: def.name, code: String(r.code) }), ...lines(job.output, 3)]
            .filter(Boolean)
            .join('\n'),
    )
  })
  return view(job)
}

const loginOf = (id: string) => {
  const job = logins.get(id)
  return job ? view(job) : null
}

const cancelLogin = (id: string) => {
  const job = logins.get(id)
  if (job?.status === 'running') job.cancel()
  return { ok: true as const }
}

// ---- 用 token 授权 / 退出 ----

async function loginWithToken(id: string, token: string): Promise<IntegrationView> {
  const def = getIntegration(id)
  if (!def) throw new Error(t('没有这个授权工具'))
  if (!def.auth.token) throw new Error(t('{name} 不支持用 Token 授权', { name: def.name }))
  const clean = token.trim()
  if (!clean || clean.length > 500 || /\s/.test(clean)) throw new Error(t('Token 不对'))
  const bin = commandPath(def)
  if (!bin) throw new Error(t('没有检测到 {name}，先安装再授权', { name: def.name }))
  const r = await runProcess({
    command: bin,
    args: def.auth.token,
    cwd: homedir(),
    env: quietEnv(def),
    // token 只从这个进程的 stdin 进去，不进参数、不写日志
    stdin: `${clean}\n`,
    timeoutMs: 60_000,
  })
  const now = await detect(def).catch(() => null)
  if (r.code !== 0 || !now?.authed)
    throw new Error(
      [
        t('{name} 没有接受这个 Token（退出码 {code}）', { name: def.name, code: String(r.code) }),
        ...lines(sanitize(r.stderr), 3),
      ]
        .filter(Boolean)
        .join('\n'),
    )
  cache.set(id, { at: Date.now(), view: now })
  return now
}

async function logout(id: string): Promise<IntegrationView> {
  const def = getIntegration(id)
  if (!def) throw new Error(t('没有这个授权工具'))
  const now = await detect(def).catch(() => null)
  if (!now?.installed) throw new Error(t('没有检测到 {name}，先安装再授权', { name: def.name }))
  // 凭据就是一个文件时直接删掉；有的工具刷了凭据就再也退不掉
  if (def.auth.logoutFile) {
    await rm(credentialFile(def), { force: true })
  } else {
    // 有的工具在多个账号时要指定退出哪一个；没有账号信息时去掉这个参数
    const args = (def.auth.logout ?? []).flatMap((a) => (a === '{account}' ? (now.account ? [now.account] : []) : [a]))
    const r = await runProcess({
      command: commandPath(def) ?? def.command,
      args,
      cwd: homedir(),
      env: quietEnv(def),
      timeoutMs: 30_000,
    })
    if (r.code !== 0)
      throw new Error(
        [t('退出登录没有成功（退出码 {code}）', { code: String(r.code) }), ...lines(sanitize(r.stderr), 3)]
          .filter(Boolean)
          .join('\n'),
      )
  }
  const after = await detect(def).catch(() => null)
  if (after?.authed) throw new Error(t('退出登录后仍然是已登录状态'))
  if (!after) throw new Error(t('退出登录后没能读回状态'))
  cache.set(id, { at: Date.now(), view: after })
  return after
}

/** 设置里的「授权」 */
export function integrationsApi() {
  const guard = (fn: (c: any) => Promise<Response>) => async (c: any) => {
    try {
      return await fn(c)
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  }
  return new Hono()
    .get(
      '/',
      guard(async (c) => c.json(await listIntegrations(c.req.query('refresh') === '1'))),
    )
    .post(
      '/:id/login',
      guard(async (c) => c.json(await startLogin(c.req.param('id')))),
    )
    .get(
      '/:id/login',
      guard(async (c) => c.json(loginOf(c.req.param('id')))),
    )
    .post(
      '/:id/login/token',
      guard(async (c) => {
        const { token } = (await c.req.json().catch(() => ({}))) as { token?: string }
        return c.json(await loginWithToken(c.req.param('id'), String(token ?? '')))
      }),
    )
    .delete(
      '/:id/login',
      guard(async (c) => c.json(cancelLogin(c.req.param('id')))),
    )
    .post(
      '/:id/logout',
      guard(async (c) => c.json(await logout(c.req.param('id')))),
    )
}
