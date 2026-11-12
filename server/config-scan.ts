import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { Hono } from 'hono'
import {
  SCAN_EXT,
  SCAN_TEXT_MAX,
  ignoreKey,
  scanFiles,
  sortFindings,
  withoutIgnored,
  type ConfigFinding,
} from '../shared/config-scan/index.ts'
import { t } from '../shared/i18n.ts'
import { DATA_DIR, writeJsonAtomic } from './store.ts'

/**
 * 配置安全扫描的服务端部分（规则在 shared/config-scan/）：读目录里的文本文件、按内容缓存结果、记用户点过「这条没问题」的。
 * 忽略记录在数据目录 config/config-scan-ignore.json（不进项目仓库：每个人自己判断，不共享）。
 * 范围（scope）区分同名文件：skill:<目录>、plugin:<插件 id>、mcp:<项目 id>、hook:<钩子 id>、doc:<项目 id>
 */

const IGNORE_FILE = () => path.join(DATA_DIR, 'config', 'config-scan-ignore.json')
/** 最多记多少条忽略：再多说明规则本身该改了，最旧的挤掉 */
const IGNORE_MAX = 2000
/** 一个目录最多扫多少个文件、多深：Skill 一般十几个文件；node_modules 这类不进 */
const DIR_FILES_MAX = 300
const DIR_DEPTH_MAX = 6
const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', '__pycache__', 'dist', 'build'])

let ignored: Set<string> | undefined

async function readIgnored(): Promise<Set<string>> {
  if (ignored) return ignored
  const text = await readFile(IGNORE_FILE(), 'utf8').catch(() => '')
  try {
    const keys = (JSON.parse(text || '{}') as { keys?: unknown }).keys
    ignored = new Set(Array.isArray(keys) ? keys.filter((k): k is string => typeof k === 'string') : [])
  } catch {
    ignored = new Set()
  }
  return ignored
}

export async function ignoreFinding(key: string) {
  const set = await readIgnored()
  set.add(key)
  const keys = [...set].slice(-IGNORE_MAX)
  ignored = new Set(keys)
  await writeJsonAtomic(IGNORE_FILE(), { keys })
}

/** 去掉用户点过「这条没问题」的，按级别排好 */
export async function visibleFindings(list: ConfigFinding[], scope: string) {
  return sortFindings(withoutIgnored(list, await readIgnored(), scope))
}

/** 按「路径 + 修改时间 + 大小」缓存每个文件的结果：列表页每次打开都扫，没变的不重读 */
const cache = new Map<string, { sig: string; found: ConfigFinding[] }>()
const CACHE_MAX = 5000

async function scanOne(abs: string, rel: string): Promise<ConfigFinding[]> {
  const st = await stat(abs).catch(() => null)
  if (!st?.isFile()) return []
  const sig = `${st.mtimeMs}:${st.size}:${rel}`
  const hit = cache.get(abs)
  if (hit?.sig === sig) return hit.found
  const buf = await readFile(abs).catch(() => null)
  // 二进制不扫（前 8000 字节有 0 字节）
  const found =
    !buf || buf.subarray(0, 8000).includes(0)
      ? []
      : scanFiles([{ path: rel, text: buf.subarray(0, SCAN_TEXT_MAX).toString('utf8') }])
  if (cache.size > CACHE_MAX) cache.clear()
  cache.set(abs, { sig, found })
  return found
}

/** 列出目录里要扫的文本文件（相对路径） */
async function textFiles(root: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string, depth: number) => {
    if (depth > DIR_DEPTH_MAX || out.length >= DIR_FILES_MAX) return
    const items = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const it of items) {
      if (out.length >= DIR_FILES_MAX) return
      const abs = path.join(dir, it.name)
      if (it.isDirectory() && !SKIP_DIRS.has(it.name)) await walk(abs, depth + 1)
      else if (it.isFile() && SCAN_EXT.test(it.name)) out.push(path.relative(root, abs).replace(/\\/g, '/'))
    }
  }
  await walk(root, 0)
  return out
}

/** 扫一个目录（Skill、本机插件目录）；一个文件时只扫它（命令是单个 md） */
export async function scanPath(target: string, scope: string): Promise<ConfigFinding[]> {
  const st = await stat(target).catch(() => null)
  if (!st) return []
  const found = st.isFile()
    ? await scanOne(target, path.basename(target))
    : (await Promise.all((await textFiles(target)).map((rel) => scanOne(path.join(target, rel), rel)))).flat()
  return visibleFindings(found, scope)
}

/** 扫内存里的文件（插件压缩包解开后的内容）：rel 是相对包根的路径 */
export function scanBuffers(files: { rel: string; data: Buffer }[]): ConfigFinding[] {
  return sortFindings(
    scanFiles(
      files
        .filter((f) => SCAN_EXT.test(f.rel) && !f.data.subarray(0, 8000).includes(0))
        .map((f) => ({ path: f.rel, text: f.data.subarray(0, SCAN_TEXT_MAX).toString('utf8') })),
    ),
  )
}

/** /api/config-scan：目前只有「这条没问题」 */
export function configScanApi() {
  return new Hono().post('/ignore', async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Partial<ConfigFinding> & { scope?: unknown }
    if (typeof b.rule !== 'string' || typeof b.file !== 'string' || typeof b.snippet !== 'string')
      return c.json({ error: t('参数不对') }, 400)
    await ignoreFinding(ignoreKey({ rule: b.rule, file: b.file, snippet: b.snippet }, String(b.scope ?? '')))
    return c.json({ ok: true })
  })
}

/** 测试用：换数据目录后清掉缓存 */
export const resetConfigScanCache = () => {
  ignored = undefined
  cache.clear()
}
