/**
 * 搜索规范的检查规则注册表（用户 2026-11-27 定：不按规范写的搜索全部直接退回，并告诉怎么写）。
 * 一条规则一行：看一段搜索命令，不合规范就说为什么、能自动改的给出改法（patch）。新规则只加一行，
 * 守卫和测试都按这张表走。规范正文在 ./guide.ts，两边说的要一致
 */
import { isPlan, renderRg, type Converted } from './to-rg.ts'
import type { RgArgs } from './rg-args.ts'
import type { Word } from './words.ts'

/** 起点落在哪：ok 正常；project-root 项目根；too-wide 盘符根、用户目录、项目上层；tool-dir 程序目录、面板数据目录 */
export type Scope = 'ok' | 'project-root' | 'too-wide' | 'tool-dir'

/** 检查一段命令时拿得到的东西 */
export interface SegCheck {
  /** 这一段原文 */
  text: string
  /** 段首程序名（git grep 记成 git-grep） */
  head: string
  args: Word[]
  /** rg 的参数（只有 rg 段有） */
  rg?: RgArgs
  /** 不是 rg 的搜索：换算成 rg 的结果 */
  converted?: Converted
  /** 起点（rg 的路径，或换算后的路径；没写就是当前目录）各自落在哪 */
  scopes: Scope[]
  /** 项目生效的排除目录 */
  excludes: string[]
}

export interface Issue {
  why: string
  /** 能自动改的：给出改好的这一段；改不了的只给建议 */
  patch?: (text: string) => string
  advice?: string
  /** 起点本身就不该搜（范围太大、翻程序）：别的规则改好的命令也不拿出来，免得照抄后还在原地搜 */
  noFix?: boolean
}

export interface SpecRule {
  id: string
  check: (s: SegCheck) => Issue | undefined
}

/** 退回说明里程序的叫法 */
const NAMES: Record<string, string> = {
  'git-grep': 'git grep',
  'get-childitem': 'Get-ChildItem -Recurse',
  gci: 'gci -Recurse',
  ls: 'ls -R',
  dir: 'dir /s',
  'select-string': 'Select-String',
  sls: 'Select-String',
}
/** 按名字找程序：可执行文件和常被拿来找的解释器、编译器 */
const PROGRAM = /\.(?:exe|bat|cmd|com)$|^\*?(?:luac|lua|python|node|msbuild|devenv|cl)\*?(?:\.|$)/i

const exList = (s: SegCheck) => (s.excludes.length ? `（${s.excludes.join('、')}）` : '')

export const SEARCH_SPEC_RULES: SpecRule[] = [
  {
    // 不是 rg：换算得出来就整段换成 rg，换不出来给一句该怎么写
    id: 'not-rg',
    check: (s) => {
      if (!s.converted) return undefined
      const why = `${NAMES[s.head] ?? s.head} 不读面板给 rg 的排除配置，大目录会把产物、缓存全扫一遍；搜索只用 rg`
      if (!isPlan(s.converted)) return { why, advice: s.converted.hint }
      const fixed = renderRg(s.converted)
      return { why, patch: () => fixed }
    },
  },
  {
    id: 'scope-too-wide',
    check: (s) =>
      s.scopes.includes('too-wide')
        ? {
            why: '起点是盘符根、用户目录或项目的上层目录，范围太大',
            noFix: true,
            advice: '把起点写到要找的东西所在的模块目录；不知道在哪就先 ls 看一层再定',
          }
        : undefined,
  },
  {
    id: 'tool-dir',
    check: (s) =>
      s.scopes.includes('tool-dir')
        ? {
            why: '在程序目录或面板数据目录里翻找',
            noFix: true,
            advice:
              '要用的程序先看面板的自建工具，只查 PATH 用 where / Get-Command，找不到就问用户程序路径；面板自己的数据用面板工具查',
          }
        : undefined,
  },
  {
    id: 'find-program',
    check: (s) => {
      const p = s.rg ?? (s.converted && isPlan(s.converted) ? s.converted : undefined)
      if (!p?.files || !p.globs.some((g) => PROGRAM.test(g))) return undefined
      return {
        why: '在磁盘上按名字翻找程序',
        noFix: true,
        advice:
          '要用的程序先看面板的自建工具（项目工具里登记过的编译、检查命令），只查 PATH 用 where / Get-Command，都没有就问用户程序路径',
      }
    },
  },
  {
    id: 'root-needs-type',
    check: (s) => {
      const p = s.rg ?? (s.converted && isPlan(s.converted) ? s.converted : undefined)
      if (!p || !s.scopes.includes('project-root')) return undefined
      if (s.rg ? s.rg.typed : p.globs.some((g) => !g.startsWith('!'))) return undefined
      return {
        why: '从项目根搜没写文件类型',
        advice: "加上文件类型（-g '*.lua'、-g '*.{h,cpp}'、-g '*.json'），或者把起点缩到模块目录",
      }
    },
  },
  {
    id: 'rg-r',
    check: (s) => {
      const c = s.rg?.rCluster
      if (!c) return undefined
      const short = c.replace('r', '')
      return {
        why: `rg 默认递归，${c} 里的 -r 是「把匹配换成后面的文字」，结果会被改坏`,
        patch: (t) =>
          t.replace(new RegExp(`(^|\\s)${c.replace(/[-.]/g, '\\$&')}(?=\\s|$)`), short === '-' ? '' : `$1${short}`),
      }
    },
  },
  {
    id: 'rg-unignore',
    check: (s) => {
      const u = s.rg?.unignore ?? []
      if (!u.length) return undefined
      return {
        why: `${u.join(' ')} 会把排除目录和二进制跳过整个放开`,
        advice: `要搜排除目录${exList(s)}里的东西，判断它在哪个排除目录，把那个目录明确写成起点，rg 会照常搜它`,
        patch: (t) => u.reduce((x, f) => x.replace(new RegExp(`\\s${f.replace(/[-.]/g, '\\$&')}(?=\\s|$)`), ''), t),
      }
    },
  },
  {
    id: 'rg-bre-or',
    check: (s) => {
      if (!s.rg || s.rg.flags.includes('-F') || !s.rg.patterns.some((p) => p.includes('\\|'))) return undefined
      return {
        why: 'rg 里 \\| 是找字面的 |，「或」要写成 A|B',
        patch: (t) => t.replace(/\\\|/g, '|'),
      }
    },
  },
  {
    id: 'hide-errors',
    check: (s) => {
      const re =
        /\s+(?:2>\s*(?:\/dev\/null|\$null|nul)|-ErrorAction\s+(?:SilentlyContinue|Ignore|0)|-ea\s+(?:SilentlyContinue|Ignore|0)|--no-messages)(?=\s|$)/gi
      if (!re.test(s.text)) return undefined
      return {
        why: '把报错吞掉了：路径写错时看起来像没搜到',
        patch: (t) => t.replace(re, ''),
      }
    },
  },
]
