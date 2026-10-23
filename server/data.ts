import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Hono } from 'hono'
import { z } from 'zod'
import { DATA_KINDS, DataUsage, MemoryUsage, type DataKind } from '../shared/data.ts'
import { Settings } from '../shared/schema.ts'
import { CACHE_DIR, DATA_DIR, resetCaches } from './store.ts'
import { getSettings } from './settings.ts'
import type { MemorySampler } from './memory.ts'
import { revealDir } from './open.ts'
import { logDir, logFile } from './log.ts'
import { t } from '../shared/i18n.ts'

/** 每类数据包含数据目录里的哪些路径（相对路径，目录或文件） */
const PATHS: Record<DataKind, string[]> = {
  config: ['settings.json', 'config'],
  projects: ['projects'],
  tasks: ['tasks', 'chats'],
  uploads: ['uploads'],
  cache: ['cache'],
}

/** 递归列出文件：相对数据目录的路径和大小 */
async function files(rel: string): Promise<{ rel: string; size: number }[]> {
  const full = path.join(DATA_DIR, rel)
  const s = await stat(full).catch(() => null)
  if (!s) return []
  if (s.isFile()) return [{ rel, size: s.size }]
  if (!s.isDirectory()) return []
  const out: { rel: string; size: number }[] = []
  for (const n of await readdir(full)) out.push(...(await files(path.join(rel, n))))
  return out
}

const kindFiles = async (k: DataKind) => (await Promise.all(PATHS[k].map(files))).flat()
const toPosix = (p: string) => p.split(path.sep).join('/')

/** 导出时去掉隧道 token：它相当于让别人接管这条隧道，不该跟着备份文件传出去 */
function withoutTunnelToken(b64: string) {
  try {
    const s = Settings.parse(JSON.parse(Buffer.from(b64, 'base64').toString('utf8')))
    if (!s.remoteAccess.tunnelToken) return b64
    s.remoteAccess.tunnelToken = ''
    return Buffer.from(JSON.stringify(s)).toString('base64')
  } catch {
    return b64
  }
}

/** 导出的备份文件：一个 JSON，里面是各个文件的 base64 内容 */
const Backup = z.object({
  app: z.literal('agent-panel'),
  version: z.literal(1),
  exportedAt: z.string(),
  kinds: z.array(z.enum(DATA_KINDS.map((k) => k.id) as [DataKind, ...DataKind[]])),
  files: z.record(z.string(), z.string()),
})

/** 备份里的路径只能落在对应类别的目录里，不能用 .. 写到数据目录外面 */
function allowed(rel: string, kinds: DataKind[]) {
  const norm = path.posix.normalize(rel)
  if (norm.startsWith('..') || path.posix.isAbsolute(norm) || norm.includes('\0')) return false
  return kinds.some((k) => PATHS[k].some((p) => norm === p || norm.startsWith(p + '/')))
}

