import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  baseName,
  branchDirName,
  branchNameOf,
  DOC_PLACE_SIBLING,
  docGroupKey,
  joinPath,
  norm,
  parentDir,
  vcsDocRoot,
  type DocGroupView,
  type DocVcs,
} from '../shared/doc-root.ts'
import { withModuleBranch } from '../shared/module-docs.ts'
import { log } from './log.ts'
import { dataPath, readJson, writeJsonAtomic } from './store.ts'

/**
 * P4 / SVN 项目外文档的「文档组」（用户 2026-11-05 定的，见 ADR 0052）：
 * 以前文档根按本地目录算（<项目上一级>/ProjectDoc/docs），每个分支目录各算出一个，新分支读不到老分支分析过的模块文档。
 * 现在同一工程（按项目文件夹区分，见 shared/doc-root.ts 的 docGroupKey）的各分支归到一个组，组里只有一个文档根。
 *
 * - 组第一次建立时，文档根沿用模块文档最多的那个分支的旧 ProjectDoc/docs，那一份原地不动；
 * - 其他分支的旧文档根第一次用到时合进来：没有的复制、一样的跳过、内容不同的另存成 <名字>.from-<分支>.<扩展名>，
 *   列进冲突清单交给「文档」合并；p4change、worklog 搬到 branches/<分支>/ 下；旧目录不删，只留一份 MOVED.md；
 * - 用户可以在项目设置里把文档根改到别处，改的时候把现有内容按同样的规则并过去。
 *
 * 组的记录在数据目录的 projects/doc-groups.json；项目 JSON 里不存路径，改文档根只改一处。
 */

/** 一次合并旧文档根的结果 */
export interface DocMigration {
  at: string
  /** 旧文档根属于哪个分支（空串：改文档根时并过去的，不按分支处理） */
  branch: string
  copied: number
  /** 内容不同、另存成 .from-<分支> 的文件（相对新文档根） */
  conflicts: string[]
  error?: string
}

interface DocGroup {
  root: string
  /** 用户在项目设置里改过文档根 */
  manual?: boolean
  /** 项目目录（norm 过） → 分支名 */
  branches: Record<string, string>
  /** 合并过的旧文档根（norm 过） → 合并结果 */
  migrated: Record<string, DocMigration>
}

type Registry = Record<string, DocGroup>

const FILE = () => dataPath('projects/doc-groups.json')
/** 只属于某个分支的记录：合并时搬到 branches/<分支>/ 下 */
const BRANCH_ONLY = ['p4change', 'worklog']
const MOVED = 'MOVED.md'

let cache: Registry | undefined // 模块状态：缓存，丢了重算
/** 测试用：换了数据目录后重新读 */
export const resetDocGroups = () => {
  cache = undefined
}

async function load(): Promise<Registry> {
  if (cache) return cache
  const raw = (await readJson(FILE()).catch(() => undefined)) as Registry | undefined
  cache = raw && typeof raw === 'object' ? raw : {}
  return cache
}

const save = (reg: Registry) => writeJsonAtomic(FILE(), reg)

// 组的建立和合并会读写同一份记录和同一批文件：几个对话同时开始时排队做，不重复复制
let chain: Promise<unknown> = Promise.resolve() // 模块状态：排队，丢了没事
function serial<T>(run: () => Promise<T>): Promise<T> {
  const next = chain.catch(() => {}).then(run)
  chain = next
  return next
}

const isDir = async (p: string) => !!(await stat(p).catch(() => null))?.isDirectory()

/** 文档根下有几个模块文档目录：挑组的文档根时按它选 */
async function moduleCount(root: string) {
  const dirs = await readdir(path.join(root, 'modules'), { withFileTypes: true }).catch(() => [])
  return dirs.filter((d) => d.isDirectory()).length
}

/**
 * 同一工程其他分支的旧文档根：<根>/<分支>/<项目文件夹> 这种布局里，扫 <根> 下的每个分支目录，
 * 有同名项目文件夹、又有 ProjectDoc/docs 的就是。自己的旧文档根总在第一个（不存在也列，挑不出别的时用它）
 */
