import { pinyinInitials } from '../pinyin.ts'

/**
 * 文本匹配的统一入口（可统一能力盘点第 10 项，开放给插件）：通配、路径 glob、列表搜索的命中和打分。
 * 以前 glob 有 5 份（hooks、教训、测试步骤、表格两处），UE 里两个 wildcard 参数顺序还是反的，
 * 列表搜索有的分词有的不分、只有表格的树认拼音首字母。新地方一律用这里的，不再自己拼正则。
 */

const ESC = /[.+^${}()|[\]\\]/g
const esc = (s: string) => s.replace(ESC, '\\$&')

const wildCache = new Map<string, RegExp>() // 模块状态：缓存，丢了重算

/** 通配转正则：`*` 任意串（含 /）、`?` 一个字符，整句匹配，不分大小写（和 UE 的 FString::MatchesWildcard 一样） */
export function wildcardRe(pattern: string): RegExp {
  const p = pattern.trim()
  let re = wildCache.get(p)
  if (!re) {
    re = new RegExp(`^${esc(p).replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i')
    if (wildCache.size > 2000) wildCache.clear()
    wildCache.set(p, re)
  }
  return re
}

/** subject 是不是匹配通配 pattern（参数顺序：被比的在前）；空模式和 `*` 匹配一切 */
export function wildcard(subject: string, pattern: string): boolean {
  const p = pattern.trim()
  if (!p || p === '*') return true
  return wildcardRe(p).test(subject.trim())
}

export interface GlobOptions {
  /** 不分大小写（Windows 路径、用户写的表格通配）；默认分 */
  ignoreCase?: boolean
  /**
   * 没写通配符的写法（`web/src`、`web/`）也按目录前缀算：教训、测试步骤里的 paths 就是这么写的，
   * 用户照抄过来不能变成永远匹配不上的规则
   */
  dirPrefix?: boolean
}

const globCache = new Map<string, RegExp>() // 模块状态：缓存，丢了重算

/**
 * 路径 glob 转正则：`**` 跨目录（`**\/` 还能匹配零层，`**\/*.cpp` 认得仓库根下的 a.cpp），`*` 不跨 `/`，`?` 一个非 `/` 字符，
 * `{a,b}` 二选一。反斜杠先换成 /，去掉开头的 `./` 和结尾的 `/`
 */
export function globRe(glob: string, o: GlobOptions = {}): RegExp {
  const key = `${o.ignoreCase ? 'i' : ''}${o.dirPrefix ? 'd' : ''}:${glob}`
  let hit = globCache.get(key)
  if (hit) return hit
  const g = normPath(glob)
  let re = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*' && g[i + 1] === '*') {
      i++
      if (g[i + 1] === '/') {
        i++
        re += '(?:.*/)?'
      } else re += '.*'
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else if (c === '{' && g.indexOf('}', i) > i) {
      const e = g.indexOf('}', i)
      re += `(?:${g
        .slice(i + 1, e)
        .split(',')
        .map(esc)
        .join('|')})`
      i = e
    } else re += esc(c)
  }
  const plain = o.dirPrefix && !/[*?{]/.test(g)
  hit = new RegExp(`^${re}${plain ? '(?:/.*)?' : ''}$`, o.ignoreCase ? 'i' : '')
  if (globCache.size > 5000) globCache.clear()
  globCache.set(key, hit)
  return hit
}

/** 相对路径统一成 /、去掉 ./ 开头和 / 结尾 */
export const normPath = (p: string) => p.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')

export function globMatch(glob: string, file: string, o: GlobOptions = {}): boolean {
  const f = normPath(file)
  return !!f && globRe(glob, o).test(f)
}

/** 逗号或换行分开的一组通配 */
export const splitPatterns = (s: string) =>
  s
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean)

const initialsCache = new Map<string, string>() // 模块状态：缓存，丢了重算
function initialsOf(s: string) {
  let v = initialsCache.get(s)
  if (v === undefined) {
    v = pinyinInitials(s)
    if (initialsCache.size > 50_000) initialsCache.clear()
    initialsCache.set(s, v)
  }
  return v
}

/** 搜索词拆成小写的词（空格分开） */
export const queryWords = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean)

/**
 * 列表搜索的命中：空格分开的几个词都要出现在某一个字段里（不分大小写）；纯字母的词也认拼音首字母（jsb 找「角色表」）。
 * 空搜索词算命中
 */
export function textHit(fields: string | (string | undefined | null)[], query: string): boolean {
  const words = queryWords(query)
  if (!words.length) return true
  const list = (Array.isArray(fields) ? fields : [fields]).filter((x): x is string => !!x)
  return words.every((w) =>
    list.some((f) => f.toLowerCase().includes(w) || (/^[a-z]+$/.test(w) && initialsOf(f).includes(w))),
  )
}

/**
 * 命中的好坏，排序用（越大越靠前，0 是没命中）：整个相等 > 开头 > 词首（_ - / . 空格或大写字母后面）> 包含 > 拼音首字母。
 * 多个词时每个词都要命中，分数取最差的那个词
 */
export function textScore(text: string, query: string): number {
  const words = queryWords(query)
  if (!words.length) return 1
  const low = text.toLowerCase()
  let worst = Infinity
  for (const w of words) {
    let s = 0
    if (low === w) s = 100
    else if (low.startsWith(w)) s = 80
    else {
      const at = low.indexOf(w)
      if (at > 0) s = /[\s_\-/.:]/.test(text[at - 1]) || /[A-Z]/.test(text[at]) ? 60 : 40
      else if (/^[a-z]+$/.test(w) && initialsOf(text).includes(w)) s = 20
    }
    if (!s) return 0
    worst = Math.min(worst, s)
  }
  return worst
}
