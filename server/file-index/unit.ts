/**
 * 一份文件索引（一个根目录 + 一套规则）：建、读回、增量（面板自己写的 touch、系统通知、核对）、查询、落盘。
 * 几个项目共用同一个根（同一个引擎目录、同一个文档根）时共用一份。按项目管理在 registry.ts
 */
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { NameTable, type FindHit, type FindOpts, type TableDelta } from '../../shared/file-index/table.ts'
import { ruleKey, skipDir, skipRule, type SkipRule } from '../../shared/file-index/rules.ts'
import type { FileIndexRootStatus, FileIndexState, FileIndexWatch } from '../../shared/file-index/types.ts'
import { detectVcs } from '../projects-analyze.ts'
import { log } from '../log.ts'
import { dropIndex, indexKey, loadIndex, saveIndex, type IndexHead } from './store.ts'
import { gitCheckIgnore, gitIgnored, p4HaveChange, trackedFiles } from './vcs.ts'
import { joinRel, readLevel, readTree, verifyTree, type ExtraSkip } from './walk.ts'
import { watchOn, watchTree, type TreeWatch } from './watch.ts'

export interface UnitSpec {
  root: string
  /** project / doc / extra / plugin:<id> */
  source: string
  exclude: string[]
  vcsOnly: boolean
  watch: FileIndexWatch
}

/** 有增删后多久写一次盘 */
const SAVE_DELAY_MS = 30_000
/** P4 多久问一次「sync 到哪了」 */
const P4_PROBE_MS = 5 * 60_000

const rulesOf = (spec: UnitSpec) => ruleKey(spec.exclude, spec.vcsOnly ? 'vcs' : 'disk')
/** 不用建出来就知道它的键（几个项目共用同一个根时，第二个项目不再新建一份） */
export const unitKey = (spec: UnitSpec) => indexKey(path.resolve(spec.root), rulesOf(spec))

export type DeltaListener = (d: TableDelta, by: string) => void

/** Windows、macOS 的文件系统默认不分大小写 */
const CI = process.platform === 'win32' || process.platform === 'darwin'

export class IndexUnit {
  readonly key: string
  readonly root: string
  readonly rules: string
  private rule: SkipRule
  table = new NameTable()
  state: FileIndexState = 'building'
  vcs: 'git' | 'p4' | 'svn' | 'none' = 'none'
  error?: string
  bytes = 0
  builtAt?: number
  buildMs?: number
  changedAt?: number
  verifiedAt?: number
  lastBy?: string
  progress?: { dirs: number; files: number; expect?: number }
  private ignored?: Set<string>
  private p4Change?: string
  private p4At = 0
  private watcher?: TreeWatch
  private first: Promise<void>
  private running?: Promise<unknown>
  private saveTimer?: ReturnType<typeof setTimeout>
  private listeners = new Set<DeltaListener>()
  private onStatus: () => void

  readonly spec: UnitSpec
  constructor(spec: UnitSpec, onStatus: () => void) {
    this.spec = spec
    this.root = path.resolve(spec.root)
    this.rules = rulesOf(spec)
    this.key = indexKey(this.root, this.rules)
    this.rule = skipRule(spec.exclude, CI)
    this.onStatus = onStatus
    this.first = this.open()
  }

  /** 第一次可查（读回落盘或第一次建好）；timeoutMs 到了还没好返回 false */
  async ready(timeoutMs = Infinity): Promise<boolean> {
    if (this.state !== 'building') return true
    if (!Number.isFinite(timeoutMs)) {
      await this.first
      return true
    }
    let t: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<boolean>((r) => (t = setTimeout(() => r(false), timeoutMs)))
    const ok = await Promise.race([this.first.then(() => true), late])
    clearTimeout(t)
    return ok
  }

  status(): FileIndexRootStatus {
    const size = this.table.size
    return {
      key: this.key,
      root: this.root.split(path.sep).join('/'),
      source: this.spec.source,
      vcs: this.vcs,
      state: this.state,
      files: size.files,
      dirs: size.dirs,
      bytes: this.bytes,
      ...(this.state === 'building' && this.progress ? { progress: this.progress } : {}),
      ...(this.builtAt ? { builtAt: this.builtAt } : {}),
      ...(this.buildMs !== undefined ? { buildMs: this.buildMs } : {}),
      ...(this.changedAt ? { changedAt: this.changedAt } : {}),
      ...(this.verifiedAt ? { verifiedAt: this.verifiedAt } : {}),
      ...(this.lastBy ? { lastBy: this.lastBy } : {}),
      watching: this.watcher ? 'system' : 'none',
      ...(this.error ? { error: this.error } : {}),
    }
  }

