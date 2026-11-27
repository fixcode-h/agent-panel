/**
 * 不合规范的搜索命令 → 按规范该怎么写的 rg（搜索规范，用户 2026-11-27 定：不合规范的直接退回并告诉怎么写）。
 * 一个程序一个换算函数，登记在 CONVERTERS 里；认不全的参数不硬换，交回一句「该用什么」的说明，
 * 由 Agent 自己按规范重写（宁可让它自己写，也不给出语义不对的命令）
 */
import { quoteArg, type Word } from './words.ts'

/** 拼一条 rg 用的零件 */
export interface RgPlan {
  /** 按内容找（rg -n）还是按名字列文件（rg --files） */
  files: boolean
  flags: string[]
  patterns: string[]
  paths: string[]
  /** -g / --iglob 的值（排除的写成 !x） */
  globs: string[]
  /** 不分大小写匹配文件名（Windows 的 Get-ChildItem、find -iname） */
  iglob?: boolean
}

/** 换不了时：直接给 Agent 看的一句「改用什么」 */
export interface NoPlan {
  hint: string
}

export type Converted = RgPlan | NoPlan

export const isPlan = (c: Converted): c is RgPlan => 'files' in c

export function renderRg(p: RgPlan): string {
  const parts = ['rg', ...(p.files ? ['--files'] : ['-n']), ...p.flags]
  if (!p.files) {
    if (p.patterns.length === 1) parts.push(quoteArg(p.patterns[0]))
    else for (const x of p.patterns) parts.push('-e', quoteArg(x))
  }
  parts.push(...p.paths.map(quoteArg))
  for (const g of p.globs) parts.push(p.iglob && !g.startsWith('!') ? '--iglob' : '-g', quoteArg(g))
  return parts.join(' ')
}

/**
 * grep 的基本正则（不加 -E）里 \| \( \) \{ \} \+ \? 才是元字符、不带反斜杠的是普通字符；rg 正好反过来。
 * 照字面换一遍，模型照着 grep 习惯写的「A\|B」在 rg 里才是「或」
 */
export function breToRg(p: string): string {
  let out = ''
  for (let i = 0; i < p.length; i++) {
    const c = p[i]
    if (c === '\\' && i + 1 < p.length) {
      const n = p[i + 1]
      out += '|(){}+?'.includes(n) ? n : c + n
      i++
    } else out += '|(){}+?'.includes(c) ? `\\${c}` : c
  }
  return out
}

/** 带通配的路径拆成「目录 + 文件名通配」：Source\*.h → Source、*.h */
function splitGlobPath(p: string): { dir: string; glob: string } | undefined {
  const norm = p.replace(/\\/g, '/')
  if (!/[*?]/.test(norm)) return undefined
  const at = norm.lastIndexOf('/')
  const dir = at < 0 ? '' : norm.slice(0, at)
  if (/[*?]/.test(dir))
    return { dir: dir.split(/\/[^/]*[*?]/)[0] || '.', glob: norm.slice(dir.split(/\/[^/]*[*?]/)[0].length + 1) }
  return { dir: dir || '.', glob: norm.slice(at + 1) }
}

function addPath(plan: RgPlan, p: string) {
  const g = splitGlobPath(p)
  if (!g) return plan.paths.push(p)
  if (g.dir !== '.' || plan.paths.length) plan.paths.push(g.dir)
  plan.globs.push(g.glob)
}

const vals = (w: Word[]) => w.map((x) => x.v)

