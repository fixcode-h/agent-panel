import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Hono } from 'hono'
import { z } from 'zod'
import { DATA_KINDS, DataUsage, MemoryUsage, canExport, type DataKind } from '../shared/data.ts'
import { Settings } from '../shared/schema.ts'
import { migrateRemovedClis } from '../shared/settings.ts'
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
  // 对话记录（tasks/）和工作目录（chats/<对话 id>）分开算：工作目录里是 Agent 下载的网页快照、
  // 装好的依赖，几百 MB，不能算进任务记录也不能跟着备份导出
  tasks: ['tasks'],
  workspace: ['chats'],
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

/**
 * 读出要导出的文件（base64）。导出不等任务停下：列出文件和读文件之间，任务可能正好在写
 * （writeJsonAtomic 的 .tmp 改名掉）或被删。半截的 .tmp 本来就不该进备份；读的时候已经没了的跳过、
 * 列进 skipped，不让整个导出 500，也不静默丢。read 可替换，测试用它稳定复现「读的时候没了」
 */
export async function readBackupFiles(rels: string[], read: (full: string) => Promise<Buffer> = readFile) {
  const files: Record<string, string> = {}
  const skipped: string[] = []
  for (const rel of rels) {
    if (rel.endsWith('.tmp')) continue
    try {
      files[toPosix(rel)] = (await read(path.join(DATA_DIR, rel))).toString('base64')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      skipped.push(toPosix(rel))
    }
  }
  return { files, skipped }
}

/**
 * 导出时去掉密钥：隧道 token、API 的 key、搜索源的 key、CLI 的环境变量值。
 * 备份文件常被拿去分享或换机器，密钥跟着出去就等于泄露；导入时由 withLocalSecrets 沿用本机的值。
 * 解析不了时整份不导出设置（返回 null），不能因为解析失败就把原文连密钥一起带出去
 */
export function withoutSecrets(b64: string): string | null {
  try {
    const raw = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'))
    // 旧设置里的 Gemini 协议先清掉，否则解析失败
    migrateRemovedClis(raw)
    const s = Settings.parse(raw)
    s.remoteAccess.tunnelToken = ''
    for (const a of s.apis) a.apiKey = ''
    s.webSearch.key = ''
    for (const cli of Object.values(s.clis)) for (const e of cli.env) e.value = ''
    return Buffer.from(JSON.stringify(s)).toString('base64')
  } catch {
    return null
  }
}

/** 导入备份时，备份里被清空的密钥沿用本机现有的值（按 API id、CLI id + 变量名对上） */
export function withLocalSecrets(backup: Settings, current: Settings): Settings {
  if (!backup.remoteAccess.tunnelToken) backup.remoteAccess.tunnelToken = current.remoteAccess.tunnelToken
  for (const a of backup.apis) {
    if (a.apiKey) continue
    a.apiKey = current.apis.find((x) => x.id === a.id)?.apiKey ?? '' // secret-check-ok：从本机设置取值，不是写死的密钥
  }
  if (!backup.webSearch.key && backup.webSearch.provider === current.webSearch.provider)
    backup.webSearch.key = current.webSearch.key
  for (const [id, cli] of Object.entries(backup.clis))
    for (const e of cli.env) {
      if (e.value) continue
      e.value = current.clis[id]?.env.find((x) => x.key === e.key)?.value ?? ''
    }
  return backup
}

/** 导出的备份文件：一个 JSON，里面是各个文件的 base64 内容 */
const Backup = z.object({
  app: z.literal('agent-panel'),
  version: z.literal(1),
  exportedAt: z.string(),
  kinds: z.array(z.enum(DATA_KINDS.map((k) => k.id) as [DataKind, ...DataKind[]])),
  files: z.record(z.string(), z.string()),
  /** 导出时读到一半就没了的文件（任务正在写或刚删）：没放进 files，导出后提示一下 */
  skipped: z.array(z.string()).optional(),
})

