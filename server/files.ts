/**
 * 文件浏览：按层列出项目目录（带 git 状态）、按文件名或内容搜索、读单个文件。
 * 只接受已有项目的目录，路径不能逃出项目目录。
 *
 * 大项目不能一次扫描整棵树：列表只读当前这一层，git 状态也只看这一层有变化的文件。
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { Hono, type Context } from 'hono'
import type { Project } from '../shared/schema.ts'
import type {
  ContentFile,
  ContentSearch,
  DirEntry,
  DirLevel,
  FileContent,
  FileEntry,
  FileStatus,
  FileTree,
  NameSearch,
  SearchMode,
} from '../shared/files.ts'
import { capture } from './exec/process.ts'
import { resolvePath } from './fs.ts'
import { IMAGE_TYPES } from './uploads.ts'
import { t } from '../shared/i18n.ts'

/** 内容搜索最多扫这么多文件、这么多命中 */
const MAX_SCAN = 5_000
const MAX_HITS = 300
const MAX_LINE = 400
/** 大于这个大小的文件不搜内容，多半是数据或产物 */
const MAX_SEARCH_BYTES = 2_000_000
const MAX_CONTENT = 400_000
/** 按文件名搜索最多返回这么多条；再多的只给前一部分并说明 */
const MAX_NAME_HITS = 500
/** 不是 git 仓库时按文件名搜索最多走这么多文件，避免全盘遍历卡住 */
const MAX_NAME_SCAN = 20_000
/** git status 超过这个时间就当它拿不到状态，不用等了 */
const GIT_TIMEOUT = 5_000
/** 同一目录的 git 状态缓存这么久，连续展开子目录时不用反复等 git */
const GIT_CACHE_MS = 4_000

/** 不是 git 仓库时列目录跳过这些（和以前遍历时一致，避免点进去全是产物） */
const SKIP = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  'coverage',
  'target',
  'Binaries',
  'Intermediate',
  'DerivedDataCache',
  'Saved',
  '.venv',
  '__pycache__',
])

/** 内容搜索跳过的二进制扩展名 */
const BINARY =
  /\.(png|jpe?g|gif|webp|bmp|ico|icns|pdf|zip|gz|tgz|7z|rar|jar|war|exe|dll|so|dylib|bin|o|a|lib|class|pyc|woff2?|ttf|otf|eot|mp[34]|wav|ogg|webm|mov|avi|psd|uasset|umap|uexp|ubulk)$/i

const git = (cwd: string, ...args: string[]) =>
  capture('git', ['-c', 'core.quotepath=off', ...args], cwd, undefined, GIT_TIMEOUT)

const norm = (p: string) => p.replace(/\\/g, '/')

/** 当前分支；不是 git 仓库或分离 HEAD 时为空 */
async function branchOf(dir: string): Promise<string | null> {
  const r = await git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')
  if (r.code !== 0) return null
  const b = r.stdout.trim()
  return b && b !== 'HEAD' ? b : null
}

const isGitRepo = async (dir: string) => {
  const r = await git(dir, 'rev-parse', '--is-inside-work-tree')
  return r.code === 0 && r.stdout.trim() === 'true'
}

/**
 * 项目目录在 git 仓库里的相对前缀（项目就是仓库根时为空）。
 * 项目可能是某个仓库的子目录：git 给出的路径相对仓库根，要减掉这个前缀才能对上项目里的路径。
 */
async function gitPrefix(dir: string): Promise<string> {
  const r = await git(dir, 'rev-parse', '--show-prefix')
  return r.code === 0 ? norm(r.stdout.trim()) : ''
}

/**
 * 目录的仓库信息缓存：每展开一层都要知道是不是 git 仓库、在仓库里的前缀。
 * 不缓存的话每层都要多跑两次 git 进程；几十秒内仓库结构不会变，缓存这么久够了。
 */
const repoCache = new Map<string, { at: number; isGit: boolean; prefix: string }>()

async function repoInfo(dir: string, refresh: boolean) {
  const hit = repoCache.get(dir)
  if (hit && !refresh && Date.now() - hit.at < 30_000) return hit
  const isGit = await isGitRepo(dir)
  const info = { at: Date.now(), isGit, prefix: isGit ? await gitPrefix(dir) : '' }
  repoCache.set(dir, info)
  if (repoCache.size > 50) repoCache.delete(repoCache.keys().next().value!)
  return info
}

/**
 * 一个目录里有哪些文件有 git 状态。
 * 用 `git status --porcelain` 加 pathspec：它只列出有变化的文件，不会像 ls-files 那样枚举整个仓库。
 * 超过 GIT_TIMEOUT 或出错时返回 null，界面上这一层就不带状态，不为了状态把页面卡住。
 */
