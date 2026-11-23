/**
 * 按项目管理文件索引：一个项目有几个根（项目目录、文档根、设置里额外加的、插件报来的外部目录如 UE 引擎），
 * 每个根一份 IndexUnit，同一个根同一套规则的几个项目共用。
 *
 * 项目设置每次用到时现读：开关、排除目录、额外目录变了就换成新的根清单（规则变了的根会整份重建）。
 * 30 分钟没人用的项目停监听、丢内存，只留落盘；下次用时读回 + 核对
 */
import path from 'node:path'
import { fileIndexSettingsOf, type FileIndexStatus } from '../../shared/file-index/types.ts'
import { searchExcludeOf } from '../../shared/search-exclude.ts'
import type { Project } from '../../shared/schema.ts'
import { log } from '../log.ts'
import { IndexUnit, unitKey, type UnitSpec } from './unit.ts'

/** 插件报来的外部根目录（插件接口 16 的 fileIndexRoots） */
export interface PluginRoot {
  root: string
  plugin: string
  exclude?: string[]
}

export interface RegistryDeps {
  getProject: (id: string) => Promise<Project | null | undefined>
  listProjects: () => Promise<Project[]>
  /** 项目外的文档根（P4 / SVN 项目的 ProjectDoc/docs）；没有返回 undefined */
  docRoot: (p: Project) => Promise<string | undefined>
  pluginRoots: (p: Project) => Promise<PluginRoot[]>
  /** 状态变了推给页面 */
  push: (projectId: string, status: FileIndexStatus) => void
}

const IDLE_MS = 30 * 60_000
/** 一个根多久没核对就在查询时后台核对：有系统通知时 10 分钟，没有时 60 秒（设计稿 5.4） */
const STALE_WATCHED_MS = 10 * 60_000
const STALE_UNWATCHED_MS = 60_000

let deps: RegistryDeps | undefined // 模块状态：接线，启动时 initFileIndex 设一次
const units = new Map<string, { unit: IndexUnit; users: Set<string> }>() // 模块状态：缓存，丢了从落盘读回
const projects = new Map<string, { sig: string; keys: string[]; usedAt: number }>() // 模块状态：缓存，丢了重算
let idleTimer: ReturnType<typeof setInterval> | undefined // 模块状态：运行时，进程在就一直在
/** 有订阅（插件盯着某些目录的增删）的项目不按空闲卸下，不然订阅会悄悄失效 */
const pinned = new Map<string, number>() // 模块状态：会话，订阅方自己撤

export function initFileIndex(d: RegistryDeps) {
  deps = d
  idleTimer ??= setInterval(sweepIdle, 5 * 60_000)
  idleTimer.unref?.()
}

/** 这个项目的根清单（按设置算；关着返回空） */
async function specsOf(p: Project): Promise<UnitSpec[]> {
  const s = fileIndexSettingsOf(p)
  if (!s.enabled || !p.path || !deps) return []
  const base = { vcsOnly: s.vcsOnly, watch: s.watch }
  const exclude = searchExcludeOf(p)
  const out: UnitSpec[] = [{ root: p.path, source: 'project', exclude, ...base }]
  const doc = await deps.docRoot(p).catch(() => undefined)
  if (doc) out.push({ root: doc, source: 'doc', exclude, ...base, vcsOnly: false })
  for (const r of s.extraRoots)
    out.push({ root: path.resolve(p.path, r), source: 'extra', exclude, ...base, vcsOnly: false })
  if (s.pluginRoots)
    for (const r of await deps.pluginRoots(p).catch(() => [] as PluginRoot[]))
      out.push({ root: r.root, source: `plugin:${r.plugin}`, exclude: r.exclude ?? exclude, ...base, vcsOnly: false })
  // 同一个根只留第一个；落在项目目录里面的额外目录不另建（项目那份已经包含）
  const seen: string[] = []
  return out.filter((x) => {
    const r = path.resolve(x.root)
    if (
      seen.some((s0) => r === s0 || (!path.relative(s0, r).startsWith('..') && !path.isAbsolute(path.relative(s0, r))))
    )
      return false
    seen.push(r)
    return true
  })
}

