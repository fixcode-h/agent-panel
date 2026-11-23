/**
 * 一个根目录的文件名索引（内存结构）：目录表 + 每个目录的文件名。服务端和演示后端用同一份。
 *
 * 为什么这样放：按文件夹取（list）是一次 Map 查找；按名字找（find）对每个目录的「小写文件名拼接串」做 indexOf，
 * 19.5 万文件实测 1–5 毫秒；某个目录有增删只换这一个目录的那一段，不用重拼整份。
 * 不存文件的大小和修改时间：要的地方对查出来的那几个自己 stat（设计稿 3.1）
 */

export interface DirRec {
  /** 相对根目录的路径，/ 分隔；根目录是空串 */
  rel: string
  /** 读这一层时目录自己的修改时间（增量核对的依据） */
  mtime: number
  /** 直接子文件名，排好序 */
  files: string[]
  /** 直接子目录名（已收录的，跳过的不在里面） */
  subdirs: string[]
  /** 小写的文件名拼接串和每个名字的起点（查询用，懒建） */
  low?: string
  starts?: Int32Array
}

export interface TableDelta {
  added: string[]
  removed: string[]
}

/** 查询选项 */
export interface FindOpts {
  /** 只要这些目录下的（相对根目录，/ 分隔） */
  under?: string[]
  /** 只要这些扩展名（带不带点都行） */
  ext?: string[]
  /** 也匹配目录名 */
  dirs?: boolean
  /** 最多收这么多个候选再排序（防止一个字母命中几十万个） */
  cap?: number
}

export interface FindHit {
  path: string
  /** 0 文件名开头命中、1 文件名里命中、2 路径里命中 */
  score: number
}

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name)
const parentOf = (rel: string) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '')
const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** 查询词拆开：普通词按子串、带 * ? 的按通配；都按小写比 */
interface Token {
  text: string
  re?: RegExp
}
function tokens(q: string): Token[] {
  return q
    .trim()
    .toLowerCase()
    .replace(/\\/g, '/')
    .split(/\s+/)
    .filter(Boolean)
    .map((text) => {
      if (!/[*?]/.test(text)) return { text }
      let re = ''
      for (let i = 0; i < text.length; i++) {
        const ch = text[i]
        if (ch === '*' && text[i + 1] === '*') {
          re += '.*'
          i++
        } else if (ch === '*') re += text.includes('/') ? '[^/]*' : '.*'
        else if (ch === '?') re += '.'
        else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
      }
      // 带斜杠的按整条路径（尾部对齐），不带的按文件名整名匹配
      return { text, re: new RegExp(text.includes('/') ? `(^|/)${re}$` : `^${re}$`) }
    })
}

export class NameTable {
  private dirs = new Map<string, DirRec>()
  private fileCount = 0

  get size() {
    return { files: this.fileCount, dirs: this.dirs.size }
  }

  has(rel: string): 'file' | 'dir' | undefined {
    const r = rel.replace(/\/+$/, '')
    if (this.dirs.has(r)) return 'dir'
    const d = this.dirs.get(parentOf(r))
    const name = r.slice(r.lastIndexOf('/') + 1)
    return d && binHas(d.files, name) ? 'file' : undefined
  }

  dir(rel: string): DirRec | undefined {
    return this.dirs.get(rel.replace(/^\.?\/+|\/+$/g, ''))
  }

  /** 全部目录（落盘、核对用） */
  allDirs(): IterableIterator<DirRec> {
    return this.dirs.values()
  }

  /**
   * 放进（或换掉）一个目录这一层的内容，返回这一层的文件增删；子目录少了的整棵删掉（删掉的文件也算进 removed）。
   * 新出现的子目录不在这里读：调用方接着对它们调 setDir
   */
  setDir(rel: string, mtime: number, files: string[], subdirs: string[]): TableDelta & { newDirs: string[] } {
    const old = this.dirs.get(rel)
    const sortedFiles = [...files].sort(byName)
    const sortedDirs = [...subdirs].sort(byName)
    const delta: TableDelta & { newDirs: string[] } = { added: [], removed: [], newDirs: [] }
    if (old) {
      const before = new Set(old.files)
      const after = new Set(sortedFiles)
      for (const f of sortedFiles) if (!before.has(f)) delta.added.push(join(rel, f))
      for (const f of old.files) if (!after.has(f)) delta.removed.push(join(rel, f))
      const keep = new Set(sortedDirs)
      for (const d of old.subdirs) if (!keep.has(d)) this.dropTree(join(rel, d), delta.removed)
      const had = new Set(old.subdirs)
      for (const d of sortedDirs) if (!had.has(d) || !this.dirs.has(join(rel, d))) delta.newDirs.push(join(rel, d))
      this.fileCount += sortedFiles.length - old.files.length
    } else {
      for (const f of sortedFiles) delta.added.push(join(rel, f))
      for (const d of sortedDirs) if (!this.dirs.has(join(rel, d))) delta.newDirs.push(join(rel, d))
      this.fileCount += sortedFiles.length
      // 挂到父目录上（父目录读的时候还没有它，比如插件报来的新目录）
      const parent = rel ? this.dirs.get(parentOf(rel)) : undefined
      const name = rel.slice(rel.lastIndexOf('/') + 1)
      if (parent && !binHas(parent.subdirs, name)) parent.subdirs = [...parent.subdirs, name].sort(byName)
    }
    this.dirs.set(rel, { rel, mtime, files: sortedFiles, subdirs: sortedDirs })
    return delta
  }