async function legacyRoots(projectPath: string) {
  const own = { root: vcsDocRoot(projectPath, DOC_PLACE_SIBLING), branch: branchNameOf(projectPath) }
  const out = [own]
  const top = parentDir(parentDir(projectPath))
  const folder = baseName(projectPath)
  if (!folder || norm(top) === norm(parentDir(projectPath))) return out
  const dirs = await readdir(top, { withFileTypes: true }).catch(() => [])
  for (const d of dirs.slice(0, 500)) {
    if (!d.isDirectory()) continue
    const branchDir = joinPath(top, d.name)
    const root = joinPath(branchDir, 'ProjectDoc/docs')
    if (norm(root) === norm(own.root)) continue
    if (!existsSync(joinPath(branchDir, folder)) || !(await isDir(root))) continue
    out.push({ root, branch: d.name })
  }
  return out
}

/** 合并时文件的去向：p4change / worklog 搬到 branches/<分支>/ 下，其余原样 */
function targetRel(rel: string, branch: string) {
  const top = rel.split('/')[0]
  return branch && BRANCH_ONLY.includes(top) ? `branches/${branchDirName(branch)}/${rel}` : rel
}

/** 冲突时另存的名字：README.md → README.from-Dev.md */
function fromName(rel: string, branch: string) {
  const ext = path.posix.extname(rel)
  return `${rel.slice(0, rel.length - ext.length)}.from-${branchDirName(branch || 'old')}${ext}`
}

/** 项目教训的冲突不用人合并：读取时按 id 去重、取更新的那份（见 server/projects/lessons.ts） */
const isLessons = (rel: string) => rel === 'lessons.md' || rel.startsWith('lessons/')

/** 模块 README 搬过来时补上分支：老文档没写过分支 */
const isModuleReadme = (rel: string) => /^modules\/[^/]+\/README\.md$/.test(rel)

async function walk(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = []
  const entries = await readdir(path.join(dir, rel), { withFileTypes: true })
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...(await walk(dir, r)))
    else if (e.isFile() && r !== MOVED) out.push(r)
  }
  return out
}

/**
 * 把旧文档根并进新文档根（只复制，不删旧的）：没有的复制，一样的跳过，不同的另存成 .from-<分支>。
 * 旧目录里留一份 MOVED.md 说明去向。重复调用是幂等的
 */
export async function mergeDocRoot(from: string, to: string, branch: string): Promise<DocMigration> {
  const result: DocMigration = { at: new Date().toISOString(), branch, copied: 0, conflicts: [] }
  for (const rel of await walk(from)) {
    let body: Buffer | string = await readFile(path.join(from, rel))
    if (branch && isModuleReadme(rel)) body = withModuleBranch(body.toString('utf8'), branch)
    const dest = targetRel(rel, branch)
    const file = path.join(to, dest)
    const have = await readFile(file).catch(() => null)
    const same = (b: Buffer | null) => !!b && Buffer.compare(b, Buffer.from(body)) === 0
    if (same(have)) continue
    let out = file
    if (have) {
      const alt = fromName(dest, branch)
      out = path.join(to, alt)
      if (same(await readFile(out).catch(() => null))) continue
      if (!isLessons(dest)) result.conflicts.push(alt)
    }
    await mkdir(path.dirname(out), { recursive: true })
    await writeFile(out, body)
    result.copied++
  }
  await writeFile(
    path.join(from, MOVED),
    `# 文档已合并\n\n这个目录里的文档已在 ${result.at.slice(0, 10)} 合并到 \`${to}\`（同一工程的各分支共用一个文档根）。\nAgent 面板以后只读写新位置；这里的文件保留着，确认没问题后可以手动删除。\n`,
    'utf8',
  )
  return result
}

/** 给文档根里没写分支的模块 README 补上分支：组建立时，沿用的那个旧文档根原地补 */
async function tagModules(root: string, branch: string) {
  const dirs = await readdir(path.join(root, 'modules'), { withFileTypes: true }).catch(() => [])
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    const file = path.join(root, 'modules', d.name, 'README.md')
    const text = await readFile(file, 'utf8').catch(() => '')
    const next = text && withModuleBranch(text, branch)
    if (next && next !== text) await writeFile(file, next, 'utf8')
  }
}

