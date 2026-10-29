/**
 * 文件浏览：按层列出项目目录（带 git 状态）、按文件名或内容搜索、读单个文件。
 * 只接受已有项目的目录，路径不能逃出项目目录。
 *
 * 大项目不能一次扫描整棵树：列表只读当前这一层，git 状态也只看这一层有变化的文件。
 */
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rmdir, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import type { FileFormat, Project } from '../shared/schema.ts'
import type {
  ContentFile,
  ContentSearch,
  DirEntry,
  DirLevel,
  FileContent,
  FileDiff,
  FileEntry,
  FileStatus,
  FileTree,
  FileWrite,
  NameSearch,
  SearchMode,
} from '../shared/files.ts'
import { capture } from './exec/process.ts'
import { gitFileDiff } from './exec/git.ts'
import { projectFormat, writeTextFile } from '../shared/file-format.ts'
import { getSettings } from './settings.ts'
import { resolvePath } from './fs.ts'
import { revealItem } from './open.ts'
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
  // 只读查询不加索引锁：文件面板开着时会反复查，不能和 Agent 正在做的 git add/commit 抢 index.lock
  const args = ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all']
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

/** 遍历搜索时跳过点开头的项（.github 除外）：.cache、.venv 这类目录里文件多，搜出来都是噪音 */
const hidden = (name: string) => name.startsWith('.') && name !== '.github'

/**
 * 列目录时只藏 .git：.gitignore、.claude、.env 这些用户要看要改，
 * 以前点开头的全藏，仓库根只剩一两个目录时像是列不全
 */
const hiddenInList = (name: string) => name === '.git'

/**
 * 绝对路径的各种写法：POSIX 的 /x、Windows 的 C:\x 与 C:/x、UNC 的 \\server\share。
 * 跨平台都要认：Linux 上 path.isAbsolute('C:/x') 是 false，只靠它挡不住。
 */
const absoluteLike = (p: string) => path.isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p) || /^[\\/]{2}/.test(p)

/** full 在 root 里面（不是真正的上级目录和它的兄弟） */
function inside(root: string, full: string) {
  const r = path.relative(root, full)
  // 只有真正的上级目录才算越界；..foo 这种名字是项目里的普通文件
  return r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r)
}

/**
 * 真实路径。目标还不存在（新建文件、目录）时没法直接 realpath：
 * 先对最近的已存在祖先做 realpath，再把剩下那几段拼回去。
 */
async function realOf(full: string): Promise<string> {
  const real = await realpath(full).catch(() => null)
  if (real) return real
  const parent = path.dirname(full)
  // 到盘符根或 / 还解析不了，说明上面已经没有能解析的目录了
  if (parent === full) return full
  return path.join(await realOf(parent), path.basename(full))
}

/**
 * 相对路径落在这个目录里才接受。
 * 传进来的必须是相对路径：先剥掉开头的 / 再校验，会把 Linux 的 /tmp/x 变成项目里的 tmp/x，
 * 越权校验就被绕过了，所以绝对路径在做任何规整之前就拒绝。
 * 比两次：先看字面路径（拦住 .. 和绝对路径），再按真实路径看一次
 * ——项目里的符号链接、junction 指向外面时，字面路径还在项目里，实际读到的却是项目外的文件。
 */
async function into(dir: string, rel: string) {
  if (absoluteLike(rel)) throw new Error(t('只能查看项目目录里的文件'))
  const root = path.resolve(dir)
  const full = path.resolve(root, rel)
  if (!inside(root, full)) throw new Error(t('只能查看项目目录里的文件'))
  const realRoot = await realpath(root).catch(() => root)
  if (!inside(realRoot, await realOf(full))) throw new Error(t('只能查看项目目录里的文件'))
  return full
}

/** 链接（符号链接、Windows 的 junction）都不跟：lstat 才看得到，Dirent 在 Windows 上不一定标出来 */
const isLink = (full: string) =>
  lstat(full).then(
    (s) => s.isSymbolicLink(),
    () => false,
  )

