/**
 * 读一条 rg 的参数：要搜的词、起点、-g / -t 过滤，和几个规范里不许用的参数。
 * 只为检查规范用，不追求覆盖 rg 的全部参数：认不出的长参数当成不带值的开关
 */
import type { RgPlan } from './to-rg.ts'
import type { Word } from './words.ts'

/** 短参数里要跟一个值的（-g x、-tlua、-rX）：rg 的 -r 是替换文字，也带值 */
// 模块状态：常量，加载后不改
const VALUE_SHORT = new Set('efgtTmABCrMjEd'.split(''))
// 模块状态：常量，加载后不改
const VALUE_LONG = new Set([
  'glob',
  'iglob',
  'type',
  'type-not',
  'regexp',
  'file',
  'max-count',
  'context',
  'before-context',
  'after-context',
  'replace',
  'max-depth',
  'max-filesize',
  'encoding',
  'max-columns',
  'threads',
  'sort',
  'sortr',
  'type-add',
  'pre',
  'pre-glob',
  'color',
  'colors',
  'path-separator',
  'context-separator',
  'field-match-separator',
])

export interface RgArgs extends RgPlan {
  /** 有没有按文件类型过滤（-g、--iglob、-t、--type） */
  typed: boolean
  /** 短参数串里当成「递归」写的 -r（rg -rn foo）：原样记下这一串，修的时候去掉 r */
  rCluster?: string
  /** 会把排除配置整个放开的参数：--no-ignore*、-u、--hidden、--no-config */
  unignore: string[]
  /** 吞掉报错的参数：--no-messages */
  quiet: string[]
}

export function parseRg(args: Word[]): RgArgs {
  const out: RgArgs = {
    files: false,
    flags: [],
    patterns: [],
    paths: [],
    globs: [],
    typed: false,
    unignore: [],
    quiet: [],
  }
  const pos: string[] = []
  let fromFlag = false
  for (let i = 0; i < args.length; i++) {
    const w = args[i].v
    if (w === '--') {
      pos.push(...args.slice(i + 1).map((x) => x.v))
      break
    }
    const long = /^--([\w-]+)(?:=(.*))?$/.exec(w)
    if (long && !args[i].quoted) {
      const [, name, inline] = long
      const val = VALUE_LONG.has(name) ? (inline ?? args[++i]?.v ?? '') : ''
      if (name === 'files') out.files = true
      else if (name === 'glob' || name === 'iglob') out.globs.push(val)
      else if (name === 'type') out.typed = true
      else if (name === 'regexp') {
        out.patterns.push(val)
        fromFlag = true
      } else if (name === 'file') fromFlag = true
      else if (/^no-ignore/.test(name) || name === 'hidden' || name === 'no-config' || name === 'unrestricted')
        out.unignore.push(w)
      else if (name === 'no-messages') out.quiet.push(w)
      continue
    }
    if (/^-[A-Za-z.]/.test(w) && !args[i].quoted) {
      const letters = w.slice(1)
      if (/^u+$/.test(letters) || letters === '.') {
        out.unignore.push(w)
        continue
      }
      for (let k = 0; k < letters.length; k++) {
        const f = letters[k]
        if (!VALUE_SHORT.has(f)) continue
        if (f === 'r') out.rCluster = w
        const v = letters.slice(k + 1) || args[++i]?.v || ''
        if (f === 'g') out.globs.push(v)
        else if (f === 't') out.typed = true
        else if (f === 'e') {
          out.patterns.push(v)
          fromFlag = true
        } else if (f === 'f') fromFlag = true
        break
      }
      continue
    }
    pos.push(w)
  }
  if (!out.files && !fromFlag && pos.length) out.patterns.push(pos.shift()!)
  out.paths = pos
  if (out.globs.some((g) => !g.startsWith('!'))) out.typed = true
  return out
}