/** 取这个项目的索引（开着才有）：按现在的设置对上根清单 */
export async function projectIndex(projectId: string): Promise<ProjectIndex | undefined> {
  if (!deps) return undefined
  const p = await deps.getProject(projectId)
  if (!p) {
    release(projectId)
    return undefined
  }
  const specs = await specsOf(p)
  const sig = JSON.stringify(specs)
  const cur = projects.get(projectId)
  if (!cur || cur.sig !== sig) {
    release(projectId)
    const keys: string[] = []
    for (const spec of specs) {
      const key = unitKey(spec)
      const had = units.get(key)
      if (had) had.users.add(projectId)
      else units.set(key, { unit: new IndexUnit(spec, () => pushStatus(key)), users: new Set([projectId]) })
      keys.push(key)
    }
    projects.set(projectId, { sig, keys, usedAt: Date.now() })
  }
  const entry = projects.get(projectId)!
  entry.usedAt = Date.now()
  if (!entry.keys.length) return undefined
  return new ProjectIndex(
    projectId,
    p.path,
    entry.keys.map((k) => units.get(k)!.unit),
  )
}

/** 项目不用了（删了、关了开关、设置变了）：没人用的根停掉 */
function release(projectId: string) {
  const cur = projects.get(projectId)
  if (!cur) return
  projects.delete(projectId)
  for (const k of cur.keys) {
    const u = units.get(k)
    if (!u) continue
    u.users.delete(projectId)
    if (!u.users.size) {
      u.unit.close()
      units.delete(k)
    }
  }
}

function sweepIdle() {
  const now = Date.now()
  for (const [id, p] of projects) if (now - p.usedAt > IDLE_MS && !pinned.get(id)) release(id)
}

const pushTimers = new Map<string, ReturnType<typeof setTimeout>>() // 模块状态：运行时，300 毫秒后自己清掉
/** 状态推给页面：同一个项目 300 毫秒内只推一次（建立进度一秒好几下） */
function pushStatus(key: string) {
  const u = units.get(key)
  if (!u || !deps) return
  for (const pid of u.users) {
    if (pushTimers.has(pid)) continue
    pushTimers.set(
      pid,
      setTimeout(() => {
        pushTimers.delete(pid)
        void statusOf(pid).then((s) => s && deps!.push(pid, s))
      }, 300),
    )
  }
}

/** 项目的状态（关着也回一份，enabled = false） */
export async function statusOf(projectId: string): Promise<FileIndexStatus | undefined> {
  if (!deps) return undefined
  const p = await deps.getProject(projectId)
  if (!p) return undefined
  const idx = await projectIndex(projectId)
  const roots = idx?.units.map((u) => u.status()) ?? []
  const pick = (s: string) => roots.some((r) => r.state === s)
  return {
    projectId,
    enabled: fileIndexSettingsOf(p).enabled,
    state: !idx
      ? 'off'
      : pick('error') && roots[0]?.state === 'error'
        ? 'error'
        : pick('building')
          ? 'building'
          : pick('verifying')
            ? 'verifying'
            : 'ready',
    files: roots.reduce((a, r) => a + r.files, 0),
    dirs: roots.reduce((a, r) => a + r.dirs, 0),
    bytes: roots.reduce((a, r) => a + r.bytes, 0),
    roots,
  }
}

/** 包含这个绝对路径的项目（最深的那个）；文档根、额外目录也算 */
export async function projectOfDir(abs: string): Promise<string | undefined> {
  if (!deps) return undefined
  const target = path.resolve(abs)
  const inside = (root: string) => {
    const r = path.relative(path.resolve(root), target)
    return !r.startsWith('..') && !path.isAbsolute(r)
  }
  const list = (await deps.listProjects()).filter((p) => p.path && fileIndexSettingsOf(p).enabled)
  const own = list.filter((p) => inside(p.path)).sort((a, b) => b.path.length - a.path.length)[0]
  if (own) return own.id
  // 项目外的根（文档根、引擎目录）：只看已经加载的
  for (const [id, e] of projects) if (e.keys.some((k) => units.get(k)?.unit.covers(target))) return id
  return undefined
}