/** 这个路径的真实位置在项目里（中间某一层是链接时可能指到外面） */
async function realInside(dir: string, full: string) {
  const realRoot = await realpath(dir).catch(() => dir)
  const real = await realpath(full).catch(() => null)
  return real !== null && inside(realRoot, real)
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
 * 点开头的项照常列出，只有 .git 不列。
 */
export async function listLevel(dir: string, rel: string, opts: { refresh?: boolean } = {}): Promise<DirLevel> {
  // 先校验原始路径：只统一分隔符，不能先剥掉开头的 /，否则绝对路径会变成项目里的相对路径
  const full = await into(dir, norm(rel))
  // 校验通过后再去掉结尾的分隔符，用于拼 pathspec 和子项路径
  const want = norm(rel).replace(/\/+$/, '')
  const info = await stat(full).catch(() => null)
  if (!info?.isDirectory()) throw new Error(t('目录已经不在了'))

  const repo = await repoInfo(dir, !!opts.refresh)
  const [items, status] = await Promise.all([
    readdir(full, { withFileTypes: true }),
    repo.isGit ? statusCached(dir, want, repo.prefix, !!opts.refresh) : Promise.resolve(null),
  ])

  const entries: DirEntry[] = []
  for (const it of items) {
    if (hiddenInList(it.name)) continue
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

/**
 * 遍历目录（不是 git 仓库时按名字搜索用），带数量上限。
 * 符号链接、junction 一律不跟：跟出去会读到项目外的文件，绕回来还会转成环。
 */
async function walk(root: string, limit: number): Promise<FileEntry[]> {
  const out: FileEntry[] = []
  // 已走过的真实目录：链接没被认出时也能避免同一层走两遍
  const seen = new Set<string>()
  const visit = async (dir: string, rel: string) => {
    if (out.length >= limit) return
    const real = await realpath(dir).catch(() => null)
    if (real === null || seen.has(real)) return
    seen.add(real)
    const items = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const it of items) {
      if (out.length >= limit) return
      if (hidden(it.name)) continue
      const r = rel ? `${rel}/${it.name}` : it.name
      const full = path.join(dir, it.name)
      if (it.isSymbolicLink() || (await isLink(full))) continue
      if (it.isDirectory()) {
        if (!SKIP.has(it.name)) await visit(full, r)
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
    // 路径中间有一层是链接时（git 也可能列出 link/a.txt），读之前确认真实位置还在项目里
    if (!(await realInside(dir, full))) continue
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
  const full = await into(dir, want)
  const info = await stat(full).catch(() => null)
  if (!info?.isFile()) return { path: norm(want), exists: false, content: '', truncated: false }
  const buf = await readFile(full)
  const head = buf.subarray(0, MAX_CONTENT)
  const size = info.size
  const mtime = info.mtime.toISOString()
  if (head.includes(0))
    return { path: norm(want), exists: true, binary: true, content: '', truncated: false, size, mtime }
  const text = head.toString('utf8')
  return {
    path: norm(want),
    exists: true,
    content: text,
    truncated: buf.length > MAX_CONTENT,
    size,
    mtime,
    // 保存时按这个换行回写，不把 CRLF 的文件改成 LF
    eol: text.includes('\r\n') ? 'crlf' : 'lf',
  }
}

/** 相对项目目录的路径，统一用 / */
const relOf = (dir: string, full: string) => norm(path.relative(dir, full))

/** 单段名字：不能带路径分隔符、.. 和盘符，否则一次就能写到别的目录去 */
function oneName(name: string): string {
  const n = name.trim()
  if (!n || n === '.' || n === '..' || /[\\/]/.test(n) || /^[a-zA-Z]:/.test(n) || n.includes('\0'))
    throw new Error(t('名字只能是单个文件名，不能带路径分隔符或 ..'))
  return n
}

/** 内容太大时拒绝：一次写进几十兆会把面板和浏览器都卡住 */
function checkSize(content: string) {
  if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT)
    throw new Error(t('内容太大，最多 {kb} KB', { kb: Math.floor(MAX_CONTENT / 1000) }))
}

/** 文件里现在用的是哪种换行；空文件或读不出时返回 null */
function eolOf(text: string): 'lf' | 'crlf' | null {
  if (text.includes('\r\n')) return 'crlf'
  return text.includes('\n') ? 'lf' : null
}

/** 只读开头一段：判断换行用不了整个文件（可能是几十兆的日志） */
async function headOf(full: string, size = 64_000): Promise<string | null> {
  const fh = await open(full, 'r').catch(() => null)
  if (!fh) return null
  try {
    const buf = Buffer.alloc(size)
    const { bytesRead } = await fh.read(buf, 0, size, 0)
    return buf.subarray(0, bytesRead).toString('utf8')
  } finally {
    await fh.close()
  }
}

/** 目标已经存在（链接也算存在，不会被覆盖） */
const exists = (full: string) =>
  lstat(full).then(
    () => true,
    () => false,
  )

/**
 * 保存一个文件：写入格式按项目设置（没设时跟随全局），
 * 原文件是 CRLF 时按原样回写，不在保存时把整个文件的换行都改掉。
 */
export async function writeInDir(dir: string, want: string, content: string, format: FileFormat): Promise<FileWrite> {
  const full = await into(dir, norm(want))
  const info = await stat(full).catch(() => null)
  if (!info?.isFile()) throw new Error(t('文件已经不在了'))
  checkSize(content)
  const head = await headOf(full)
  const eol = head === null ? null : eolOf(head)
  await writeTextFile(full, content, eol ? { ...format, eol } : format)
  const after = await stat(full)
  return { path: norm(want), size: after.size }
}

/** 在目录里新建文件；已有同名文件或目录时拒绝覆盖 */
export async function createInDir(
  dir: string,
  relDir: string,
  name: string,
  content: string,
  format: FileFormat,
): Promise<FileWrite> {
  const base = await into(dir, norm(relDir))
  const info = await stat(base).catch(() => null)
  if (!info?.isDirectory()) throw new Error(t('目录已经不在了'))
  const n = oneName(name)
  checkSize(content)
  const full = path.join(base, n)
  if (await exists(full)) throw Object.assign(new Error(t('已经有一个同名的文件或目录了')), { status: 409 })
  await writeTextFile(full, content, format)
  const after = await stat(full)
  return { path: relOf(dir, full), size: after.size }
}

/**
 * 把一段内容存成项目里的文件（Chat 右栏的「存到项目」）：中间缺的目录一并建好，路径照样走 into() 限在项目目录里；
 * 已有同名文件时只有 overwrite 才改写，否则和新建一样拒绝（409），不悄悄覆盖用户的文件
 */
export async function saveInDir(
  dir: string,
  relDir: string,
  name: string,
  content: string,
  format: FileFormat,
  overwrite: boolean,
): Promise<FileWrite> {
  const base = await into(dir, norm(relDir))
  const n = oneName(name)
  const full = path.join(base, n)
  const info = await stat(full).catch(() => null)
  if (info?.isFile() && overwrite) return writeInDir(dir, relOf(dir, full), content, format)
  await mkdir(base, { recursive: true })
  return createInDir(dir, relOf(dir, base), n, content, format)
}

/** 新建目录（只建一层）；已有同名文件或目录时拒绝 */
export async function mkdirInDir(dir: string, relDir: string, name: string): Promise<{ path: string }> {
  const base = await into(dir, norm(relDir))
  const info = await stat(base).catch(() => null)
  if (!info?.isDirectory()) throw new Error(t('目录已经不在了'))
  const n = oneName(name)
  const full = path.join(base, n)
  if (await exists(full)) throw Object.assign(new Error(t('已经有一个同名的文件或目录了')), { status: 409 })
  await mkdir(full)
  return { path: relOf(dir, full) }
}

/** 在同一层里改名；目标已存在时拒绝，不覆盖别人的文件 */
export async function renameInDir(dir: string, want: string, name: string): Promise<{ path: string }> {
  const rel = norm(want).replace(/\/+$/, '')
  if (!rel) throw new Error(t('不能重命名项目目录'))
  const full = await into(dir, norm(want))
  const info = await lstat(full).catch(() => null)
  if (!info) throw new Error(t('文件已经不在了'))
  const n = oneName(name)
  const target = path.join(path.dirname(full), n)
  // 改成本身那个名字也算同名，直接当没改
  if (await exists(target)) throw Object.assign(new Error(t('已经有一个同名的文件或目录了')), { status: 409 })
  await rename(full, target)
  return { path: relOf(dir, target) }
}

/** 删除一个文件或空目录；非空目录不删，免得一次误删一整片 */
export async function deleteInDir(dir: string, want: string): Promise<{ ok: true }> {
  if (!norm(want).replace(/\/+$/, '')) throw new Error(t('不能删除项目目录'))
  const full = await into(dir, norm(want))
  const info = await lstat(full).catch(() => null)
  if (!info) throw new Error(t('文件已经不在了'))
  if (info.isSymbolicLink() || info.isFile()) {
    // 链接只删链接本身，不跟进去删它指向的东西
    await unlink(full)
  } else if (info.isDirectory()) {
    const items = await readdir(full)
    if (items.length) throw new Error(t('目录里还有内容，不能删除'))
    await rmdir(full)
  } else throw new Error(t('只能删除文件或目录'))
  return { ok: true }
}

/** 和 git 比一个文件的差异；新文件给整份内容，不是 git 仓库时只有说明 */
export async function diffInDir(dir: string, want: string): Promise<FileDiff> {
  const full = await into(dir, norm(want))
  const rel = relOf(dir, full)
  if (!(await isGitRepo(dir)))
    return {
      path: rel,
      dir,
      diff: '',
      git: false,
      before: false,
      note: t('这个项目不是 git 仓库，看不到改动对比'),
    }
  // before：文件在 HEAD 里原来就有
  const before = (await git(dir, 'cat-file', '-e', `HEAD:${rel}`)).code === 0
  const diff = await gitFileDiff(dir, 'HEAD', rel)
  const tracked = (await git(dir, 'ls-files', '--error-unmatch', '--', rel)).code === 0
  if (!tracked) return { path: rel, dir, diff, git: false, before, note: t('这个文件还没提交过，下面是它的完整内容') }
  return { path: rel, dir, diff, git: true, before }
}

/** 图片的原始内容；不是图片或文件不在了给错误 */
export async function rawInDir(dir: string, want: string): Promise<{ type: string; buf: Buffer }> {
  const full = await into(dir, want)
  const type = IMAGE_TYPES[path.extname(full).slice(1).toLowerCase()]
  if (!type) throw new Error(t('不是图片'))
  const buf = await readFile(full).catch(() => null)
  if (!buf) throw new Error(t('文件已经不在了'))
  return { type, buf }
}

/**
 * 在系统的文件管理器里打开一个文件或目录。
 * 传空路径时打开项目目录本身；不存在的路径退回打开它的上一级，不让整个操作失败。
 */
export async function revealInDir(dir: string, want: string): Promise<void> {
  // 原始路径直接校验：剥掉结尾的分隔符会把 '/' 变成空串，当成项目根，绝对路径的语义就丢了
  const full = await into(dir, norm(want))
  const info = await stat(full).catch(() => null)
  if (info?.isDirectory()) {
    await revealItem(full)
    return
  }
  // 文件：选中它；文件已经被删掉时打开所在的文件夹
  await revealItem(info?.isFile() ? full : path.dirname(full))
}

/** 写接口的入参：字段都在这里校验，名字的单段规则在 oneName 里 */
const WriteInput = z.object({ path: z.string(), content: z.string() })
const NewInput = z.object({
  dir: z.string().optional(),
  name: z.string(),
  content: z.string().optional(),
  /** 中间缺的目录一并建好（「存到项目」给的是相对路径，目录可能还没有） */
  parents: z.boolean().optional(),
  /** 已有同名文件时改写它；不给时同名拒绝 */
  overwrite: z.boolean().optional(),
})
const MkdirInput = z.object({ dir: z.string().optional(), name: z.string() })
const RenameInput = z.object({ path: z.string(), name: z.string() })
const DeleteInput = z.object({ path: z.string() })

/** 项目里的文件；不是 git 仓库时没有状态 */
function filesApi(deps: { projects: { get(id: string): Promise<Project | null> } }) {
  const bad = (c: Context, error: string, status: 400 | 404 | 409 = 400) => c.json({ error }, status)
  /** 写操作失败：同名冲突给 409，其余都是 400 */
  const fail = (c: Context, e: unknown) => bad(c, (e as Error).message, (e as { status?: 409 }).status ?? 400)

  /** 写文件用的格式：按项目设置的编码和换行（没设时跟随全局） */
  async function formatOf(id: string): Promise<FileFormat> {
    const p = await deps.projects.get(id)
    return projectFormat(p ?? undefined, await getSettings())
  }

  /** 写接口的请求体：不是 JSON 或字段不对时直接给 400 */
  const body = async <T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T> | null> => {
    const p = schema.safeParse(await c.req.json().catch(() => null))
    return p.success ? p.data : null
  }

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
    // 在系统的文件管理器里打开文件或目录；不传路径时打开项目目录
    .post('/:id/reveal', async (c) => {
      const want = (c.req.query('path') ?? '').trim()
      try {
        const dir = await dirOf(c.req.param('id'))
        await revealInDir(dir, want)
        return c.json({ ok: true, dir })
      } catch (e) {
        return bad(c, (e as Error).message, 404)
      }
    })
    // 保存文件内容：路径走 into() 校验，编码和换行按项目设置（原文件是 CRLF 时按原样）
    .put('/:id/content', async (c) => {
      const p = await body(c, WriteInput)
      if (!p) return bad(c, t('参数不对'))
      try {
        const dir = await dirOf(c.req.param('id'))
        return c.json(await writeInDir(dir, p.path, p.content, await formatOf(c.req.param('id'))))
      } catch (e) {
        return fail(c, e)
      }
    })
    // 在目录里新建文件；同名不覆盖
    .post('/:id/new', async (c) => {
      const p = await body(c, NewInput)
      if (!p) return bad(c, t('参数不对'))
      try {
        const dir = await dirOf(c.req.param('id'))
        const format = await formatOf(c.req.param('id'))
        if (p.parents || p.overwrite)
          return c.json(await saveInDir(dir, p.dir ?? '', p.name, p.content ?? '', format, !!p.overwrite))
        return c.json(await createInDir(dir, p.dir ?? '', p.name, p.content ?? '', format))
      } catch (e) {
        return fail(c, e)
      }
    })
    // 新建目录；同名不覆盖
    .post('/:id/mkdir', async (c) => {
      const p = await body(c, MkdirInput)
      if (!p) return bad(c, t('参数不对'))
      try {
        const dir = await dirOf(c.req.param('id'))
        return c.json(await mkdirInDir(dir, p.dir ?? '', p.name))
      } catch (e) {
        return fail(c, e)
      }
    })
    // 改名；目标已存在时不覆盖
    .post('/:id/rename', async (c) => {
      const p = await body(c, RenameInput)
      if (!p) return bad(c, t('参数不对'))
      try {
        const dir = await dirOf(c.req.param('id'))
        return c.json(await renameInDir(dir, p.path, p.name))
      } catch (e) {
        return fail(c, e)
      }
    })
    // 删除：文件直接删，目录必须为空
    .post('/:id/delete', async (c) => {
      const p = await body(c, DeleteInput)
      if (!p) return bad(c, t('参数不对'))
      try {
        const dir = await dirOf(c.req.param('id'))
        return c.json(await deleteInDir(dir, p.path))
      } catch (e) {
        return fail(c, e)
      }
    })
    // 和 git 比一个文件的差异；不是 git 仓库或文件还没提交过时 git 为 false
    .get('/:id/diff', async (c) => {
      const want = (c.req.query('path') ?? '').trim()
      if (!want) return bad(c, t('缺少文件路径'))
      try {
        const dir = await dirOf(c.req.param('id'))
        return c.json(await diffInDir(dir, want))
      } catch (e) {
        return fail(c, e)
      }
    })

  return routes
}

export { filesApi }