async function statusIn(
  dir: string,
  rel: string,
  prefix: string,
): Promise<Map<string, { status: FileStatus; from?: string }> | null> {
  const args = ['status', '--porcelain=v1', '-z', '--untracked-files=all']
  if (rel) args.push('--', rel)
  const r = await git(dir, ...args)
  if (r.code !== 0 || r.killed) return null
  const out = new Map<string, { status: FileStatus; from?: string }>()
  const parts = r.stdout.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (!p || p.length < 4) continue
    const x = p[0]
    const y = p[1]
    // 重命名、复制后面跟着一个原路径
    const from = x === 'R' || x === 'C' ? norm(parts[++i] ?? '') : ''
    const full = norm(p.slice(3))
    // 只留项目目录里的
    if (prefix && !full.startsWith(prefix)) continue
    const file = prefix ? full.slice(prefix.length) : full
    const code: FileStatus =
      x === '?'
        ? '?'
        : x === 'A' || y === 'A'
          ? 'A'
          : x === 'D' || y === 'D'
            ? 'D'
            : x === 'R'
              ? 'R'
              : x === 'U' || y === 'U'
                ? 'U'
                : 'M'
    const fFrom = from && (!prefix || from.startsWith(prefix)) ? (prefix ? from.slice(prefix.length) : from) : ''
    out.set(file, { status: code, ...(fFrom ? { from: fFrom } : {}) })
  }
  return out
}

/** 每个目录的 git 状态缓存：展开几个兄弟目录时只跑一次 git status */
const statusCache = new Map<string, { at: number; value: Awaited<ReturnType<typeof statusIn>> }>()

async function statusCached(dir: string, rel: string, prefix: string, refresh: boolean) {
  const key = `${dir}\0${rel}`
  const hit = statusCache.get(key)
  if (hit && !refresh && Date.now() - hit.at < GIT_CACHE_MS) return hit.value
  const value = await statusIn(dir, rel, prefix)
  // 拿到状态才缓存；拿不到下次再试
  if (value) statusCache.set(key, { at: Date.now(), value })
  if (statusCache.size > 50) statusCache.delete(statusCache.keys().next().value!)
  return value
}

/** 隐藏文件除 .github、.env 这些约定文件外都不列 */
const hidden = (name: string) => name.startsWith('.') && name !== '.github'

/** 相对路径落在这个目录里才接受 */
function into(dir: string, rel: string) {
  const full = path.resolve(dir, rel)
  const r = path.relative(dir, full)
  if (r.startsWith('..') || path.isAbsolute(r)) throw new Error(t('只能查看项目目录里的文件'))
  return full
}

/** 列一层的顺序：目录在前，同级按名字；大小写不敏感 */
const byEntry = (a: DirEntry, b: DirEntry) =>
  a.kind === b.kind
    ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    : a.kind === 'dir'
      ? -1
      : 1

/**
 * 列一个目录的直接子项。只读这一层，不往下面走。
 * 目录里的隐藏项按以前的规则跳过（.github 这类约定目录保留）。
 */
export async function listLevel(dir: string, rel: string, opts: { refresh?: boolean } = {}): Promise<DirLevel> {
  const want = norm(rel).replace(/^\/+|\/+$/g, '')
  const full = into(dir, want)
  const info = await stat(full).catch(() => null)
  if (!info?.isDirectory()) throw new Error(t('目录已经不在了'))

  const repo = await repoInfo(dir, !!opts.refresh)
  const [items, status] = await Promise.all([
    readdir(full, { withFileTypes: true }),
    repo.isGit ? statusCached(dir, want, repo.prefix, !!opts.refresh) : Promise.resolve(null),
  ])

  const entries: DirEntry[] = []
  for (const it of items) {
    if (hidden(it.name)) continue
    const r = want ? `${want}/${it.name}` : it.name
    // 符号链接按目标判断是不是目录，读不出来就当文件，点进去时再报错
    const kind: DirEntry['kind'] | null = it.isDirectory()
      ? 'dir'
      : it.isFile()
        ? 'file'
        : it.isSymbolicLink()
          ? await stat(path.join(full, it.name))
              .then((s): DirEntry['kind'] => (s.isDirectory() ? 'dir' : 'file'))
              .catch((): DirEntry['kind'] => 'file')
          : null
    if (!kind) continue
    // 非 git 仓库时产物目录不列，免得点进去全是几万个文件
    if (kind === 'dir' && !repo.isGit && SKIP.has(it.name)) continue
    const s = status?.get(r)
    entries.push({ name: it.name, path: r, kind, status: s?.status ?? '', ...(s?.from ? { from: s.from } : {}) })
  }
  entries.sort(byEntry)
  return { dir, path: want, entries, ...(repo.isGit && !status ? { statusSkipped: true } : {}) }
}

