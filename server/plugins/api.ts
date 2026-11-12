import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { pluginConfig, pluginOn } from '../../shared/plugins/index.ts'
import type { PluginInfo, PluginManifest, PluginSource } from '../../shared/plugins/types.ts'
import { getSettings } from '../settings.ts'
import { DEFAULT_MARKET, downloadEntry, downloadSource, parseRepo, readMarket } from './github.ts'
import {
  afterInstall,
  brokenList,
  findInstalled,
  installedList,
  keptPreview,
  rollbackPlugin,
  uninstallPlugin,
  updatePlugin,
} from './manager.ts'
import { pluginMcpApi } from './mcp.ts'
import { pluginError, pluginStatus, runningPlugin } from './runtime.ts'
import { linkPackage, packageRoot, parseManifest, writePackage, type Installed } from './store.ts'
import { checkPluginUpdates } from './updates.ts'
import { readZip, type ZipEntry } from './zip.ts'
import { scanBuffers, scanPath, visibleFindings } from '../config-scan.ts'

/**
 * 插件接口（ADR 0059），挂在 /api/plugins 下：列表、市场、安装（先预览再确认）、开关和参数、删除，
 * 插件网页部分的静态文件（/<id>/web/…）和插件自己的接口（/<id>/api/…）。
 */

/** 等用户确认的安装：预览时下载好、校验过，确认后直接写盘；十分钟没确认就丢掉 */
interface Pending {
  manifest: PluginManifest
  source: PluginSource
  files?: ZipEntry[]
  root?: string
  /** 链接本机目录 */
  dir?: string
  at: number
}
const pending = new Map<string, Pending>()
const PENDING_MS = 10 * 60_000

/**
 * 记下等确认的安装，返回给弹窗的预览。顺便做配置安全扫描（借鉴 ECC 的 AgentShield）：包里的技能、钩子脚本、
 * 服务端代码有没有提示注入、外传、危险命令、密钥；弹窗里列出来，有高级的要用户勾选「我看过了」才能装
 */
async function stash(p: Omit<Pending, 'at'>) {
  for (const [k, v] of pending) if (Date.now() - v.at > PENDING_MS) pending.delete(k)
  const token = randomUUID()
  pending.set(token, { ...p, at: Date.now() })
  const cur = findInstalled(p.manifest.id)
  const scope = `plugin:${p.manifest.id}`
  const scan = p.dir
    ? await scanPath(p.dir, scope)
    : await visibleFindings(
        scanBuffers(
          (p.files ?? [])
            .filter((f) => f.name.startsWith(p.root ?? '') && !f.name.endsWith('/'))
            .map((f) => ({ rel: f.name.slice((p.root ?? '').length), data: f.data })),
        ),
        scope,
      )
  return {
    token,
    manifest: p.manifest,
    hasCode: !!(p.manifest.server || p.manifest.web || p.manifest.hooks.some((h) => h.script)),
    installed: cur ? { version: cur.manifest.version, source: cur.source } : null,
    scan,
    scanScope: scope,
  }
}

function fromZip(zip: Buffer, source: PluginSource, sub = '') {
  const files = readZip(zip)
  const root = packageRoot(files, sub)
  const raw = files.find((f) => f.name === `${root}plugin.json`)!
  const manifest = parseManifest(JSON.parse(raw.data.toString('utf8')))
  return stash({ manifest, source, files, root })
}

const info = (p: Installed): PluginInfo => {
  const v = encodeURIComponent(p.installedAt || p.manifest.version)
  const url = (f?: string) =>
    f ? `/api/plugins/${p.manifest.id}/files/${f.split('/').map(encodeURIComponent).join('/')}?v=${v}` : ''
  return {
    manifest: p.manifest,
    skills: p.skills,
    source: p.source,
    installedAt: p.installedAt,
    webUrl: url(p.manifest.web),
    cssUrl: url(p.manifest.css),
    error: pluginError(p.manifest.id),
    hasCode: !!(p.manifest.server || p.manifest.web || p.manifest.hooks.some((h) => h.script)),
    rollback: p.rollback,
  }
}

const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.zip': 'application/zip',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

const fail = (e: unknown) => ({ error: (e as Error).message })

