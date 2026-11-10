/**
 * 文件弹窗里的搜索：找出所有命中，按行分好；代码阅读区按行虚拟渲染，浏览器自带的查找搜不到屏幕外的行，
 * 所以弹窗自己做一套（阅读代码、Markdown、编辑三种模式共用同一个搜索框）。
 */

/** 一处命中：在全文里的起止位置 [from, to) */
export interface Hit {
  from: number
  to: number
}

/** 命中最多记这么多：搜一个字母时几十万处，全记下来既没用又卡 */
export const HIT_MAX = 10_000

/** 找出全文里所有命中（不重叠）；caseSensitive 为 false 时不分大小写 */
export function findHits(text: string, query: string, caseSensitive: boolean): Hit[] {
  if (!query) return []
  const hay = caseSensitive ? text : text.toLowerCase()
  const needle = caseSensitive ? query : query.toLowerCase()
  // toLowerCase 个别字会变长（土耳其语的 İ），长度对不上时位置就不准：这种情况退回逐字比较
  const same = hay.length === text.length && needle.length === query.length
  const out: Hit[] = []
  let at = same ? hay.indexOf(needle) : -1
  while (at >= 0 && out.length < HIT_MAX) {
    out.push({ from: at, to: at + query.length })
    at = hay.indexOf(needle, at + needle.length)
  }
  if (!same) {
    for (let i = 0; i + query.length <= text.length && out.length < HIT_MAX; i++) {
      if (text.slice(i, i + query.length).localeCompare(query, undefined, { sensitivity: 'accent' }) === 0) {
        out.push({ from: i, to: i + query.length })
        i += query.length - 1
      }
    }
  }
  return out
}

/** 每一行在全文里从哪开始（第 0 行从 0 开始） */
export function lineStarts(text: string) {
  const out = [0]
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) out.push(i + 1)
  return out
}

/** 位置落在第几行（从 0 数）：二分查找 */
export function lineOf(starts: number[], pos: number) {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= pos) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** 一行里要标出来的一段：列的起止 [from, to)，current 表示「当前这一处」 */
export interface LineMark {
  from: number
  to: number
  current: boolean
}

/** 命中按行分好（一行里可能有几处）：阅读区画哪几行就取哪几行的 */
export function hitsByLine(hits: Hit[], starts: number[], current: number) {
  const out = new Map<number, LineMark[]>()
  hits.forEach((h, i) => {
    const line = lineOf(starts, h.from)
    const list = out.get(line) ?? []
    // 命中不跨行（搜索框里输不进换行），列号就是减去行首
    list.push({ from: h.from - starts[line], to: h.to - starts[line], current: i === current })
    out.set(line, list)
  })
  return out
}

export const HIT_CLASS = 'file-hit'
export const HIT_CURRENT_CLASS = 'file-hit file-hit-current'

/**
 * 在一行高亮好的 HTML 里按字的位置套上 <mark>：只数标签外面的字（&amp; 这类实体算一个字），
 * 碰到标签时先收起 <mark>、标签之后再接着开，标签嵌套照旧合法。
 */
export function markHtml(html: string, marks: LineMark[]) {
  if (!marks.length) return html
  let out = ''
  let pos = 0
  let k = 0
  let open: LineMark | null = null
  const tag = (m: LineMark) =>
    `<mark class="${m.current ? HIT_CURRENT_CLASS : HIT_CLASS}"${m.current ? ' data-current' : ''}>`
  for (let i = 0; i < html.length;) {
    if (html[i] === '<') {
      const end = html.indexOf('>', i)
      const stop = end < 0 ? html.length : end + 1
      out += open ? `</mark>${html.slice(i, stop)}${tag(open)}` : html.slice(i, stop)
      i = stop
      continue
    }
    // 一个字：实体整个算一个
    let len = 1
    if (html[i] === '&') {
      const semi = html.indexOf(';', i)
      if (semi > i && semi - i <= 10) len = semi - i + 1
    }
    if (!open && k < marks.length && pos === marks[k].from) {
      open = marks[k]
      out += tag(open)
    }
    out += html.slice(i, i + len)
    i += len
    pos++
    if (open && pos >= open.to) {
      out += '</mark>'
      open = null
      k++
    }
  }
  if (open) out += '</mark>'
  return out
}
