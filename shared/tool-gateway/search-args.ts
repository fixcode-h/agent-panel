/**
 * 搜索命令的参数认法（ADR 0084 第二期「查找接管」）：把单段的 rg / grep / git grep / Select-String / findstr，
 * 和 CLI 自带的「按内容搜」工具（Claude Code 的 Grep，形状登记在 CLI 定义的 takeover.tools）读成统一的 SearchSpec。
 *
 * 只认看得懂的那几种写法：拿不准的（不认识的参数、正则、命令替换、重定向到文件、多个关键词）一律返回 undefined，
 * 网关就原样放行。宁可少接一次，也不给出和原命令语义不一样的结果（用户 2026-11-26 定：拿不准的一律放行）。
 *
 * 按名字找文件（find -name、fd、Glob）这里也认出来，但网关不接管：文件索引不收排除目录，结果只会比原命令少或一样，
 * 改道得不到任何好处（见 ADR 0084「第二期」）
 */
import { unwrapShell } from '../shell-command.ts'

/** 一次「按内容搜」或「按名字找」读出来的样子 */
export interface SearchSpec {
  program: string
  mode: 'content' | 'files'
  /** content：要找的原文（已确认不是正则）；files：名字的通配或片段 */
  pattern: string
  ignoreCase: boolean
  /** 在哪些目录 / 文件里找（原样，相对 CLI 的工作目录）；空表示当前目录 */
  paths: string[]
  /** 只看这些文件名通配（-g、--include、findstr 的 *.lua） */
  include: string[]
  /** 不看这些（--exclude、-g !x） */
  exclude: string[]
  /** 只看这些扩展名（-t lua、-e lua） */
  exts: string[]
  /**
   * 面板自己能照原样跑一遍时的跑法（CLI 不能改写、只能代答时用）：argv 直接起进程，不经 shell；
   * powershell 是 cmdlet（Select-String），要交给 PowerShell 跑原文。拿不准怎么跑的（有未加引号的通配、变量）不给
   */
  run?: { argv: string[] } | { powershell: string }
}

interface Tok {
  v: string
  /** 里面的 * ? 都在引号里（或者用引号包过、没有通配）：shell 不会展开它 */
  quoted: boolean
}