/** 在用的索引单元（数据页、删除时用） */
export function liveUnits() {
  return [...units.values()].map((u) => ({ unit: u.unit, users: [...u.users] }))
}

/** 删掉一份落盘的索引：在用的先停掉，用它的项目下次用到时重建 */
export async function dropUnit(key: string) {
  const u = units.get(key)
  if (u) {
    await u.unit.drop()
    units.delete(key)
    for (const pid of u.users) projects.delete(pid)
  }
}

/** 全部停掉（清理全部索引时） */
export function closeAll() {
  for (const u of units.values()) u.unit.close()
  units.clear()
  projects.clear()
}

/** 面板自己写了文件（文件面板、Agent 的改文件工具、插件）：所有覆盖这些路径的索引马上重读所在目录 */
export async function touchFiles(absPaths: string[], by: string) {
  const list = absPaths.filter(Boolean)
  if (!list.length) return
  await Promise.all(
    [...units.values()].map(async ({ unit }) => {
      const mine = list.filter((p) => unit.covers(p))
      if (mine.length) await unit.touch(mine, by).catch((e) => log.warn('file-index', '更新索引出错', e))
    }),
  )
}

export interface FindResultItem {
  /** 项目目录里的相对项目根，其他根的用绝对路径；都用 / */
  path: string
  abs: string
  score: number
}

/**
 * 一个项目的索引（几个根合起来）。路径约定：项目目录里的用相对项目根的写法，其他根用绝对路径，都用 / 分隔
 */
export class ProjectIndex {
  readonly projectId: string
  readonly projectPath: string
  readonly units: IndexUnit[]
  constructor(projectId: string, projectPath: string, units: IndexUnit[]) {
    this.projectId = projectId
    this.projectPath = projectPath
    this.units = units
  }

  /** 都可查了（第一次建好）；timeoutMs 到了还没好返回 false */
  async ready(timeoutMs = Infinity) {
    const r = await Promise.all(this.units.map((u) => u.ready(timeoutMs)))
    return r.every(Boolean)
  }

  get building() {
    return this.units.some((u) => u.state === 'building')
  }

  /** 多久以前核对过（最旧的那个根） */
  ageMs() {
    const at = Math.min(...this.units.map((u) => u.verifiedAt ?? u.changedAt ?? 0))
    return at ? Date.now() - at : undefined
  }

  /** 查询前看看是不是太久没核对了：是就后台核对（这次照常用现在的回答） */
  private freshen() {
    for (const u of this.units) {
      if (u.state !== 'ready') continue
      const limit = u.status().watching === 'system' ? STALE_WATCHED_MS : STALE_UNWATCHED_MS
      if (Date.now() - (u.verifiedAt ?? 0) > limit) void u.verify({ by: 'verify' })
    }
  }

  private show(u: IndexUnit, rel: string) {
    const abs = path.join(u.root, rel)
    const inProject = path.relative(this.projectPath, abs)
    const shown =
      u.spec.source === 'project' || (!inProject.startsWith('..') && !path.isAbsolute(inProject))
        ? inProject.split(path.sep).join('/')
        : abs.split(path.sep).join('/')
    return { shown, abs }
  }

  /** 把调用方给的目录（相对项目根或绝对）对到某个根上 */
  private locate(dir: string): { unit: IndexUnit; rel: string } | undefined {
    const abs = path.isAbsolute(dir) ? path.resolve(dir) : path.resolve(this.projectPath, dir || '.')
    // 最深的那个根优先（项目目录里面不会再有别的根，见 specsOf）
    const hit = this.units.filter((u) => u.covers(abs)).sort((a, b) => b.root.length - a.root.length)[0]
    return hit ? { unit: hit, rel: hit.relOf(abs) } : undefined
  }