export function dataApi(deps: { running: () => number; memory: MemorySampler }) {
  const routes = new Hono()
  const busy = () => (deps.running() ? t('有任务正在执行，等它们结束后再操作') : '')

  routes.get('/', async (c) => {
    const kinds = await Promise.all(
      DATA_KINDS.map(async (k) => {
        const fs = await kindFiles(k.id)
        return { id: k.id, files: fs.length, bytes: fs.reduce((n, f) => n + f.size, 0) }
      }),
    )
    const memory = await deps.memory.snapshot()
    const logs = await readdir(logDir()).catch(() => [] as string[])
    const sizes = await Promise.all(
      logs.map((f) =>
        stat(path.join(logDir(), f)).then(
          (s) => s.size,
          () => 0,
        ),
      ),
    )
    return c.json(
      DataUsage.parse({
        dir: DATA_DIR,
        kinds,
        logs: { dir: logDir(), current: logFile(), files: logs.length, bytes: sizes.reduce((a, b) => a + b, 0) },
        ...memory,
      }),
    )
  })

  /**
   * 只返回内存这块（最新采样 + 序列 + 规模），不遍历数据目录：
   * 页面上的内存曲线按采样间隔刷新时用它，不用把数据目录整个再 stat 一遍
   */
  routes.get('/memory', async (c) => c.json(MemoryUsage.parse(await deps.memory.snapshot())))

  routes.post('/reveal', async (c) => {
    await mkdir(DATA_DIR, { recursive: true })
    revealDir(DATA_DIR)
    return c.json({ ok: true })
  })

  routes.post('/reveal-logs', async (c) => {
    await mkdir(logDir(), { recursive: true })
    revealDir(logDir())
    return c.json({ ok: true })
  })

  routes.post('/clear', async (c) => {
    const body = z.object({ kind: z.enum(['projects', 'tasks', 'uploads', 'cache']) }).safeParse(await c.req.json())
    if (!body.success) return c.json({ error: t('这类数据不能清理') }, 400)
    if (busy()) return c.json({ error: busy() }, 409)
    const k = body.data.kind
    // 清理项目时任务记录也一起清掉，否则任务挂在不存在的项目下
    const kinds: DataKind[] = k === 'projects' ? ['projects', 'tasks'] : [k]
    for (const kind of kinds)
      for (const p of PATHS[kind]) await rm(path.join(DATA_DIR, p), { recursive: true, force: true })
    if (k === 'cache') await mkdir(CACHE_DIR, { recursive: true })
    resetCaches()
    return c.json({ ok: true })
  })

  routes.get('/export', async (c) => {
    const kinds = (c.req.query('kinds') ?? '')
      .split(',')
      .filter((k): k is DataKind => DATA_KINDS.some((x) => x.id === k && x.id !== 'cache'))
    if (!kinds.length) return c.json({ error: t('请选择要导出的数据') }, 400)
    const out: Record<string, string> = {}
    for (const k of kinds)
      for (const f of await kindFiles(k))
        out[toPosix(f.rel)] = (await readFile(path.join(DATA_DIR, f.rel))).toString('base64')
    if (out['settings.json']) out['settings.json'] = withoutTunnelToken(out['settings.json'])
    const backup: z.infer<typeof Backup> = {
      app: 'agent-panel',
      version: 1,
      exportedAt: new Date().toISOString(),
      kinds,
      files: out,
    }
    return c.json(backup)
  })

  // 导入：备份里包含的每类数据整体替换成备份里的
  routes.post('/import', async (c) => {
    const p = Backup.safeParse(await c.req.json().catch(() => null))
    if (!p.success) return c.json({ error: t('不是 Agent 面板导出的数据文件') }, 400)
    if (busy()) return c.json({ error: busy() }, 409)
    const { kinds, files: fs } = p.data
    const bad = Object.keys(fs).find((r) => !allowed(r, kinds))
    if (bad) return c.json({ error: t('数据文件里有不认识的路径：{path}', { path: bad }) }, 400)
    // 导出时去掉了隧道 token：导入时沿用本机现有的，免得导入后隧道连不上
    if (fs['settings.json']) {
      try {
        const backup = Settings.parse(JSON.parse(Buffer.from(fs['settings.json'], 'base64').toString('utf8')))
        const current = await getSettings()
        if (!backup.remoteAccess.tunnelToken && current.remoteAccess.tunnelToken) {
          backup.remoteAccess.tunnelToken = current.remoteAccess.tunnelToken
          fs['settings.json'] = Buffer.from(JSON.stringify(backup)).toString('base64')
        }
      } catch {}
    }
    for (const k of kinds) for (const r of PATHS[k]) await rm(path.join(DATA_DIR, r), { recursive: true, force: true })
    for (const [rel, b64] of Object.entries(fs)) {
      const full = path.join(DATA_DIR, ...rel.split('/'))
      await mkdir(path.dirname(full), { recursive: true })
      await writeFile(full, Buffer.from(b64, 'base64'))
    }
    resetCaches()
    return c.json({ ok: true, kinds, files: Object.keys(fs).length })
  })

  return routes
}