  onDelta(cb: DeltaListener) {
    this.listeners.add(cb)
    return () => void this.listeners.delete(cb)
  }

  // ---------- 生命周期 ----------

  private async open() {
    const st = await stat(this.root).catch(() => null)
    if (!st?.isDirectory()) {
      this.fail(`目录不存在或读不到：${this.root}`)
      return
    }
    this.vcs = (await detectVcs(this.root).catch(() => ({ vcs: 'none' as const }))).vcs
    const saved = await loadIndex(this.key, { root: this.root, rules: this.rules }).catch(() => undefined)
    if (saved) {
      this.table = saved.table
      this.bytes = saved.bytes
      this.applyHead(saved.head)
      this.state = 'ready'
      this.startWatch()
      this.onStatus()
      // 读回来的可能是几天前的：后台核对一遍（核对期间照常回答）
      void this.verify({ by: 'verify' })
      return
    }
    await this.build()
  }

  private applyHead(h: IndexHead) {
    this.builtAt = h.builtAt
    this.buildMs = h.buildMs
    this.changedAt = h.changedAt
    this.verifiedAt = h.verifiedAt
    this.p4Change = h.p4Change
  }

  private fail(why: string) {
    this.state = 'error'
    this.error = why
    this.onStatus()
  }

  /** 全量建（设计稿 5.5）：另建一份，建好原子换上；建的时候旧的照常回答 */
  build(): Promise<void> {
    const run = (async () => {
      const t0 = Date.now()
      // 第一次建（手里没有能用的）直接往当前表里读：边读边能查，建立中查找也能先回读到的部分；
      // 已经有能用的就另建一份、建好再换上，建的时候旧的照常回答
      const firstTime = this.state !== 'ready' && this.state !== 'verifying'
      const fresh = firstTime ? (this.table = new NameTable()) : new NameTable()
      const expect = this.table.size.dirs || undefined
      if (firstTime) this.state = 'building'
      this.progress = { dirs: 0, files: 0, ...(expect ? { expect } : {}) }
      this.onStatus()
      try {
        if (this.spec.vcsOnly && (this.vcs === 'git' || this.vcs === 'p4')) await this.buildTracked(fresh)
        else {
          this.ignored = this.vcs === 'git' ? await gitIgnored(this.root).catch(() => undefined) : undefined
          let last = 0
          await readTree(fresh, this.root, this.rule, {
            extra: this.extraSkip(),
            onProgress: (dirs, files) => {
              this.progress = { dirs, files, ...(expect ? { expect } : {}) }
              if (Date.now() - last > 300) {
                last = Date.now()
                this.onStatus()
              }
            },
          })
        }
      } catch (e) {
        this.fail(`建索引出错：${(e as Error).message}`)
        return
      }
      this.table = fresh
      this.builtAt = this.verifiedAt = this.changedAt = Date.now()
      this.buildMs = Date.now() - t0
      if (this.vcs === 'p4') this.p4Change = await p4HaveChange(this.root).catch(() => undefined)
      this.state = 'ready'
      this.error = undefined
      this.progress = undefined
      this.lastBy = 'build'
      log.info('file-index', `建好文件索引 ${this.root}`, { ...this.table.size, ms: this.buildMs })
      this.startWatch()
      await this.save()
      this.onStatus()
    })()
    this.running = run
    return run
  }