/** grep / egrep / fgrep：-r 去掉（rg 默认递归），--include 换成 -g，基本正则换成 rg 的写法 */
function grepToRg(args: Word[], head: string): Converted {
  const plan: RgPlan = { files: false, flags: [], patterns: [], paths: [], globs: [] }
  let mode = head === 'egrep' ? 'E' : head === 'fgrep' ? 'F' : 'G'
  const rest: string[] = []
  const a = vals(args)
  for (let i = 0; i < a.length; i++) {
    const w = a[i]
    const long = /^--([\w-]+)(?:=(.*))?$/.exec(w)
    if (long) {
      const [, name, inline] = long
      const val = () => inline ?? a[++i] ?? ''
      if (name === 'include') plan.globs.push(val())
      else if (name === 'exclude') plan.globs.push(`!${val()}`)
      else if (name === 'exclude-dir') plan.globs.push(`!${val()}/`)
      else if (name === 'regexp') plan.patterns.push(val())
      else if (['ignore-case', 'word-regexp', 'files-with-matches', 'count', 'invert-match'].includes(name))
        plan.flags.push(`--${name}`)
      else if (
        ['recursive', 'dereference-recursive', 'line-number', 'no-messages', 'color', 'binary-files'].includes(name)
      ) {
        if (name === 'binary-files' && inline === undefined) i++
      } else if (name === 'extended-regexp') mode = 'E'
      else if (name === 'fixed-strings') mode = 'F'
      else return { hint: `grep 的 --${name} 换不成 rg，按搜索规范自己写 rg` }
      continue
    }
    if (/^-[A-Za-z]+/.test(w) && w !== '-') {
      const letters = w.slice(1)
      for (let k = 0; k < letters.length; k++) {
        const f = letters[k]
        const tail = letters.slice(k + 1)
        if ('eABCm'.includes(f)) {
          const v = tail || a[++i] || ''
          if (f === 'e') plan.patterns.push(v)
          else plan.flags.push(`-${f}`, v)
          break
        }
        if ('rRnsHhI'.includes(f)) continue
        if (f === 'E' || f === 'F' || f === 'G') mode = f
        else if ('iwlcvo'.includes(f)) plan.flags.push(`-${f}`)
        else if (f === 'P') return { hint: 'grep -P 的正则改用 rg 写（rg 默认就是 Perl 风格的正则，复杂的加 -P）' }
        else return { hint: `grep 的 -${f} 换不成 rg，按搜索规范自己写 rg` }
      }
      continue
    }
    rest.push(w)
  }
  if (!plan.patterns.length) {
    const p = rest.shift()
    if (p === undefined) return { hint: '没认出要搜的词：写成 rg -n "词" <模块目录>' }
    plan.patterns.push(p)
  }
  if (mode === 'F') plan.flags.unshift('-F')
  else if (mode === 'G') plan.patterns = plan.patterns.map(breToRg)
  for (const p of rest) addPath(plan, p)
  return plan
}