/** 正则元字符：出现了就不是「按原文找」，面板的文本兜底只会按原文找，结果对不上 */
const REGEX_META = /[\\^$*+?()[\]{}|]/
/** stderr 丢掉或并进 stdout：不影响找到什么 */
const STDERR_REDIRECT = /^2>(?:&1|\/dev\/null|nul|\$null)$/i
/** 命令替换、变量、未拆开的管道和重定向：shell 会改写这一段，面板看到的不是程序真正拿到的 */
const SHELL_MAGIC = /\$\(|`|\$\{|^\$[A-Za-z_]|^[<>]|[^2]>|<\(|^&$/

/**
 * 按 shell 的引号规则切参数：单引号原样、双引号里只认 \" 和 \\；PowerShell 的 '' 转义也认。
 * 碰到命令替换、变量、文件重定向返回 undefined（交给调用方放行）
 */
export function tokenize(cmd: string): Tok[] | undefined {
  const out: Tok[] = []
  let i = 0
  const s = cmd.trim()
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++
    if (i >= s.length) break
    let v = ''
    let quoted = false
    let raw = ''
    while (i < s.length && !/\s/.test(s[i])) {
      const ch = s[i]
      if (ch === "'") {
        const end = s.indexOf("'", i + 1)
        if (end < 0) return undefined
        v += s.slice(i + 1, end)
        raw += s.slice(i, end + 1)
        quoted = true
        i = end + 1
        // PowerShell：'' 是一个单引号
        if (s[i] === "'") v += "'"
        continue
      }
      if (ch === '"') {
        let j = i + 1
        let body = ''
        while (j < s.length && s[j] !== '"') {
          if (s[j] === '\\' && (s[j + 1] === '"' || s[j + 1] === '\\')) j++
          else if (s[j] === '$' || s[j] === '`') return undefined
          body += s[j++]
        }
        if (j >= s.length) return undefined
        v += body
        raw += s.slice(i, j + 1)
        quoted = true
        i = j + 1
        continue
      }
      v += ch
      raw += ch
      i++
    }
    if (STDERR_REDIRECT.test(raw)) continue
    if (!quoted && SHELL_MAGIC.test(raw)) return undefined
    out.push({ v, quoted: quoted && !/[*?]/.test(raw.replace(/(['"]).*?\1/g, '')) })
  }
  return out
}

const progOf = (t: string) =>
  t
    .split(/[\\/]/)
    .pop()!
    .toLowerCase()
    .replace(/\.(exe|cmd|bat)$/, '')

/** 程序名 → 读法；都不认返回 undefined */
type Reader = (args: Tok[], program: string) => SearchSpec | undefined

/** 长短参数的读法：flags 不带值，values 带一个值（-g x、--glob=x），其余一律拿不准 */
interface FlagTable {
  flags: Record<string, (s: Draft) => void>
  values: Record<string, (s: Draft, v: string) => void>
  /** 短参数能连写（-rni） */
  bundle: boolean
}

interface Draft {
  pattern?: string
  fixed: boolean
  ignoreCase: boolean
  smart: boolean
  paths: string[]
  include: string[]
  exclude: string[]
  exts: string[]
  files: boolean
  /** grep 的 -r：不带它又没给路径时 grep 读的是标准输入，不是在搜目录 */
  recursive: boolean
  /** 认得但会让结果和普通搜索不一样的（-v 反选、-L 没匹配的文件）：整条放行 */
  odd: boolean
}

const draft = (): Draft => ({
  fixed: false,
  ignoreCase: false,
  smart: false,
  paths: [],
  include: [],
  exclude: [],
  exts: [],
  files: false,
  recursive: false,
  odd: false,
})

const noop = () => {}
const odd = (s: Draft) => void (s.odd = true)
// 输出样子不同、找到的范围不变的参数：一律认，不影响面板补什么
const SHAPE = ['-n', '--line-number', '-N', '--no-line-number', '-H', '--with-filename', '-h', '--no-filename']
const SHAPE_V = ['-A', '-B', '-C', '--after-context', '--before-context', '--context', '-m', '--max-count', '--color']

/** rg 的 -t：常见的几种，其余不认（rg --type-list 很长，猜错了范围就不对） */
const RG_TYPES: Record<string, string[]> = {
  lua: ['lua'],
  cpp: ['cpp', 'cc', 'cxx', 'h', 'hpp', 'hh', 'hxx', 'inl'],
  c: ['c', 'h'],
  cs: ['cs'],
  ts: ['ts', 'tsx', 'cts', 'mts'],
  js: ['js', 'jsx', 'cjs', 'mjs'],
  py: ['py', 'pyi'],
  go: ['go'],
  rust: ['rs'],
  java: ['java'],
  json: ['json'],
  md: ['md', 'markdown'],
}

const glob = (s: Draft, v: string) => (v.startsWith('!') ? s.exclude.push(v.slice(1)) : s.include.push(v))

function table(flags: Record<string, (s: Draft) => void>, values: FlagTable['values'], bundle = true): FlagTable {
  for (const f of SHAPE) flags[f] ??= noop
  for (const f of SHAPE_V) values[f] ??= noop
  return { flags, values, bundle }
}

const RG = table(
  {
    '-i': (s) => (s.ignoreCase = true),
    '--ignore-case': (s) => (s.ignoreCase = true),
    '-S': (s) => (s.smart = true),
    '--smart-case': (s) => (s.smart = true),
    '-s': (s) => (s.ignoreCase = false),
    '--case-sensitive': (s) => (s.ignoreCase = false),
    '-F': (s) => (s.fixed = true),
    '--fixed-strings': (s) => (s.fixed = true),
    '-w': noop,
    '--word-regexp': noop,
    '-l': noop,
    '--files-with-matches': noop,
    '-c': noop,
    '--count': noop,
    '--no-heading': noop,
    '--heading': noop,
    '--hidden': noop,
    '--no-ignore': noop,
    '-u': noop,
    '-uu': noop,
    '--vimgrep': noop,
    '--column': noop,
    '-v': odd,
    '--invert-match': odd,
    '--files-without-match': odd,
    '--files': (s) => (s.files = true),
  },
  {
    '-g': glob,
    '--glob': glob,
    '--iglob': glob,
    '-t': (s, v) => (RG_TYPES[v] ? s.exts.push(...RG_TYPES[v]) : (s.odd = true)),
    '--type': (s, v) => (RG_TYPES[v] ? s.exts.push(...RG_TYPES[v]) : (s.odd = true)),
    '-e': (s, v) => (s.pattern === undefined ? (s.pattern = v) : (s.odd = true)),
    '--regexp': (s, v) => (s.pattern === undefined ? (s.pattern = v) : (s.odd = true)),
    '-M': noop,
    '--max-columns': noop,
  },
)

const GREP = table(
  {
    '-r': (s) => (s.recursive = true),
    '-R': (s) => (s.recursive = true),
    '--recursive': (s) => (s.recursive = true),
    '-i': (s) => (s.ignoreCase = true),
    '--ignore-case': (s) => (s.ignoreCase = true),
    '-F': (s) => (s.fixed = true),
    '--fixed-strings': (s) => (s.fixed = true),
    '-E': noop,
    '-w': noop,
    '-l': noop,
    '--files-with-matches': noop,
    '-c': noop,
    '-s': noop,
    '-I': noop,
    '-v': odd,
    '-L': odd,
  },
  {
    '--include': glob,
    '--exclude': (s, v) => s.exclude.push(v),
    '--exclude-dir': (s, v) => s.exclude.push(`${v}/**`),
    '-e': (s, v) => (s.pattern === undefined ? (s.pattern = v) : (s.odd = true)),
  },
)

const GIT_GREP = table(
  {
    '-i': (s) => (s.ignoreCase = true),
    '--ignore-case': (s) => (s.ignoreCase = true),
    '-F': (s) => (s.fixed = true),
    '--fixed-strings': (s) => (s.fixed = true),
    '-w': noop,
    '-l': noop,
    '-c': noop,
    '-I': noop,
    '--untracked': noop,
    '-v': odd,
  },
  { '-e': (s, v) => (s.pattern === undefined ? (s.pattern = v) : (s.odd = true)) },
)

/** 按参数表读：认不出的参数返回 undefined；位置参数第一个是关键词（-e 给过就都是路径），其余是路径 */
function readFlags(args: Tok[], t: FlagTable): Draft | undefined {
  const s = draft()
  let onlyPaths = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i].v
    if (onlyPaths || !a.startsWith('-') || a === '-') {
      if (s.pattern === undefined) s.pattern = a
      else s.paths.push(a)
      continue
    }
    if (a === '--') {
      onlyPaths = true
      continue
    }
    const eq = a.indexOf('=')
    if (a.startsWith('--') && eq > 0) {
      const set = t.values[a.slice(0, eq)]
      if (!set) return undefined
      set(s, a.slice(eq + 1))
      continue
    }
    if (t.flags[a]) {
      t.flags[a](s)
      continue
    }
    if (t.values[a]) {
      if (i + 1 >= args.length) return undefined
      t.values[a](s, args[++i].v)
      continue
    }
    // -C3、-g*.lua 这种值连在后面的
    const head = a.slice(0, 2)
    if (!a.startsWith('--') && a.length > 2 && t.values[head]) {
      t.values[head](s, a.slice(2))
      continue
    }
    // -rni 连写
    if (t.bundle && /^-[A-Za-z]{2,}$/.test(a) && [...a.slice(1)].every((c) => t.flags[`-${c}`])) {
      for (const c of a.slice(1)) t.flags[`-${c}`](s)
      continue
    }
    return undefined
  }
  return s.odd ? undefined : s
}

/** 几种程序读出来之后都一样收尾：关键词要是原文、不能太短 */
function finish(program: string, d: Draft, args: Tok[], posix: boolean): SearchSpec | undefined {
  if (d.files) return undefined
  const pattern = d.pattern ?? ''
  if (pattern.trim().length < 2) return undefined
  if (!d.fixed && REGEX_META.test(pattern)) return undefined
  // smart-case：全小写才不分大小写（rg 的规则）
  const ignoreCase = d.ignoreCase || (d.smart && pattern === pattern.toLowerCase())
  // 没加引号的 * ? 交给 shell 展开（bash 下 rg foo *.lua），面板直接起进程时拿不到展开后的样子
  const runnable = !posix || args.every((a) => a.quoted || !/[*?[]/.test(a.v))
  return {
    program,
    mode: 'content',
    pattern,
    ignoreCase,
    paths: d.paths,
    include: d.include,
    exclude: d.exclude,
    exts: d.exts,
    ...(runnable ? { run: { argv: [program, ...args.map((a) => a.v)] } } : {}),
  }
}

const READERS: Record<string, Reader> = {
  rg: (args) => {
    const d = readFlags(args, RG)
    return d && finish('rg', d, args, true)
  },
  grep: (args, p) => {
    const d = readFlags(args, GREP)
    if (!d || (!d.recursive && !d.paths.length)) return undefined
    if (p === 'fgrep') d.fixed = true
    return finish(p, d, args, true)
  },
  git: (args) => {
    if (args[0]?.v !== 'grep') return undefined
    const d = readFlags(args.slice(1), GIT_GREP)
    const spec = d && finish('git', d, args.slice(1), true)
    return spec?.run && 'argv' in spec.run ? { ...spec, run: { argv: ['git', ...args.map((a) => a.v)] } } : spec
  },
  'select-string': (args, p) => selectString(args, p),
  findstr: (args) => findstr(args),
}
READERS.egrep = READERS.grep
READERS.fgrep = READERS.grep
READERS.sls = READERS['select-string']

/** Select-String [-Pattern] x [-Path] y [-SimpleMatch] [-CaseSensitive]：PowerShell 默认不分大小写、按正则 */
function selectString(args: Tok[], program: string): SearchSpec | undefined {
  const d = draft()
  d.ignoreCase = true
  const pos: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i].v.toLowerCase()
    const val = () => (i + 1 < args.length ? args[++i].v : undefined)
    if (a === '-pattern') d.pattern = val()
    else if (a === '-path' || a === '-literalpath') d.paths.push(...(val() ?? '').split(',').filter(Boolean))
    else if (a === '-simplematch') d.fixed = true
    else if (a === '-casesensitive') d.ignoreCase = false
    else if (a === '-context') val()
    else if (a === '-list' || a === '-allmatches' || a === '-quiet') continue
    else if (a.startsWith('-')) return undefined
    else pos.push(args[i].v)
  }
  if (d.pattern === undefined) d.pattern = pos.shift()
  d.paths.push(...pos)
  if (!d.paths.length) return undefined
  // -Path 里的通配（src\*.lua）：目录进 paths、文件名进 include
  splitWildcards(d)
  const spec = finish(program, d, [], false)
  return spec && { ...spec, run: { powershell: args.length ? `${program} ${quoteAll(args)}` : program } }
}

/** findstr /s /i /n /c:"文字" 文件……：/r 是正则；不带 /c: 时空格分开的是「任一个词」，拿不准 */
function findstr(args: Tok[]): SearchSpec | undefined {
  const d = draft()
  let literal = false
  for (const t of args) {
    const a = t.v
    if (/^\/c:/i.test(a)) {
      if (d.pattern !== undefined) return undefined
      d.pattern = a.slice(3)
      literal = true
    } else if (/^\/[sinpm]$/i.test(a)) {
      if (/^\/i$/i.test(a)) d.ignoreCase = true
    } else if (/^\/l$/i.test(a)) d.fixed = true
    else if (a.startsWith('/')) return undefined
    else if (d.pattern === undefined) {
      if (/\s/.test(a)) return undefined
      d.pattern = a
    } else d.paths.push(a)
  }
  if (!literal && d.pattern && /\s/.test(d.pattern)) return undefined
  splitWildcards(d)
  // 没给文件时 findstr 读标准输入
  if (!d.paths.length && !d.include.length) return undefined
  return finish('findstr', d, args, false)
}

/** 路径里带通配的（src\*.lua、*.cpp）拆成目录和文件名通配 */
function splitWildcards(d: Draft) {
  const paths: string[] = []
  for (const p of d.paths) {
    const n = p.replace(/\\/g, '/')
    const at = n.lastIndexOf('/')
    const base = n.slice(at + 1)
    if (!/[*?]/.test(base)) {
      paths.push(p)
      continue
    }
    d.include.push(base)
    if (at > 0) paths.push(n.slice(0, at))
  }
  d.paths = paths
}

const quoteAll = (args: Tok[]) => args.map((a) => (/[\s'"]/.test(a.v) ? `'${a.v.replace(/'/g, "''")}'` : a.v)).join(' ')

/** 一段命令读成 SearchSpec：外面包的 bash -lc、cmd /c、& 先剥掉；拿不准返回 undefined */
export function parseSearchCommand(cmd: string): SearchSpec | undefined {
  const toks = tokenize(unwrapShell(cmd))
  if (!toks?.length) return undefined
  const program = progOf(toks[0].v)
  return READERS[program]?.(toks.slice(1), program)
}

/**
 * CLI 自带的「按内容搜」工具（ripgrep 形状：pattern、path、glob、type、-i、output_mode……，Claude Code 的 Grep）：
 * 多行、分页截断这类面板不好照做的参数拿不准，返回 undefined
 */
export function parseGrepTool(input: Record<string, unknown>): SearchSpec | undefined {
  const known = ['pattern', 'path', 'glob', 'type', 'output_mode', '-i', '-n', '-A', '-B', '-C', 'context']
  if (Object.keys(input).some((k) => !known.includes(k))) return undefined
  const pattern = typeof input.pattern === 'string' ? input.pattern : ''
  if (pattern.trim().length < 2 || REGEX_META.test(pattern)) return undefined
  const type = typeof input.type === 'string' ? input.type : ''
  if (type && !RG_TYPES[type]) return undefined
  const mode = typeof input.output_mode === 'string' ? input.output_mode : 'files_with_matches'
  if (!['files_with_matches', 'content', 'count'].includes(mode)) return undefined
  const path = typeof input.path === 'string' && input.path.trim() ? input.path.trim() : ''
  const g = typeof input.glob === 'string' && input.glob.trim() ? input.glob.trim() : ''
  const ignoreCase = input['-i'] === true
  const ctx = (k: string) =>
    typeof input[k] === 'number' ? [`-${k === 'context' ? 'C' : k.slice(1)}`, String(input[k])] : []
  const argv = [
    'rg',
    ...(mode === 'files_with_matches' ? ['-l'] : mode === 'count' ? ['-c'] : input['-n'] === false ? [] : ['-n']),
    ...(ignoreCase ? ['-i'] : []),
    ...(mode === 'content' ? [...ctx('-A'), ...ctx('-B'), ...ctx('-C'), ...ctx('context')] : []),
    ...(g ? ['--glob', g] : []),
    ...(type ? ['--type', type] : []),
    '-e',
    pattern,
    '--',
    path || '.',
  ]
  return {
    program: 'rg',
    mode: 'content',
    pattern,
    ignoreCase,
    paths: path ? [path] : [],
    include: g ? [g] : [],
    exclude: [],
    exts: type ? RG_TYPES[type] : [],
    run: { argv },
  }
}