  /** 删掉一个目录和它下面的全部（目录没了、或改成被排除了） */
  removeDir(rel: string): string[] {
    const removed: string[] = []
    this.dropTree(rel, removed)
    const parent = this.dirs.get(parentOf(rel))
    const name = rel.slice(rel.lastIndexOf('/') + 1)
    if (parent && rel) parent.subdirs = parent.subdirs.filter((d) => d !== name)
    return removed
  }

  private dropTree(rel: string, out: string[]) {
    const d = this.dirs.get(rel)
    if (!d) return
    for (const f of d.files) out.push(join(rel, f))
    for (const s of d.subdirs) this.dropTree(join(rel, s), out)
    this.fileCount -= d.files.length
    this.dirs.delete(rel)
  }

  /** 按文件夹取：一层（文件和子目录名），或整棵子树的文件 */
  list(rel: string, recursive: boolean, ext?: string[]): { files: string[]; dirs: string[] } | undefined {
    const root = this.dir(rel)
    if (!root) return undefined
    const exts = normExt(ext)
    const okExt = (n: string) => !exts || exts.some((e) => n.toLowerCase().endsWith(e))
    if (!recursive)
      return {
        files: root.files.filter(okExt).map((f) => join(root.rel, f)),
        dirs: root.subdirs.map((d) => join(root.rel, d)),
      }
    const files: string[] = []
    const dirs: string[] = []
    const walk = (d: DirRec) => {
      for (const f of d.files) if (okExt(f)) files.push(join(d.rel, f))
      for (const s of d.subdirs) {
        const kid = this.dirs.get(join(d.rel, s))
        if (!kid) continue
        dirs.push(kid.rel)
        walk(kid)
      }
    }
    walk(root)
    return { files, dirs }
  }

  /** 按名字找：所有词都要命中（相对根目录的整条路径，小写比） */
  find(q: string, opts: FindOpts = {}): FindHit[] {
    const toks = tokens(q)
    if (!toks.length) return []
    const exts = normExt(opts.ext)
    const under = (opts.under ?? []).map((u) =>
      u
        .replace(/\\/g, '/')
        .replace(/^\.?\/+|\/+$/g, '')
        .toLowerCase(),
    )
    const cap = opts.cap ?? 20000
    const lits = toks.filter((t) => !t.re).sort((a, b) => b.text.length - a.text.length)
    // 文件名里找的那个词：最长的普通词（不含斜杠的）；没有普通词时逐个文件比通配
    const needle = lits.find((t) => !t.text.includes('/'))?.text
    const first = toks[0]
    const out: FindHit[] = []
    const score = (full: string, base: string) => {
      for (const t of toks) {
        if (t.re ? !t.re.test(t.text.includes('/') ? full : base) : !full.includes(t.text)) return -1
      }
      if (first.re) return 1
      return base.startsWith(first.text) ? 0 : base.includes(first.text) ? 1 : 2
    }
    for (const d of this.dirs.values()) {
      if (out.length >= cap) break
      const dirLow = d.rel.toLowerCase()
      if (under.length && !under.some((u) => !u || dirLow === u || dirLow.startsWith(`${u}/`))) continue
      const prefix = dirLow ? `${dirLow}/` : ''
      if (opts.dirs && d.rel) {
        const base = dirLow.slice(dirLow.lastIndexOf('/') + 1)
        const s = score(dirLow, base)
        if (s >= 0) out.push({ path: `${d.rel}/`, score: s })
      }
      if (!d.files.length) continue
      // 路径里已经有这个词：这一层的文件都是候选；否则只看文件名里有它的那几个
      let idx: Iterable<number>
      if (!needle || prefix.includes(needle)) idx = d.files.keys()
      else {
        if (d.low === undefined) {
          d.starts = new Int32Array(d.files.length)
          let at = 0
          d.files.forEach((f, i) => {
            d.starts![i] = at
            at += f.length + 1
          })
          d.low = d.files.join('\n').toLowerCase()
          // 个别字小写后长度会变（土耳其语 İ）：对不上就不用快路径
          if (d.low.length !== at - 1) d.low = ''
        }
        if (!d.low) idx = d.files.keys()
        else {
          const hits = new Set<number>()
          for (let at = d.low.indexOf(needle); at >= 0; at = d.low.indexOf(needle, at + 1))
            hits.add(binFloor(d.starts!, at))
          idx = hits
        }
      }
      for (const i of idx) {
        const name = d.files[i]
        const base = name.toLowerCase()
        if (exts && !exts.some((e) => base.endsWith(e))) continue
        const s = score(prefix + base, base)
        if (s >= 0) out.push({ path: join(d.rel, name), score: s })
        if (out.length >= cap) break
      }
    }
    out.sort((a, b) => a.score - b.score || a.path.length - b.path.length || (a.path < b.path ? -1 : 1))
    return out
  }

