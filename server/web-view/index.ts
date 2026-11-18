/**
 * 网页页签的接口（契约 shared/api-contract/web-view.ts，ADR 0068）：
 * 本机文件换沙箱地址、外部网址预检能不能嵌、阅读模式取正文。
 */
import { open, stat } from 'node:fs/promises'
import path from 'node:path'
import { Hono } from 'hono'
import { webViewContract as W, type WebFileRes } from '../../shared/api-contract/web-view.ts'
import { embedVerdict, webUrlOf } from '../../shared/web-view/embed.ts'
import { htmlToMarkdown, pageTitle } from '../../shared/web-view/reader.ts'
import { t } from '../../shared/i18n.ts'
import { netError, netFetch } from '../net.ts'
import { PLUGINS_DIR } from '../plugins/store.ts'
import { TASK_FILES_DIR } from '../store.ts'
import { grantRoot, inside, sandboxUrl } from './sandbox.ts'

export interface WebViewDeps {
  /** 对话的工作目录（独立分支时是 worktree）；对话不存在、是导入的会抛错 */
  workDir: (taskId: string) => Promise<string>
  /** 项目目录；没有这个项目或没选目录时给空 */
  projectDir: (projectId: string) => Promise<string>
  /** 项目的文档根（可能在项目外，例如 P4 项目旁边的 ProjectDoc/docs）；算不出来给空 */
  docRoot?: (projectId: string) => Promise<string>
  /** 这个对话的 Agent 在项目外写出过的文件（绝对路径，task.outsideChanges） */
  outsideFiles?: (taskId: string) => Promise<string[]>
  /** 插件的安装目录（链接本机目录装的是那个真实目录）；没装或没加载成功时给空 */
  pluginDir: (pluginId: string) => string
  /** 插件托管进程：没起就起，回 http://127.0.0.1:<端口>；起不来抛原因（server/plugins/services.ts） */
  serviceOrigin: (pluginId: string, serviceId: string) => Promise<string>
  /** 记一次「有人在看」，托管进程的空闲计时从头算 */
  touchService: (pluginId: string, serviceId: string) => void
}

/** 预检结果按网址缓存这么久：同一个网页来回切页签不用每次都去问对方 */
const PROBE_TTL = 10 * 60_000
const PROBE_MAX = 200
const NET_TIMEOUT = 8_000
/** 阅读模式最多读这么多 HTML */
const READER_MAX = 5 * 1024 * 1024
/** 有的站点不给默认的 undici 请求头回正文：带一个普通的浏览器标识（不带用户信息） */
const UA = 'Mozilla/5.0 (compatible; AgentPanelReader/1.0)'

// 模块状态：缓存，丢了没事（重新预检一次）
const probes = new Map<string, { at: number; res: { embeddable: boolean; reason?: string; finalUrl: string } }>()

/** 这个文件能在哪个根目录下发：对话工作目录、对话目录（附件、截图）、项目目录、文档根、插件目录，取最深的那个 */
async function rootsFor(deps: WebViewDeps, taskId?: string, projectId?: string) {
  const roots: string[] = []
  if (taskId) {
    const dir = await deps.workDir(taskId).catch(() => '')
    if (dir) roots.push(dir)
    roots.push(path.join(TASK_FILES_DIR, taskId))
  }
  if (projectId) {
    const dir = await deps.projectDir(projectId).catch(() => '')
    if (dir) roots.push(dir)
    // 文档根常在项目外（P4 / SVN 项目默认放在项目旁边的 ProjectDoc/docs），Agent 写的模块文档、架构图都在这里
    const docs = (await deps.docRoot?.(projectId).catch(() => '')) ?? ''
    if (docs) roots.push(docs)
  }
  roots.push(PLUGINS_DIR)
  return roots.map((r) => path.resolve(r))
}

type FileInput = {
  path: string
  taskId?: string
  projectId?: string
  plugin?: string
  service?: string
  force?: boolean
}

/** Windows 的路径不分大小写：比较前统一一下 */
const samePath = (a: string, b: string) =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b

/** 这个对话的 Agent 在项目外写出过这个文件：按它所在的目录发（同目录的样式、脚本跟着能取到） */
async function writtenByTask(deps: WebViewDeps, full: string, taskId?: string) {
  if (!taskId || !deps.outsideFiles) return ''
  const files = await deps.outsideFiles(taskId).catch(() => [] as string[])
  return files.some((f) => samePath(path.resolve(f), full)) ? path.dirname(full) : ''
}

/**
 * 插件声明的页面（插件接口 11 的 webPages）：
 * - 托管进程直接给它自己的本机地址：它和面板端口不同、是另一个源，碰不到面板的页面；
 *   网页应用常用 /assets/… 这种绝对路径，挂在沙箱源的前缀下会全部找不到，所以不经沙箱源转发。
 *   代价是外网访问面板时打不开（地址是 127.0.0.1），被拒原因照实显示。
 * - 插件包里的文件：按插件目录发沙箱令牌，和本机文件一样
 */
async function pluginFile(deps: WebViewDeps, input: FileInput & { plugin: string }) {
  const rel = input.path.replace(/^[/\\]+/, '')
  if (input.service) {
    const origin = await deps.serviceOrigin(input.plugin, input.service)
    deps.touchService(input.plugin, input.service)
    return { url: `${origin}/${rel}`, title: `${input.plugin} · ${input.service}`, size: 0 }
  }
  const dir = deps.pluginDir(input.plugin)
  if (!dir) throw new Error(t('插件 {id} 没有装好，打不开它的页面', { id: input.plugin }))
  const full = path.resolve(dir, rel)
  if (!inside(path.resolve(dir), full)) throw new Error(t('只能打开插件目录里的文件'))
  const info = await stat(full).catch(() => null)
  if (!info?.isFile()) throw new Error(t('文件不存在：{path}', { path: input.path }))
  const relPath = path.relative(dir, full).split(path.sep).join('/')
  return { url: sandboxUrl(grantRoot(path.resolve(dir)), relPath), title: path.basename(full), size: info.size }
}

