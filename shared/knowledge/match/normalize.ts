import { commandSegments } from '../../hooks/defs.ts'

/**
 * 输入归一成检索键（设计稿 4.4.1）：需求原文、命令、搜索参数拆成词，命令取「目的」。
 * 推送、knowledge_lookup、回放评测共用这一份，纯函数
 */

/** 太常见、匹配了也说明不了什么的词 */
// 模块状态：常量，加载后不改
const STOP = new Set(
  (
    'the and for with from this that are was not but you your have has can will all any use used using get set new ' +
    'src lib dist test tests spec file files dir path line col error errors warn warning info debug failed fail failure ' +
    'true false null undefined const let var function return import export default class type types string number ' +
    'object array value values name names data json yml yaml txt log logs cmd exe ' +
    'npm node git run main dev index'
  ).split(' '),
)

/**
 * 拆成检索词：英文按驼峰、下划线、点、连字符拆开并保留整词（UDropTable → u、drop、table、udroptable），
 * 中文两字一组（和 shared/experience.ts 的 queryTerms 同一个思路）。一个字母的、停用词不算
 */
export function wordsOf(s: string): string[] {
  const out = new Set<string>()
  for (const raw of s.split(/[^A-Za-z0-9一-鿿]+/)) {
    if (!raw) continue
    if (/[一-鿿]/.test(raw)) {
      for (const han of raw.match(/[一-鿿]+/g) ?? [])
        if (han.length <= 2) out.add(han)
        else for (let i = 0; i + 2 <= han.length; i++) out.add(han.slice(i, i + 2))
      for (const x of raw.split(/[一-鿿]+/)) addAscii(out, x)
    } else addAscii(out, raw)
  }
  return [...out].filter((w) => !STOP.has(w))
}

function addAscii(out: Set<string>, raw: string) {
  if (!raw) return
  const whole = raw.toLowerCase()
  if (whole.length >= 2 && !/^\d+$/.test(whole)) out.add(whole)
  // 驼峰：UDropTable → U Drop Table；HTTPServer → HTTP Server
  const parts = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_]+/)
  if (parts.length > 1) for (const p of parts) if (p.length >= 3 && !/^\d+$/.test(p)) out.add(p.toLowerCase())
}

/** 程序名归一：去掉目录和 .exe / .cmd，小写 */
export const prog = (s: string) =>
  s
    .replace(/^["']|["']$/g, '')
    .split(/[\\/]/)
    .pop()!
    .replace(/\.(exe|cmd|bat|ps1)$/i, '')
    .toLowerCase()

/** 一段命令拆成词，去掉环境变量赋值、sudo、npx、env 这类前缀：剩下的开头几个词就是这条命令的「目的」 */
export function commandWords(seg: string): string[] {
  const words = seg.trim().split(/\s+/).filter(Boolean)
  let i = 0
  while (i < words.length) {
    const w = words[i]
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || /^(sudo|npx|time|command|exec|call|&)$/i.test(w)) i++
    else if (/^env$/i.test(w)) {
      i++
      // env -u NAME / env -i / env NAME=value
      while (i < words.length && (words[i].startsWith('-') || /=/.test(words[i]))) i += words[i] === '-u' ? 2 : 1
    } else break
  }
  const rest = words.slice(i)
  if (!rest.length) return []
  return [prog(rest[0]), ...rest.slice(1).map((w) => w.replace(/^["']|["']$/g, ''))]
}

/**
 * 搜索工具（Grep、Glob、rg、grep、find…）要搜什么：从参数里抠出字面量词。
 * 读文件类工具看 pattern / query / glob / regex 这几个参数（各家搜索工具都这么叫，不按工具名判断）；
 * 跑命令看每段命令是不是搜索命令。不是搜索返回 null
 */
export function searchText(kind: string, input: Record<string, unknown>): string | null {
  if (kind === 'read') {
    const v = ['pattern', 'query', 'regex', 'glob', 'name']
      .map((k) => input[k])
      .filter((x): x is string => typeof x === 'string' && !!x.trim())
    return v.length ? v.join(' ') : null
  }
  if (kind !== 'shell') return null
  const out: string[] = []
  for (const seg of commandSegments(String(input.command ?? ''))) {
    const ws = commandWords(seg)
    const p = ws[0]
    if (!p) continue
    const sub =
      p === 'git' && ws[1] === 'grep' ? 2 : /^(rg|grep|egrep|ag|ack|findstr|select-string|sls|fd)$/.test(p) ? 1 : 0
    if (sub) {
      // 第一个不是选项的参数是要搜的东西（-e 后面跟的也是）；带值的选项（--type ts、-g '*.h'）跳过它的值
      for (let i = sub; i < ws.length; i++) {
        if (ws[i] === '-e' || ws[i] === '--regexp' || ws[i] === '-Pattern') {
          if (ws[i + 1]) out.push(ws[i + 1])
          break
        }
        if (VALUE_OPTS.has(ws[i])) {
          i++
          continue
        }
        if (!ws[i].startsWith('-')) {
          out.push(ws[i])
          break
        }
      }
    } else if (p === 'find' || p === 'get-childitem' || p === 'gci') {
      for (let i = 1; i < ws.length - 1; i++) if (/^-(i?name|i?path|filter|include)$/i.test(ws[i])) out.push(ws[i + 1])
    }
  }
  return out.length ? out.join(' ') : null
}

/** 搜索命令里后面跟一个值的选项：值不是要搜的东西 */
// 模块状态：常量，加载后不改
const VALUE_OPTS = new Set(
  '-t --type -T --type-not -g --glob --iglob -A -B -C --context --after-context --before-context -m --max-count --max-depth -d -j --threads -M --max-columns --include --exclude --exclude-dir -f --file -Path -Include'.split(
    ' ',
  ),
)

/** 正则、glob 里的字面量：去掉转义类和量词（DT_\w+Row → DT Row），再拆成检索词 */
export function searchWords(q: string): string[] {
  const lit = q
    .replace(/\\[wdsbWDSB]/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[.*+?^$(){}|\\]/g, ' ')
  return wordsOf(lit)
}