  /** 按通配一次拿全（相对根目录）：插件扫描用，代替各自写的遍历 */
  glob(patterns: string[]): string[] {
    const res = patterns.map((p) => toPathRe(p))
    const out: string[] = []
    for (const d of this.dirs.values())
      for (const f of d.files) {
        const full = join(d.rel, f)
        if (res.some((re) => re.test(full))) out.push(full)
      }
    return out.sort(byName)
  }

  // ---------- 落盘（文本：一行一个目录 `mtime\t相对路径\t文件名\0文件名…\t子目录\0子目录…`） ----------

  toLines(): string[] {
    const out: string[] = []
    for (const d of this.dirs.values()) out.push(`${d.mtime}\t${d.rel}\t${d.files.join('\0')}\t${d.subdirs.join('\0')}`)
    return out
  }

  static fromLines(lines: string[]): NameTable {
    const t = new NameTable()
    for (const line of lines) {
      if (!line) continue
      const [m, rel, files, subdirs] = line.split('\t')
      const fl = files ? files.split('\0') : []
      t.dirs.set(rel, { rel, mtime: Number(m) || 0, files: fl, subdirs: subdirs ? subdirs.split('\0') : [] })
      t.fileCount += fl.length
    }
    return t
  }
}

function normExt(ext: string[] | undefined) {
  const list = (ext ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean)
  return list.length ? list.map((e) => (e.startsWith('.') ? e : `.${e}`)) : undefined
}

/** 通配（相对根目录的整条路径）→ 正则：`**` 跨层，`*` 不跨层；不带斜杠的按文件名比 */
export function toPathRe(glob: string): RegExp {
  const g = glob
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.?\/+/, '')
  let re = ''
  for (let i = 0; i < g.length; i++) {
    const ch = g[i]
    if (ch === '*' && g[i + 1] === '*') {
      if (g[i + 2] === '/') {
        re += '(?:.*/)?'
        i += 2
      } else {
        re += '.*'
        i++
      }
    } else if (ch === '*') re += '[^/]*'
    else if (ch === '?') re += '[^/]'
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(g.includes('/') ? `^${re}$` : `(^|/)${re}$`, 'i')
}

function binHas(arr: string[], x: string) {
  let lo = 0
  let hi = arr.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid] === x) return true
    if (arr[mid] < x) lo = mid + 1
    else hi = mid - 1
  }
  return false
}

/** starts 里不大于 at 的最后一个下标 */
function binFloor(starts: Int32Array, at: number) {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= at) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** 从一串相对路径（/ 分隔）建表：演示版和单测用，正式版从磁盘一层层读 */
export function tableFromPaths(paths: string[], mtime = 0): NameTable {
  const dirs = new Map<string, { files: string[]; subdirs: Set<string> }>([['', { files: [], subdirs: new Set() }]])
  const ensure = (rel: string) => {
    let d = dirs.get(rel)
    if (d) return d
    d = { files: [], subdirs: new Set() }
    dirs.set(rel, d)
    const cut = rel.lastIndexOf('/')
    ensure(cut < 0 ? '' : rel.slice(0, cut)).subdirs.add(cut < 0 ? rel : rel.slice(cut + 1))
    return d
  }
  for (const p of paths) {
    const cut = p.lastIndexOf('/')
    ensure(cut < 0 ? '' : p.slice(0, cut)).files.push(cut < 0 ? p : p.slice(cut + 1))
  }
  const t = new NameTable()
  for (const [rel, d] of dirs) t.setDir(rel, mtime, d.files, [...d.subdirs])
  return t
}