/** find：起点 + -name / -iname / -maxdepth / -not -path；按时间、大小、-exec 这些换不了 */
function findToRg(args: Word[]): Converted {
  const plan: RgPlan = { files: true, flags: [], patterns: [], paths: [], globs: [] }
  const a = vals(args)
  let i = 0
  while (i < a.length && !/^[-!(]/.test(a[i])) plan.paths.push(a[i++])
  let not = false
  for (; i < a.length; i++) {
    const w = a[i]
    if (w === '!' || w === '-not') not = true
    else if (w === '-name' || w === '-iname') {
      plan.globs.push(a[++i] ?? '*')
      if (w === '-iname') plan.iglob = true
    } else if (w === '-path' || w === '-ipath' || w === '-wholename') {
      const v = a[++i] ?? ''
      if (!not) return { hint: "find -path 改用 rg --files <目录> -g '<路径通配>'" }
      plan.globs.push(`!${v.replace(/^\.\//, '')}`)
      not = false
    } else if (w === '-maxdepth') plan.flags.push('--max-depth', a[++i] ?? '1')
    else if (w === '-type') {
      const v = a[++i]
      if (v === 'd')
        return { hint: "找目录：用 ls <父目录> 看一层，或 rg --files <目录> -g '*名字*' 从文件路径里看目录" }
    } else if (['-o', '-or', '-print', '-print0', '(', ')', '\\(', '\\)', '-a', '-and', '-prune'].includes(w)) continue
    else if (/^-(newer|mtime|mmin|ctime|cmin|atime|newermt)/.test(w))
      return { hint: '找最近改过的文件用版本管理（git status、p4 opened、p4 diff -se），不要按修改时间扫目录树' }
    else if (w === '-exec' || w === '-execdir' || w === '-delete')
      return { hint: "find -exec 拆开：先 rg --files <目录> -g '<名字>' 找到文件，再对找到的文件单独操作" }
    else return { hint: `find 的 ${w} 换不成 rg，按搜索规范用 rg --files <目录> -g '<名字>'` }
  }
  if (!plan.paths.length) plan.paths.push('.')
  if (plan.paths.length === 1 && plan.paths[0] === '.') plan.paths = []
  return plan
}

/** Get-ChildItem / gci / ls -R / dir /s：按名字列文件 */
function listToRg(args: Word[]): Converted {
  const plan: RgPlan = { files: true, flags: [], patterns: [], paths: [], globs: [], iglob: true }
  const a = vals(args)
  for (let i = 0; i < a.length; i++) {
    const w = a[i]
    const low = w.toLowerCase()
    if (/^-(path|literalpath)$/.test(low)) addPath(plan, a[++i] ?? '.')
    else if (/^-(filter|include)$/.test(low)) plan.globs.push(...(a[++i] ?? '*').split(',').map((x) => x.trim()))
    else if (low === '-exclude') plan.globs.push(...(a[++i] ?? '').split(',').map((x) => `!${x.trim()}`))
    else if (low === '-depth') plan.flags.push('--max-depth', String(Number(a[++i] ?? 0) + 1))
    else if (low === '-directory' || low === '-ad' || low === '/ad')
      return { hint: "找目录：用 ls <父目录> 看一层，或 rg --files <目录> -g '*名字*' 从文件路径里看目录" }
    else if (/^-erroraction$/.test(low)) i++
    else if (/^(-recurse|-file|-force|-name|-r|\/s|\/b|\/a-d|-af)$/.test(low) || /^-[a-z]*r[a-z]*$/i.test(w)) continue
    else if (/^[-/]/.test(w)) return { hint: `${w} 换不成 rg，按搜索规范用 rg --files <目录> -g '<名字>'` }
    else addPath(plan, w)
  }
  return plan
}

/** Select-String -Path / sls：默认不分大小写，-SimpleMatch 是按原文 */
function slsToRg(args: Word[]): Converted {
  const plan: RgPlan = { files: false, flags: ['-i'], patterns: [], paths: [], globs: [] }
  const a = vals(args)
  const pos: string[] = []
  for (let i = 0; i < a.length; i++) {
    const low = a[i].toLowerCase()
    if (low === '-pattern') plan.patterns.push(...(a[++i] ?? '').split(','))
    else if (low === '-path' || low === '-literalpath') for (const p of (a[++i] ?? '').split(',')) addPath(plan, p)
    else if (low === '-simplematch') plan.flags.push('-F')
    else if (low === '-casesensitive') plan.flags = plan.flags.filter((f) => f !== '-i')
    else if (low === '-list') plan.flags.push('-l')
    else if (low === '-context') {
      const [b, f] = (a[++i] ?? '0').split(',')
      plan.flags.push('-B', b, '-A', f ?? b)
    } else if (low === '-include') plan.globs.push(...(a[++i] ?? '').split(','))
    else if (low === '-erroraction') i++
    else if (/^-/.test(low)) return { hint: `Select-String 的 ${a[i]} 换不成 rg，按搜索规范自己写 rg` }
    else pos.push(a[i])
  }
  if (!plan.patterns.length && pos.length) plan.patterns.push(pos.shift()!)
  for (const p of pos) addPath(plan, p)
  if (!plan.patterns.length) return { hint: '写成 rg -n "词" <模块目录> -g \'*.扩展名\'' }
  return plan
}

/** findstr：空格分开的几个词是「或」，/c:"x" 是整句按原文；/r 才是正则 */
function findstrToRg(args: Word[]): Converted {
  const plan: RgPlan = { files: false, flags: [], patterns: [], paths: [], globs: [] }
  let regex = false
  const pos: string[] = []
  for (const w of vals(args)) {
    const low = w.toLowerCase()
    const c = /^\/c:(.*)$/i.exec(w)
    if (c) plan.patterns.push(c[1])
    else if (low === '/i') plan.flags.push('-i')
    else if (low === '/r') regex = true
    else if (low === '/m') plan.flags.push('-l')
    else if (low === '/x') plan.flags.push('-x')
    else if (/^\/[snpl]$/.test(low)) continue
    else if (/^\//.test(w)) return { hint: `findstr 的 ${w} 换不成 rg，按搜索规范自己写 rg` }
    else pos.push(w)
  }
  if (!plan.patterns.length) plan.patterns.push(...(pos.shift() ?? '').split(/\s+/).filter(Boolean))
  if (!regex) plan.flags.unshift('-F')
  for (const p of pos) addPath(plan, p)
  return plan
}

/** git grep：参数和 grep 差不多，路径写在 -- 后面 */
function gitGrepToRg(args: Word[]): Converted {
  return grepToRg(
    args.filter((w) => w.v !== '--'),
    'grep',
  )
}

/** fd / ag / ack / tree */
function fdToRg(args: Word[]): Converted {
  const a = vals(args).filter((w) => !w.startsWith('-'))
  return { files: true, flags: [], patterns: [], paths: a.slice(1), globs: a[0] ? [`*${a[0]}*`] : [], iglob: true }
}
function agToRg(args: Word[]): Converted {
  const a = vals(args).filter((w) => !w.startsWith('-'))
  if (!a.length) return { hint: '写成 rg -n "词" <模块目录>' }
  return { files: false, flags: [], patterns: [a[0]], paths: a.slice(1), globs: [] }
}
function treeToRg(args: Word[]): Converted {
  const a = vals(args).filter((w) => !/^[-/]/.test(w))
  return { files: true, flags: [], patterns: [], paths: a, globs: [] }
}

/** 程序名（segHead 的结果）→ 换算函数；git grep 由调用方按子命令认 */
export const CONVERTERS: Record<string, (args: Word[], head: string) => Converted> = {
  grep: grepToRg,
  egrep: grepToRg,
  fgrep: grepToRg,
  ugrep: grepToRg,
  find: findToRg,
  'get-childitem': listToRg,
  gci: listToRg,
  ls: listToRg,
  dir: listToRg,
  'select-string': slsToRg,
  sls: slsToRg,
  findstr: findstrToRg,
  'git-grep': gitGrepToRg,
  fd: fdToRg,
  ag: agToRg,
  ack: agToRg,
  tree: treeToRg,
}