/** 一个目录根信息；任务用 worktree 目录，项目用项目目录 */
export async function listDir(dir: string): Promise<FileTree> {
  const isGit = await isGitRepo(dir)
  return { dir, branch: isGit ? await branchOf(dir) : null, isGit }
}

/** 遍历目录（不是 git 仓库时按名字搜索用），带数量上限 */
async function walk(root: string, limit: number): Promise<FileEntry[]> {
  const out: FileEntry[] = []
  const visit = async (dir: string, rel: string) => {
    if (out.length >= limit) return
    const items = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const it of items) {
      if (out.length >= limit) return
      if (hidden(it.name)) continue
      const r = rel ? `${rel}/${it.name}` : it.name
      if (it.isDirectory()) {
        if (!SKIP.has(it.name)) await visit(path.join(dir, it.name), r)
      } else if (it.isFile()) out.push({ path: r, status: '' })
    }
  }
  await visit(root, '')
  return out
}

/**
 * 按文件名搜索：git 仓库用 ls-files 一次拿到全部路径（只列名字，不读内容，也不会像遍历那样进产物目录），
 * 这样还没展开的深层文件也能搜到。名字命中的排在前面。
 */
export async function searchNameInDir(dir: string, q: string): Promise<NameSearch> {
  const needle = q.trim().toLowerCase()
  if (!needle) return { files: [], truncated: false }
  const repo = await repoInfo(dir, false)
  let all: string[]
  let truncated = false
  if (repo.isGit) {
    const r = await git(dir, 'ls-files', '--cached', '--others', '--exclude-standard', '-z')
    all = r.stdout
      .split('\0')
      .filter(Boolean)
      .map(norm)
      .filter((f) => !repo.prefix || f.startsWith(repo.prefix))
      .map((f) => (repo.prefix ? f.slice(repo.prefix.length) : f))
  } else {
    const walked = await walk(dir, MAX_NAME_SCAN)
    truncated = walked.length >= MAX_NAME_SCAN
    all = walked.map((f) => f.path)
  }
  const status = repo.isGit ? await statusCached(dir, '', repo.prefix, false) : null
  const scored: { f: FileEntry; s: number }[] = []
  for (const f of all) {
    const low = f.toLowerCase()
    const base = low.slice(low.lastIndexOf('/') + 1)
    const s = base.startsWith(needle) ? 0 : base.includes(needle) ? 1 : low.includes(needle) ? 2 : -1
    if (s < 0) continue
    const st = status?.get(f)
    scored.push({ f: { path: f, status: st?.status ?? '', ...(st?.from ? { from: st.from } : {}) }, s })
    // 已经够多就不必再打分，但要把 truncated 标出来
    if (scored.length > MAX_NAME_HITS) {
      truncated = true
      break
    }
  }
  scored.sort((a, b) => a.s - b.s || a.f.path.length - b.f.path.length)
  return { files: scored.slice(0, MAX_NAME_HITS).map((x) => x.f), truncated }
}

/** 按内容搜索：文件里包含关键词的行；本来就有扫描和命中上限 */
export async function searchInDir(dir: string, q: string): Promise<ContentSearch> {
  const needle = q.toLowerCase()
  const repo = await repoInfo(dir, false)
  const all = repo.isGit ? await gitTracked(dir, repo.prefix) : await walk(dir, MAX_SCAN)
  const files: ContentFile[] = []
  let hits = 0
  let truncated = false
  for (const f of all) {
    if (hits >= MAX_HITS || files.length >= MAX_SCAN) {
      truncated = true
      break
    }
    if (BINARY.test(f.path)) continue
    const full = path.join(dir, f.path)
    const s = await stat(full).catch(() => null)
    if (!s?.isFile() || s.size > MAX_SEARCH_BYTES) continue
    const text = await readFile(full, 'utf8').catch(() => null)
    if (text === null) continue
    const lines = text.split('\n')
    const found: { line: number; text: string }[] = []
    for (let i = 0; i < lines.length && hits < MAX_HITS; i++) {
      if (!lines[i].toLowerCase().includes(needle)) continue
      found.push({ line: i + 1, text: lines[i].slice(0, MAX_LINE) })
      hits++
    }
    if (found.length) files.push({ path: f.path, hits: found })
  }
  return { files, truncated }
}