export async function webFile(deps: WebViewDeps, input: FileInput): Promise<WebFileRes> {
  if (input.plugin) return pluginFile(deps, { ...input, plugin: input.plugin })
  if (!input.path) throw new Error(t('打开网页的参数不对'))
  const roots = await rootsFor(deps, input.taskId, input.projectId)
  // 相对路径按对话工作目录（没有对话时按项目目录）解析：回复里常写 docs/demo.html 这样的相对路径
  const full = path.isAbsolute(input.path) ? path.resolve(input.path) : path.resolve(roots[0], input.path)
  const info = await stat(full).catch(() => null)
  if (!info?.isFile()) throw new Error(t('文件不存在：{path}', { path: input.path }))
  let root =
    roots.filter((r) => inside(r, full)).sort((a, b) => b.length - a.length)[0] ||
    (await writtenByTask(deps, full, input.taskId))
  if (!root) {
    // 别的目录不直接拒：页面照样关在沙箱里碰不到面板，但令牌能读到同一目录里的其他文件，所以先让用户点一次「仍要打开」
    if (!input.force)
      return {
        url: '',
        title: path.basename(full),
        size: info.size,
        confirm: t('这个文件不在对话目录、项目目录、文档目录和插件目录里（{dir}）。', { dir: path.dirname(full) }),
      }
    root = path.dirname(full)
  }
  const rel = path.relative(root, full).split(path.sep).join('/')
  const title = (await headTitle(full).catch(() => '')) || path.basename(full)
  return { url: sandboxUrl(grantRoot(root), rel), title, size: info.size }
}

/** 网页的 <title>：只读文件开头一段（HTML 卡片、页签标题用），不整份加载 */
async function headTitle(full: string) {
  if (!/\.(html?|svg)$/i.test(full)) return ''
  const fh = await open(full, 'r')
  try {
    const buf = Buffer.alloc(16 * 1024)
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    return pageTitle(buf.subarray(0, bytesRead).toString('utf8'))
  } finally {
    await fh.close()
  }
}

export async function probeUrl(raw: string, now = Date.now()) {
  const u = webUrlOf(raw)
  if (!u) throw new Error(t('只能打开 http 或 https 的网址'))
  const hit = probes.get(u.href)
  if (hit && now - hit.at < PROBE_TTL) return hit.res
  let res: { embeddable: boolean; reason?: string; finalUrl: string }
  try {
    const r = await netFetch(u.href, { redirect: 'follow', timeoutMs: NET_TIMEOUT, headers: { 'User-Agent': UA } })
    // 只看头，不读正文
    void r.body?.cancel().catch(() => {})
    res = { ...embedVerdict(r.headers), finalUrl: r.url || u.href }
  } catch {
    // 面板这边连不上（内网、要登录的代理）时不替浏览器下结论：让 iframe 自己去试，打不开浏览器会显示原因
    res = { embeddable: true, finalUrl: u.href }
  }
  if (probes.size >= PROBE_MAX) probes.delete(probes.keys().next().value!)
  probes.set(u.href, { at: now, res })
  return res
}

export async function readerOf(raw: string) {
  const u = webUrlOf(raw)
  if (!u) throw new Error(t('只能打开 http 或 https 的网址'))
  let r: Response
  try {
    r = await netFetch(u.href, { redirect: 'follow', timeoutMs: NET_TIMEOUT * 2, headers: { 'User-Agent': UA } })
  } catch (e) {
    throw new Error(t('取不到这个网页：{why}', { why: netError(e) }), { cause: e })
  }
  if (!r.ok) throw new Error(t('取不到这个网页：对方返回 {code}', { code: r.status }))
  const type = r.headers.get('content-type') ?? ''
  if (type && !/html|xml|text\/plain/i.test(type)) {
    void r.body?.cancel().catch(() => {})
    throw new Error(t('这个地址不是网页（{type}），阅读模式只能读网页', { type: type.split(';')[0] }))
  }
  const buf = Buffer.from(await r.arrayBuffer()).subarray(0, READER_MAX)
  const html = buf.toString('utf8')
  const final = r.url || u.href
  const markdown = /text\/plain/i.test(type) ? html : htmlToMarkdown(html, final)
  return { title: pageTitle(html) || new URL(final).hostname, site: new URL(final).hostname, markdown }
}

export function webViewApi(deps: WebViewDeps) {
  const fail = (e: unknown) => ({ error: (e as Error).message })
  return new Hono()
    .post('/file', async (c) => {
      const body = W.file.body.safeParse(await c.req.json().catch(() => null))
      if (!body.success) return c.json({ error: t('打开网页的参数不对') }, 400)
      return webFile(deps, body.data).then(
        (r) => c.json(r),
        (e) => c.json(fail(e), 400),
      )
    })
    .post('/probe', async (c) => {
      const body = W.probe.body.safeParse(await c.req.json().catch(() => null))
      if (!body.success) return c.json({ error: t('打开网页的参数不对') }, 400)
      return probeUrl(body.data.url).then(
        (r) => c.json(r),
        (e) => c.json(fail(e), 400),
      )
    })
    .post('/reader', async (c) => {
      const body = W.reader.body.safeParse(await c.req.json().catch(() => null))
      if (!body.success) return c.json({ error: t('打开网页的参数不对') }, 400)
      return readerOf(body.data.url).then(
        (r) => c.json(r),
        (e) => c.json(fail(e), 400),
      )
    })
}