/** 组里新分支的名字：和已有的重名（不同位置的同名分支目录）时加序号 */
function uniqueBranch(g: DocGroup, name: string) {
  const used = new Set(Object.values(g.branches))
  if (!used.has(name)) return name
  for (let i = 2; ; i++) if (!used.has(`${name}-${i}`)) return `${name}-${i}`
}

async function migrateInto(g: DocGroup, from: string, branch: string) {
  const key = norm(from)
  const done = g.migrated[key]
  if (key === norm(g.root) || (done && !done.error)) return false
  if (!(await isDir(from))) return false
  try {
    g.migrated[key] = await mergeDocRoot(from, g.root, branch)
  } catch (e) {
    // 合并失败不切走也不删：已经复制的文件是幂等的，下一次用到时再试一遍；错误显示在项目设置里
    g.migrated[key] = { at: new Date().toISOString(), branch, copied: 0, conflicts: [], error: (e as Error).message }
    log.warn('docs', '合并旧文档根失败', { from, to: g.root, error: (e as Error).message })
  }
  return true
}

function view(key: string, g: DocGroup, projectPath: string): DocGroupView {
  const branch = g.branches[norm(projectPath)] ?? branchNameOf(projectPath)
  const all = Object.values(g.migrated)
  return {
    key,
    root: g.root,
    manual: !!g.manual,
    branch,
    branchDir: joinPath(g.root, `branches/${branchDirName(branch)}`),
    branches: Object.entries(g.branches).map(([p, name]) => ({ name, path: p })),
    conflicts: [...new Set(all.flatMap((m) => m.conflicts))].filter((rel) => existsSync(path.join(g.root, rel))),
    errors: all.flatMap((m) => (m.error ? [m.error] : [])),
  }
}

/**
 * 这个项目所在的文档组：没有就建一个（挑文档根、合并其他分支的旧文档根），
 * 这个分支第一次用到时把它自己的旧文档根合进来。项目目录读不到时照样算（只是没有可合并的）
 */
export function resolveDocGroup(projectPath: string, vcs: DocVcs): Promise<DocGroupView> {
  return serial(async () => {
    const key = docGroupKey(projectPath, vcs)
    const reg = await load()
    let g = reg[key]
    let changed = false
    if (!g) {
      const found = await legacyRoots(projectPath)
      const counts = await Promise.all(found.map((f) => moduleCount(f.root)))
      // 模块文档最多的那份原地不动当共用文档根；一样多时用自己的
      const best = counts.reduce((b, n, i) => (n > counts[b] ? i : b), 0)
      g = { root: found[best].root, branches: {}, migrated: {} }
      reg[key] = g
      changed = true
      await tagModules(g.root, found[best].branch).catch(() => {})
      for (const f of found) if (f !== found[best]) await migrateInto(g, f.root, f.branch)
    }
    const at = norm(projectPath)
    if (!g.branches[at]) {
      g.branches[at] = uniqueBranch(g, branchNameOf(projectPath))
      changed = true
    }
    if (await migrateInto(g, vcsDocRoot(projectPath, DOC_PLACE_SIBLING), g.branches[at])) changed = true
    if (changed) await save(reg)
    return view(key, g, projectPath)
  })
}

/**
 * 用户在项目设置里改共用文档根：现有内容按合并规则并到新位置（不删旧的），以后整组都用新位置。
 * 新位置和现在一样时什么都不做
 */
export async function setDocGroupRoot(projectPath: string, vcs: DocVcs, root: string): Promise<DocGroupView> {
  await resolveDocGroup(projectPath, vcs)
  return serial(async () => {
    const key = docGroupKey(projectPath, vcs)
    const reg = await load()
    const g = reg[key]
    const next = root.trim()
    if (norm(next) !== norm(g.root)) {
      await mkdir(next, { recursive: true })
      const old = g.root
      // 现有文档根里已经按分支放好了，不再按分支搬
      if (await isDir(old)) g.migrated[norm(old)] = await mergeDocRoot(old, next, '')
      g.root = next
      g.manual = true
      await save(reg)
    }
    return view(key, g, projectPath)
  })
}
