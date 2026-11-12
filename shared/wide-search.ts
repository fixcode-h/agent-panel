/**
 * 全项目全文搜索：从项目根（或更上层）起、把每个文件都读一遍的递归搜索。
 *
 * 用户 2026-11-07 报 Agent 在前台跑 `grep -rl "Win-UE5\|globals.json" "G:/…/Project" --include=…`，跑了 2 分钟没用后台命令。
 * 原因是 grep 在快命令清单里（command-scope.ts）：长命令守卫不管它，面板工具说明也只把编译、测试、安装、下载列成长命令。
 * 可 grep -r / findstr /s / find … | xargs grep 不读 .gitignore、也不认面板的「搜索时跳过的目录」（那份清单只经
 * RIPGREP_CONFIG_PATH 交给了 rg），UE 这类项目会把 Binaries、Intermediate、DerivedDataCache 全扫一遍。
 * 这里只认「从哪里开始扫」（起点目录），是不是项目根交给调用方按真实路径比；rg、ag、git grep 不算（它们跳过忽略的目录）
 */
import { segHead, stripHeredocs } from './command-scope.ts'
import { unwrapShell } from './shell-command.ts'

/**
 * 按 &&、||、;、|、换行拆段，引号里的不拆：grep 的模式常写成 "a\\|b"，
 * 通用的 commandSegments 不认引号，会把它从中间劈开、把后半截当成另一段
 */
function segments(cmd: string): string[] {
  const s = stripHeredocs(unwrapShell(cmd))
  const out: string[] = []
  let cur = ''
  let q = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (q) {
      if (ch === q) q = ''
      cur += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      q = ch
      cur += ch
      continue
    }
    const two = s.slice(i, i + 2)
    if (two === '&&' || two === '||' || ch === ';' || ch === '|' || ch === '\n') {
      out.push(cur.trim())
      cur = ''
      if (two === '&&' || two === '||') i++
      continue
    }
    cur += ch
  }
  out.push(cur.trim())
  return out.filter(Boolean)
}

/** 按空白拆参数，引号里的空白不拆，去掉引号 */
function words(seg: string): string[] {
  const out: string[] = []
  for (const m of seg.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

/** grep 后面要单独跟一个值的参数（短参数只看最后一个字母，比如 -rle PATTERN 的 e） */
const GREP_VALUE_SHORT = new Set(['e', 'f', 'm', 'A', 'B', 'C', 'd', 'D']) // 模块状态：常量，加载后不改
// 模块状态：常量，加载后不改
const GREP_VALUE_LONG = new Set([
  '--regexp',
  '--file',
  '--max-count',
  '--context',
  '--after-context',
  '--before-context',
  '--include',
  '--exclude',
  '--exclude-dir',
  '--exclude-from',
  '--label',
  '--directories',
  '--devices',
  '--binary-files',
])

/**
 * grep 的递归起点：不递归、或者自己用 --exclude-dir 跳过了目录（Agent 已经在收窄范围）时返回 null。
 * 不写路径时 grep -r 从当前目录开始
 */
function grepStarts(args: string[]): string[] | null {
  let recursive = false
  let explicitPattern = false
  const pos: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--') {
      pos.push(...args.slice(i + 1))
      break
    }
    if (a.startsWith('--')) {
      const [name] = a.split('=')
      if (name === '--recursive' || name === '--dereference-recursive') recursive = true
      if (name === '--exclude-dir') return null
      if (name === '--regexp' || name === '--file') explicitPattern = true
      if (GREP_VALUE_LONG.has(name) && !a.includes('=')) i++
      continue
    }
    if (a.startsWith('-') && a.length > 1) {
      const flags = a.slice(1)
      if (/[rR]/.test(flags.split(/[efmABCdD]/)[0])) recursive = true
      // -e / -f 带值：粘在后面（-efoo）不跳，单独写（-e foo）跳过下一个
      const k = flags.search(/[efmABCdD]/)
      if (k >= 0) {
        if ('ef'.includes(flags[k])) explicitPattern = true
        if (k === flags.length - 1 && GREP_VALUE_SHORT.has(flags[k])) i++
      }
      continue
    }
    pos.push(a)
  }
  if (!recursive) return null
  const paths = explicitPattern ? pos : pos.slice(1)
  return paths.length ? paths : ['.']
}

/** find 的起点：-name 这类表达式之前的参数；剪了枝（-prune）的不算在扫全部 */
function findStarts(args: string[]): string[] | null {
  if (args.includes('-prune')) return null
  const starts: string[] = []
  for (const a of args) {
    if (/^[-(!]/.test(a)) break
    starts.push(a)
  }
  return starts.length ? starts : ['.']
}

/** find 本身只列文件名，接上 -exec grep 或 | xargs grep 才是把每个文件读一遍 */
const findReadsFiles = (seg: string, next: string) =>
  /\s-exec(?:dir)?\s+\S*grep\b/.test(seg) || (segHead(next) === 'xargs' && /\bgrep\b/.test(next))

/**
 * 这条命令里全文递归搜索的起点目录（相对路径按命令的工作目录算，由调用方 resolve）；没有这样的搜索返回空数组。
 * 认 grep -r、findstr /s、find … -exec grep / | xargs grep、Get-ChildItem -Recurse … | Select-String
 */
export function fullScanStarts(cmd: string): string[] {
  const segs = segments(cmd)
  const out: string[] = []
  segs.forEach((seg, i) => {
    const head = segHead(seg)
    const args = words(seg).slice(1)
    const next = segs[i + 1] ?? ''
    if (head === 'grep' || head === 'egrep' || head === 'fgrep') out.push(...(grepStarts(args) ?? []))
    else if (head === 'findstr' && args.some((a) => /^\/s$/i.test(a))) {
      // findstr /s 从文件参数所在的目录往下扫：参数里的 /d:目录 或 带路径的文件名，否则当前目录
      const dir = args.find((a) => /^\/d:/i.test(a))
      const file = args.filter((a) => !a.startsWith('/')).pop() ?? ''
      out.push(dir ? dir.slice(3) : /[\\/]/.test(file) ? file.replace(/[\\/][^\\/]*$/, '') || '/' : '.')
    } else if (head === 'find' && findReadsFiles(seg, next)) out.push(...(findStarts(args) ?? []))
    else if (
      ['get-childitem', 'gci', 'dir', 'ls'].includes(head) &&
      args.some((a) => /^-r(?:ecurse)?$/i.test(a)) &&
      ['select-string', 'sls'].includes(segHead(next))
    ) {
      const p = args.findIndex((a) => /^-(?:path|literalpath)$/i.test(a))
      const bare = args.filter((a) => !a.startsWith('-'))
      out.push(p >= 0 && args[p + 1] ? args[p + 1] : (bare[0] ?? '.'))
    }
  })
  return out
}