export function pluginsApi() {
  return (
    new Hono()
      .route('/mcp', pluginMcpApi())
      .get('/', async (c) => {
        const s = await getSettings()
        return c.json({
          plugins: installedList().map((p) => ({
            ...info(p),
            enabled: pluginOn(s.plugins, p.manifest.id),
            config: pluginConfig(s.plugins, p.manifest.id),
          })),
          broken: brokenList(),
          market: DEFAULT_MARKET,
        })
      })
      // 插件市场：仓库的 plugins.json；没有的仓库当作单个插件
      .get('/market', async (c) => {
        try {
          const { repo, ref } = parseRepo(c.req.query('repo') || DEFAULT_MARKET)
          const list = await readMarket(repo, c.req.query('ref') || ref)
          return c.json({ repo, plugins: list ?? null })
        } catch (e) {
          return c.json(fail(e), 400)
        }
      })
      // 检查更新：从 GitHub 装的插件和上游比版本，只读不装；升级还是走 /install/github 的预览和确认
      .get('/updates', async (c) => c.json(await checkPluginUpdates(installedList())))
      .post('/install/github', async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as {
          repo?: string
          ref?: string
          path?: string
          id?: string
        }
        try {
          const parsed = parseRepo(body.repo || DEFAULT_MARKET)
          const ref = body.ref || parsed.ref || 'HEAD'
          const sub = body.path ?? parsed.path ?? ''
          if (body.id) {
            const entry = (await readMarket(parsed.repo, ref))?.find((x) => x.id === body.id)
            if (!entry) return c.json({ error: `插件目录里没有 ${body.id}` }, 404)
            const got = await downloadEntry(parsed.repo, entry, ref)
            return c.json(
              await fromZip(
                got.zip,
                { kind: 'github', ref: parsed.repo, tag: entry.tag ?? ref, path: got.path },
                got.path,
              ),
            )
          }
          const zip = await downloadSource(parsed.repo, ref)
          return c.json(await fromZip(zip, { kind: 'github', ref: parsed.repo, tag: ref, path: sub }, sub))
        } catch (e) {
          return c.json(fail(e), 400)
        }
      })
      // 上传的 zip：请求体就是文件内容，文件名放在 name 参数里
      .post('/install/zip', async (c) => {
        try {
          const buf = Buffer.from(await c.req.arrayBuffer())
          if (!buf.length) return c.json({ error: '没有收到文件' }, 400)
          return c.json(await fromZip(buf, { kind: 'zip', ref: c.req.query('name') || 'plugin.zip' }))
        } catch (e) {
          return c.json(fail(e), 400)
        }
      })
      // 链接本机目录（开发插件用）：目录里要有构建好的插件包
      .post('/install/dir', async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as { dir?: string }
        const dir = path.resolve(String(body.dir ?? ''))
        try {
          if (!body.dir || !existsSync(path.join(dir, 'plugin.json')))
            return c.json({ error: '这个目录里没有 plugin.json' }, 400)
          const manifest = parseManifest(JSON.parse(await readFile(path.join(dir, 'plugin.json'), 'utf8')))
          return c.json(await stash({ manifest, source: { kind: 'dir', ref: dir }, dir }))
        } catch (e) {
          return c.json(fail(e), 400)
        }
      })
      .post('/install/confirm', async (c) => {
        const { token } = (await c.req.json().catch(() => ({}))) as { token?: string }
        const p = token ? pending.get(token) : undefined
        if (!p) return c.json({ error: '安装请求过期了，请重新选择插件' }, 404)
        pending.delete(token!)
        try {
          if (p.dir) await linkPackage(p.manifest.id, p.dir)
          else await writePackage(p.manifest.id, p.files!, p.root!, p.source)
          await afterInstall(p.manifest.id)
          const cur = findInstalled(p.manifest.id)
          return c.json({ ok: true, plugin: cur ? info(cur) : null })
        } catch (e) {
          return c.json(fail(e), 500)
        }
      })
      .put('/:id', async (c) => {
        const id = c.req.param('id')
        if (!findInstalled(id)) return c.json({ error: '没有装这个插件' }, 404)
        const body = (await c.req.json().catch(() => ({}))) as {
          enabled?: boolean
          config?: Record<string, string | number | boolean>
        }
        const r = await updatePlugin(id, { enabled: body.enabled, config: body.config })
        return c.json({ ok: true, removed: r[id] ?? null, error: pluginError(id) })
      })
      // 退回上一版：升级后有问题时换回升级前那一版（只留一版，退回后可以再退回到刚才那版）
      .post('/:id/rollback', async (c) => {
        const id = c.req.param('id')
        if (!findInstalled(id)) return c.json({ error: '没有装这个插件' }, 404)
        try {
          await rollbackPlugin(id)
          const cur = findInstalled(id)
          return c.json({ ok: true, plugin: cur ? info(cur) : null, error: pluginError(id) })
        } catch (e) {
          return c.json(fail(e), 400)
        }
      })
      .delete('/:id', async (c) => c.json({ ok: true, ...(await uninstallPlugin(c.req.param('id'))) }))
      .get('/:id/status', async (c) => c.json((await pluginStatus(c.req.param('id'))) ?? {}))
      // 关掉 / 删除前的预览：哪些副本会删、哪些会留下
      .get('/:id/removal', async (c) => {
        const r = await keptPreview(c.req.param('id'))
        if (Array.isArray(r)) return c.json({ workflows: [], agents: [], kept: [] })
        return c.json({
          workflows: r.workflows.map((w) => w.name),
          agents: r.agents.map((a) => a.name),
          kept: r.kept,
        })
      })
      // 插件包里的静态文件（网页入口、样式、图片）：只给包目录里的
      .get('/:id/files/*', async (c) => {
        const p = findInstalled(c.req.param('id'))
        if (!p) return c.notFound()
        const rel = decodeURIComponent(c.req.path.split('/files/').slice(1).join('/files/'))
        const full = path.resolve(p.dir, rel)
        if (!full.startsWith(path.resolve(p.dir) + path.sep)) return c.notFound()
        const st = await stat(full).catch(() => null)
        if (!st?.isFile()) return c.notFound()
        return c.body(await readFile(full), 200, {
          'Content-Type': TYPES[path.extname(full).toLowerCase()] ?? 'application/octet-stream',
          'Cache-Control': 'no-cache',
        })
      })
      // 插件自己的接口：去掉 /api/plugins/<id>/api 前缀交给插件
      .all('/:id/api/*', async (c) => {
        const id = c.req.param('id')
        const plugin = runningPlugin(id)
        if (!plugin?.fetch) return c.json({ error: '插件没有打开或没有接口' }, 404)
        const url = new URL(c.req.url)
        const prefix = `/api/plugins/${id}/api`
        url.pathname = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) || '/' : url.pathname
        return plugin.fetch(new Request(url, c.req.raw))
      })
  )
}