  find(
    q: string,
    opts: { under?: string[]; ext?: string[]; dirs?: boolean; cap?: number; roots?: 'project' | 'all' } = {},
  ) {
    this.freshen()
    const out: FindResultItem[] = []
    const scopes = opts.under?.length ? opts.under.map((d) => this.locate(d)).filter((x) => !!x) : undefined
    for (const u of this.units) {
      if (!scopes && opts.roots === 'project' && u.spec.source !== 'project') continue
      const under = scopes ? scopes.filter((s) => s.unit === u).map((s) => s.rel) : undefined
      if (scopes && !under!.length) continue
      for (const h of u.find(q, { under, ext: opts.ext, dirs: opts.dirs, cap: opts.cap })) {
        const { shown, abs } = this.show(u, h.path)
        // 外部根（引擎）排在项目自己的文件后面
        out.push({ path: shown, abs, score: h.score + (u.spec.source === 'project' ? 0 : 3) })
      }
    }
    return out.sort((a, b) => a.score - b.score || a.path.length - b.path.length)
  }

  async list(dir: string, opts: { recursive?: boolean; ext?: string[] } = {}) {
    const at = this.locate(dir)
    if (!at) return undefined
    const r = await at.unit.list(at.rel, !!opts.recursive, opts.ext)
    if (!r) return undefined
    return {
      files: r.files.map((f) => this.show(at.unit, f).shown),
      dirs: r.dirs.map((d) => this.show(at.unit, d).shown),
    }
  }

  /** 按通配一次拿全：patterns 相对 dir（相对项目根或绝对）；返回绝对路径 */
  glob(dir: string, patterns: string[]): string[] {
    const at = this.locate(dir)
    if (!at) return []
    const pre = at.rel ? `${at.rel}/` : ''
    return at.unit.glob(patterns.map((p) => pre + p.replace(/^\.?\/+/, ''))).map((f) => at.unit.absOf(f))
  }

  has(p: string) {
    const at = this.locate(p)
    return at ? at.unit.has(at.rel) : undefined
  }

  /** 核对（Agent 的 refresh、「增量更新」按钮）：dir 给了只核对那棵子树 */
  async refresh(dir?: string) {
    if (dir) {
      const at = this.locate(dir)
      if (!at) return { checked: 0, added: 0, removed: 0 }
      return at.unit.verify({ under: at.rel, by: 'agent' })
    }
    const rs = await Promise.all(this.units.map((u) => u.verify({ by: 'agent' })))
    return rs.reduce(
      (a, r) => ({ checked: a.checked + r.checked, added: a.added + r.added, removed: a.removed + r.removed }),
      {
        checked: 0,
        added: 0,
        removed: 0,
      },
    )
  }

  async rebuild() {
    await Promise.all(this.units.map((u) => u.build()))
  }

  /** 订阅一组目录（绝对路径）下的文件增删；回调拿到的是绝对路径 */
  onChange(dirs: string[], cb: (d: { added: string[]; removed: string[] }) => void) {
    const offs = this.units.map((u) =>
      u.onDelta((delta) => {
        const pick = (list: string[]) =>
          list
            .map((rel) => u.absOf(rel))
            .filter((abs) => !dirs.length || dirs.some((d) => !path.relative(d, abs).startsWith('..')))
        const added = pick(delta.added)
        const removed = pick(delta.removed)
        if (added.length || removed.length) cb({ added, removed })
      }),
    )
    pinned.set(this.projectId, (pinned.get(this.projectId) ?? 0) + 1)
    let off = false
    return () => {
      if (off) return
      off = true
      offs.forEach((f) => f())
      const n = (pinned.get(this.projectId) ?? 1) - 1
      if (n > 0) pinned.set(this.projectId, n)
      else pinned.delete(this.projectId)
    }
  }
}