/** 备份里的路径只能落在对应类别的目录里，不能用 .. 写到数据目录外面 */
function allowed(rel: string, kinds: DataKind[]) {
  // 反斜杠和冒号一律拒：posix 规范化不认 \，Windows 落盘时 path.join 却认，`config/..\..\x` 会写出数据目录；
  // 冒号挡盘符和 NTFS 备用数据流（a.json:stream）
  if (/[\\:]/.test(rel)) return false
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
    try {
      await revealDir(DATA_DIR)
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
    return c.json({ ok: true, dir: DATA_DIR })
  })

  routes.post('/reveal-logs', async (c) => {
    await mkdir(logDir(), { recursive: true })
    try {
      await revealDir(logDir())
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
    return c.json({ ok: true, dir: logDir() })
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
    const kinds = (c.req.query('kinds') ?? '').split(',').filter(canExport)
    if (!kinds.length) return c.json({ error: t('请选择要导出的数据') }, 400)
    const { files: out, skipped } = await readBackupFiles(
      (await Promise.all(kinds.map(kindFiles))).flat().map((f) => f.rel),
    )
    if (out['settings.json']) {
      const clean = withoutSecrets(out['settings.json'])
      if (clean) out['settings.json'] = clean
      else {
        delete out['settings.json']
        skipped.push('settings.json')
      }
    }
    const backup: z.infer<typeof Backup> = {
      app: 'agent-panel',
      version: 1,
      exportedAt: new Date().toISOString(),
      kinds,
      files: out,
      ...(skipped.length && { skipped }),
    }
    return c.json(backup)
  })

  // 导入：备份里包含的每类数据整体替换成备份里的
  routes.post('/import', async (c) => {
    const p = Backup.safeParse(await c.req.json().catch(() => null))
    if (!p.success) return c.json({ error: t('不是 Agent 面板导出的数据文件') }, 400)
    if (busy()) return c.json({ error: busy() }, 409)
    // 只接受能导出的分类：工作目录、独立分支、缓存都不在备份里，伪造一份也别想把 chats/ 清掉
    const kinds = p.data.kinds.filter(canExport)
    const fs = p.data.files
    // 旧版本的「任务记录」把对话工作目录（chats/）也算在里面，旧备份里会带着这些路径：
    // 它们是执行产物，不写进数据目录，但也不能因此让整份备份导入失败
    for (const rel of Object.keys(fs)) if (rel === 'chats' || rel.startsWith('chats/')) delete fs[rel]
    const bad = Object.keys(fs).find((r) => !allowed(r, kinds))
    if (bad) return c.json({ error: t('数据文件里有不认识的路径：{path}', { path: bad }) }, 400)
    // 导出时去掉了隧道 token：导入时沿用本机现有的，免得导入后隧道连不上
    if (fs['settings.json']) {
      try {
        const raw = JSON.parse(Buffer.from(fs['settings.json'], 'base64').toString('utf8'))
        // 旧备份里可能还有已经移除的 Gemini 协议：先清掉，导入时才能正常解析
        migrateRemovedClis(raw)
        const backup = withLocalSecrets(Settings.parse(raw), await getSettings())
        fs['settings.json'] = Buffer.from(JSON.stringify(backup)).toString('base64')
      } catch {}
    }
    for (const k of kinds) for (const r of PATHS[k]) await rm(path.join(DATA_DIR, r), { recursive: true, force: true })
    const root = path.resolve(DATA_DIR)
    for (const [rel, b64] of Object.entries(fs)) {
      const full = path.resolve(root, ...rel.split('/'))
      // 第二道：不管上面的路径校验漏了什么写法，落盘位置必须在数据目录里
      if (!full.startsWith(root + path.sep))
        return c.json({ error: t('数据文件里有不认识的路径：{path}', { path: rel }) }, 400)
      await mkdir(path.dirname(full), { recursive: true })
      // 设置里有密钥：和平时一样只给本人读写（0600），导入不能把权限放宽
      await writeFile(full, Buffer.from(b64, 'base64'), rel === 'settings.json' ? { mode: 0o600 } : undefined)
    }
    resetCaches()
    return c.json({ ok: true, kinds, files: Object.keys(fs).length })
  })

  return routes
}