/** git 仓库里的文件路径（已跟踪 + 未跟踪、不算忽略的） */
async function gitTracked(dir: string, prefix: string): Promise<FileEntry[]> {
  const r = await git(dir, 'ls-files', '--cached', '--others', '--exclude-standard', '-z')
  if (r.code !== 0) return []
  const seen = new Set<string>()
  const out: FileEntry[] = []
  for (const p of r.stdout.split('\0')) {
    if (!p) continue
    const full = norm(p)
    if (prefix && !full.startsWith(prefix)) continue
    const f = prefix ? full.slice(prefix.length) : full
    if (seen.has(f)) continue
    seen.add(f)
    out.push({ path: f, status: '' })
  }
  return out
}

/** 读一个文件的内容；二进制文件不给内容 */
export async function readInDir(dir: string, want: string): Promise<FileContent> {
  const full = into(dir, want)
  const info = await stat(full).catch(() => null)
  if (!info?.isFile()) return { path: norm(want), exists: false, content: '', truncated: false }
  const buf = await readFile(full)
  const head = buf.subarray(0, MAX_CONTENT)
  if (head.includes(0)) return { path: norm(want), exists: true, binary: true, content: '', truncated: false }
  return { path: norm(want), exists: true, content: head.toString('utf8'), truncated: buf.length > MAX_CONTENT }
}

/** 图片的原始内容；不是图片或文件不在了给错误 */
export async function rawInDir(dir: string, want: string): Promise<{ type: string; buf: Buffer }> {
  const full = into(dir, want)
  const type = IMAGE_TYPES[path.extname(full).slice(1).toLowerCase()]
  if (!type) throw new Error(t('不是图片'))
  const buf = await readFile(full).catch(() => null)
  if (!buf) throw new Error(t('文件已经不在了'))
  return { type, buf }
}

/** 项目里的文件；不是 git 仓库时没有状态 */
function filesApi(deps: { projects: { get(id: string): Promise<Project | null> } }) {
  const bad = (c: Context, error: string, status: 400 | 404 = 400) => c.json({ error }, status)

  /** 项目目录；项目不存在或目录不在了都抛错，由各自的路由转成响应 */
  async function dirOf(id: string) {
    const p = await deps.projects.get(id)
    if (!p) throw new Error(t('项目不存在'))
    const dir = p.path ? resolvePath(p.path) : ''
    const s = dir
      ? await stat(dir)
          .then((x) => x.isDirectory())
          .catch(() => false)
      : false
    if (!s) throw new Error(t('项目目录不存在：{dir}', { dir: p.path || t('（未设置）') }))
    return dir
  }

  const routes = new Hono()
    // 根信息：目录、分支、是不是 git 仓库。文件按层读，见下面的 list
    .get('/:id', async (c) => {
      let dir: string
      try {
        dir = await dirOf(c.req.param('id'))
      } catch (e) {
        return bad(c, (e as Error).message, 404)
      }
      return c.json(await listDir(dir))
    })
    // 列一层：展开目录时读它的直接子项
    .get('/:id/list', async (c) => {
      const want = c.req.query('path') ?? ''
      try {
        const dir = await dirOf(c.req.param('id'))
        return c.json(await listLevel(dir, want, { refresh: c.req.query('refresh') === '1' }))
      } catch (e) {
        return bad(c, (e as Error).message, 404)
      }
    })
    // 搜索：name 按文件名（服务端搜，深层没展开的文件也能找到），content 按内容
    .get('/:id/search', async (c) => {
      const mode = (c.req.query('mode') ?? 'name') as SearchMode
      const q = (c.req.query('q') ?? '').trim()
      if (!q) return c.json({ files: [], truncated: false } satisfies NameSearch | ContentSearch)
      if (mode !== 'name' && mode !== 'content') return bad(c, t('不支持的搜索方式'))
      let dir: string
      try {
        dir = await dirOf(c.req.param('id'))
      } catch (e) {
        return bad(c, (e as Error).message, 404)
      }
      return c.json(mode === 'name' ? await searchNameInDir(dir, q) : await searchInDir(dir, q))
    })
    // 单个文件的内容；图片走 raw
    .get('/:id/content', async (c) => {
      const want = (c.req.query('path') ?? '').trim()
      if (!want) return bad(c, t('缺少文件路径'))
      let dir: string
      try {
        dir = await dirOf(c.req.param('id'))
        return c.json(await readInDir(dir, want))
      } catch (e) {
        return bad(c, (e as Error).message, 404)
      }
    })
    // 图片：返回原始内容
    .get('/:id/raw', async (c) => {
      const want = (c.req.query('path') ?? '').trim()
      if (!want) return bad(c, t('缺少文件路径'))
      try {
        const dir = await dirOf(c.req.param('id'))
        const { type, buf } = await rawInDir(dir, want)
        return c.body(new Uint8Array(buf), 200, { 'Content-Type': type, 'Cache-Control': 'private, max-age=60' })
      } catch (e) {
        return bad(c, (e as Error).message, 404)
      }
    })

  return routes
}

export { filesApi }