  /** 「只收版本管理里的」：按 ls-files / p4 have 的清单建（目录修改时间记 0，核对时按版本管理重新取） */
  private async buildTracked(t: NameTable) {
    const files = await trackedFiles(this.root, this.vcs)
    if (!files) throw new Error(this.vcs === 'p4' ? 'p4 have 没有成功（连不上服务器？）' : 'git ls-files 没有成功')
    const byDir = new Map<string, { files: string[]; subdirs: Set<string> }>()
    const ensure = (rel: string) => {
      let d = byDir.get(rel)
      if (!d) {
        d = { files: [], subdirs: new Set() }
        byDir.set(rel, d)
        if (rel) {
          const cut = rel.lastIndexOf('/')
          ensure(cut >= 0 ? rel.slice(0, cut) : '').subdirs.add(rel.slice(cut + 1))
        }
      }
      return d
    }
    ensure('')
    for (const f of files) {
      const cut = f.lastIndexOf('/')
      const dir = cut >= 0 ? f.slice(0, cut) : ''
      // 排除目录照样生效（版本管理里提交了 Binaries 的项目也不收它）
      if (dir && dir.split('/').some((seg, i, a) => skipDir(this.rule, seg, a.slice(0, i + 1).join('/')))) continue
      ensure(dir).files.push(f.slice(cut + 1))
    }
    for (const [rel, d] of byDir) t.setDir(rel, 0, d.files, [...d.subdirs])
  }

  private extraSkip(): ExtraSkip | undefined {
    const ign = this.ignored
    if (!ign?.size) return undefined
    return (rel, isDir) => ign.has(isDir ? `${rel}/` : rel)
  }

  private startWatch() {
    if (this.watcher || !watchOn(this.spec.watch)) return
    this.watcher = watchTree(
      this.root,
      (dirs) => void this.refreshDirs([...dirs], 'watch'),
      (why) => {
        log.warn('file-index', `监听出问题，整体核对一遍：${this.root}`, why)
        void this.verify({ by: 'verify' })
      },
      (rel) => this.skipped(rel),
    )
    if (this.watcher) this.onStatus()
  }

  /** 路径落在排除目录里（任意一层） */
  private skipped(rel: string) {
    const segs = rel.split('/')
    for (let i = 0; i < segs.length - 1; i++)
      if (skipDir(this.rule, segs[i], segs.slice(0, i + 1).join('/'))) return true
    return false
  }

