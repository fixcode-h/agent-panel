/**
 * 文件浏览：列出一个项目目录里的文件（带 git 状态）、按文件名或内容搜索、读单个文件。
 * 只接受已有项目的目录，路径不能逃出项目目录。
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { Hono, type Context } from 'hono'
import type { Project } from '../shared/schema.ts'
import type {
  ContentFile,
  ContentSearch,
  FileContent,
  FileEntry,
  FileStatus,
  FileTree,
  SearchMode,
} from '../shared/files.ts'
import { capture } from './exec/process.ts'
import { resolvePath } from './fs.ts'
import { IMAGE_TYPES } from './uploads.ts'
import { t } from '../shared/i18n.ts'

/** 一次最多列这么多文件；再多的项目只列前面一部分 */
const MAX_FILES = 20_000
/** 内容搜索最多扫这么多文件、这么多命中 */
const MAX_SCAN = 5_000
const MAX_HITS = 300
const MAX_LINE = 400
/** 大于这个大小的文件不搜内容，多半是数据或产物 */
const MAX_SEARCH_BYTES = 2_000_000
const MAX_CONTENT = 400_000

/** 不是 git 仓库时自己遍历目录，跳过这些 */
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
  capture('git', ['-c', 'core.quotepath=off', ...args], cwd, undefined, 20_000)

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

/** 遍历目录（不是 git 仓库时用），返回相对路径 */
async function walk(root: string): Promise<FileEntry[]> {
  const out: FileEntry[] = []
  const visit = async (dir: string, rel: string) => {
    if (out.length >= MAX_FILES) return
    const items = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const it of items) {
      if (out.length >= MAX_FILES) return
      // 隐藏文件除 .github、.env 这些约定文件外都不列
      if (it.name.startsWith('.') && it.name !== '.github') continue
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
 * git 里的文件：已跟踪的和未跟踪的都要（未跟踪的就是新增）。
 * status 用 porcelain 的两列状态：取第一个非空的字母。
 */
async function gitFiles(dir: string): Promise<FileEntry[]> {
  const r = await git(dir, 'status', '--porcelain=v1', '-z', '--untracked-files=all')
  const status = new Map<string, { status: FileStatus; from?: string }>()
  if (r.code === 0) {
    const parts = r.stdout.split('\0')
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]
      if (!p || p.length < 4) continue
      const x = p[0]
      const y = p[1]
      let file = norm(p.slice(3))
      let from: string | undefined
      // 重命名和复制后面跟着一个原路径
      if (x === 'R' || x === 'C') {
        from = norm(parts[i + 1] ?? '')
        i++
      }
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
      status.set(file, { status: code, from })
    }
  }
  // 所有文件：已跟踪的 + 未跟踪的，跳过被忽略的
  const list = await git(dir, 'ls-files', '--cached', '--others', '--exclude-standard')
  const files = list.code === 0 ? list.stdout.split('\n').filter(Boolean).map(norm) : []
  const seen = new Set<string>()
  const out: FileEntry[] = []
  for (const f of files) {
    if (seen.has(f)) continue
    seen.add(f)
    const s = status.get(f)
    out.push({ path: f, status: s?.status ?? '', from: s?.from })
  }
  // 有状态但不在列表里的（例如已被删除的）也列出来，否则看不到删除
  for (const [f, s] of status) {
    if (!seen.has(f)) out.push({ path: f, status: s.status, from: s.from })
  }
  return out
}

/** 文件排序：目录在前，同级按名字；大小写不敏感 */
const byPath = (a: FileEntry, b: FileEntry) =>
  a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' })

/** 相对路径落在这个目录里才接受 */
function into(dir: string, rel: string) {
  const full = path.resolve(dir, rel)
  const r = path.relative(dir, full)
  if (r.startsWith('..') || path.isAbsolute(r)) throw new Error(t('只能查看项目目录里的文件'))
  return full
}

/** 目录里的文件和一个目录里所有文件：git 仓库读 git，不是仓库时遍历目录 */
async function scan(dir: string) {
  const isGit = await isGitRepo(dir)
  const all = isGit ? await gitFiles(dir) : await walk(dir)
  all.sort(byPath)
  return { isGit, all }
}

/** 一个目录的文件树；任务用 worktree 目录，项目用项目目录 */
export async function listDir(dir: string): Promise<FileTree> {
  const { isGit, all } = await scan(dir)
  return {
    dir,
    branch: isGit ? await branchOf(dir) : null,
    isGit,
    files: all.slice(0, MAX_FILES),
    truncated: all.length > MAX_FILES,
  }
}

/** 按内容搜索：文件里包含关键词的行 */
export async function searchInDir(dir: string, q: string): Promise<ContentSearch> {
  const needle = q.toLowerCase()
  const { all } = await scan(dir)
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

/** 项目里的文件树；不是 git 仓库时没有状态 */
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
    // 文件列表：目录树、git 状态
    .get('/:id', async (c) => {
      let dir: string
      try {
        dir = await dirOf(c.req.param('id'))
      } catch (e) {
        return bad(c, (e as Error).message, 404)
      }
      return c.json(await listDir(dir))
    })
    // 搜索：name 按文件名（就是上面的列表，前端自己过滤），content 按内容
    .get('/:id/search', async (c) => {
      const mode = (c.req.query('mode') ?? 'name') as SearchMode
      const q = (c.req.query('q') ?? '').trim()
      if (!q) return c.json({ files: [], truncated: false } satisfies ContentSearch)
      if (mode !== 'content') return bad(c, t('不支持的搜索方式'))
      let dir: string
      try {
        dir = await dirOf(c.req.param('id'))
      } catch (e) {
        return bad(c, (e as Error).message, 404)
      }
      return c.json(await searchInDir(dir, q))
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