  close() {
    this.watcher?.close()
    this.watcher = undefined
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = undefined
      void this.save()
    }
  }

  async drop() {
    this.close()
    this.table = new NameTable()
    this.bytes = 0
    await dropIndex(this.key)
  }

  // ---------- 增量 ----------

  /** 一批目录重读（系统通知、面板自己写了文件）；不在表里的往上找到在表里的那层再读 */
  async refreshDirs(rels: string[], by: string) {
    if (this.state === 'building' || this.state === 'error') return
    if (this.spec.vcsOnly && this.vcs !== 'none' && this.vcs !== 'svn') return
    const start = new Set<string>()
    for (const r0 of rels) {
      let r = r0.replace(/^\/+|\/+$/g, '')
      if (this.skipped(`${r}/x`)) continue
      while (r && !this.table.dir(r)) r = r.includes('/') ? r.slice(0, r.lastIndexOf('/')) : ''
      start.add(r)
    }
    if (!start.size) return
    const delta = await readTree(this.table, this.root, this.rule, { start: [...start], extra: this.extraSkip() })
    await this.settle(delta, by)
  }

  /** 面板 / Agent / 插件写了这些文件（绝对路径或相对根目录）：同步重读所在目录，返回时索引已经是新的 */
  async touch(paths: string[], by: string) {
    const rels: string[] = []
    for (const p of paths) {
      const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(this.root, p)
      const rel = path.relative(this.root, abs)
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue
      const r = rel.split(path.sep).join('/')
      rels.push(r.includes('/') ? r.slice(0, r.lastIndexOf('/')) : '')
    }
    if (rels.length) await this.refreshDirs(rels, by)
  }

  /** 目录核对（设计稿 5.4）；under 给了只核对这棵子树（按文件夹取时现场核对用） */
  verify(opts: {
    under?: string
    by: string
    limit?: number
  }): Promise<{ checked: number; added: number; removed: number }> {
    const run = (async () => {
      if (this.state === 'building' || this.state === 'error') return { checked: 0, added: 0, removed: 0 }
      if (this.spec.vcsOnly && (this.vcs === 'git' || this.vcs === 'p4')) {
        await this.build()
        return { checked: this.table.size.dirs, added: 0, removed: 0 }
      }
      const whole = !opts.under
      if (whole) {
        this.state = 'verifying'
        this.onStatus()
      }
      // P4：sync 过就强制整体重读（系统通知溢出时漏的也补上）
      let force = false
      if (whole && this.vcs === 'p4' && Date.now() - this.p4At > P4_PROBE_MS) {
        this.p4At = Date.now()
        const now = await p4HaveChange(this.root).catch(() => undefined)
        if (now && this.p4Change && now !== this.p4Change) force = true
        if (now) this.p4Change = now
      }
      const r = await verifyTree(this.table, this.root, this.rule, {
        under: opts.under,
        extra: this.extraSkip(),
        force,
        limit: opts.limit,
      })
      if (whole) {
        this.verifiedAt = Date.now()
        this.state = 'ready'
      }
      await this.settle(r, opts.by)
      if (whole) this.onStatus()
      return { checked: r.checked, added: r.added.length, removed: r.removed.length }
    })()
    if (!opts.under) this.running = run
    return run
  }

  /** 增删落定：Git 里新出现的被忽略的文件去掉、通知订阅方、排写盘 */
  private async settle(delta: TableDelta, by: string) {
    if (this.vcs === 'git' && delta.added.length && !this.spec.vcsOnly) {
      const ign = await gitCheckIgnore(this.root, delta.added).catch(() => new Set<string>())
      if (ign.size) {
        this.ignored ??= new Set()
        for (const f of ign) this.ignored.add(f)
        const dirs = new Set([...ign].map((f) => (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '')))
        for (const d of dirs) {
          const lv = await readLevel(this.root, d, this.rule, this.extraSkip())
          if (lv) this.table.setDir(d, lv.mtime, lv.files, lv.subdirs)
        }
        delta = { added: delta.added.filter((f) => !ign.has(f)), removed: delta.removed }
      }
    }
    if (!delta.added.length && !delta.removed.length) return
    this.changedAt = Date.now()
    this.lastBy = by
    for (const cb of this.listeners) {
      try {
        cb(delta, by)
      } catch (e) {
        log.warn('file-index', '索引变化的订阅方出错', e)
      }
    }
    this.scheduleSave()
    this.onStatus()
  }

  private scheduleSave() {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      void this.save()
    }, SAVE_DELAY_MS)
    this.saveTimer.unref?.()
  }

  private async save() {
    if (this.state === 'error') return
    const size = this.table.size
    this.bytes = await saveIndex(
      this.key,
      {
        format: 1,
        root: this.root,
        vcs: this.vcs,
        rules: this.rules,
        builtAt: this.builtAt ?? Date.now(),
        ...(this.buildMs !== undefined ? { buildMs: this.buildMs } : {}),
        ...(this.changedAt ? { changedAt: this.changedAt } : {}),
        ...(this.verifiedAt ? { verifiedAt: this.verifiedAt } : {}),
        ...(this.p4Change ? { p4Change: this.p4Change } : {}),
        files: size.files,
        dirs: size.dirs,
      },
      this.table,
    ).catch((e) => {
      log.warn('file-index', `文件索引写盘失败：${this.root}`, e)
      return this.bytes
    })
  }

  // ---------- 查询（相对根目录） ----------

  find(q: string, opts?: FindOpts): FindHit[] {
    return this.table.find(q, opts)
  }

  /** 按文件夹取：先现场核对这一层（递归时这棵子树，最多 2000 个目录），结果总是和磁盘一致（设计稿 5.6） */
  async list(rel: string, recursive: boolean, ext?: string[]) {
    const r = rel.replace(/^\.?\/+|\/+$/g, '')
    if (this.state === 'ready' || this.state === 'verifying')
      await this.verify({ under: r, by: 'verify', limit: recursive ? 2000 : 1 })
    return this.table.list(r, recursive, ext)
  }

  glob(patterns: string[]) {
    return this.table.glob(patterns)
  }

  has(rel: string) {
    return this.table.has(rel)
  }

  /** 正在跑的全量或核对（Agent 的 rebuild / refresh 等它） */
  idle() {
    return this.running ?? Promise.resolve()
  }

  /** 这个路径（绝对）在不在这份索引的范围里 */
  covers(abs: string) {
    const rel = path.relative(this.root, path.resolve(abs))
    return !rel.startsWith('..') && !path.isAbsolute(rel) && !this.skipped(`${rel.split(path.sep).join('/')}/x`)
  }

  relOf(abs: string) {
    return path.relative(this.root, path.resolve(abs)).split(path.sep).join('/')
  }

  absOf(rel: string) {
    return path.join(this.root, rel)
  }
}

export { joinRel }
