/**
 * 查找结果的读、合、写：
 * - 外部服务的 JSON 按通用规则读成命中（UEToVS、EmmyLua 的 lua_code 都是 {items:[{file,line,col,name,kind,…}]}，
 *   引用另带 target）；
 * - 几条路的结果合并去重，按「声明 → 引用 → 其他文本」排；
 * - 写成给 Agent 的文字：一行一条「路径:行: 内容」，和 rg 一样好读；默认不超过 4000 字（ADR 0067），超了给 nextOffset
 */
import type { FindHit, FindOutcome, FindRequest } from './types.ts'

const BUDGET = 4000

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/** 路径换成相对项目根、正斜杠；项目外的保留绝对路径 */
export function relPath(file: string, roots: string[]): string {
  const f = file.replace(/\\/g, '/')
  for (const r of roots) {
    const root = r.replace(/\\/g, '/').replace(/\/+$/, '')
    if (!root) continue
    if (f.toLowerCase().startsWith(root.toLowerCase() + '/')) return f.slice(root.length + 1)
  }
  return f
}

const DECL_KINDS =
  /^(class|struct|enum|union|interface|function|method|field|variable|property|table|module|typedef|macro|namespace|delegate|enum_value|constructor|destructor|operator)$/i

/** 一项 → 命中；没有文件的不要（Agent 拿到没法读） */
function hitOf(
  x: Record<string, unknown>,
  rank: 0 | 1 | 2,
  roots: string[],
  fallbackFile?: string,
): FindHit | undefined {
  const file = s(x.file) ?? s(x.path) ?? fallbackFile
  if (!file) return undefined
  const kind = s(x.kind)
  return {
    file: relPath(file, roots),
    ...(num(x.line) && { line: num(x.line) }),
    ...(num(x.col) && { col: num(x.col) }),
    ...(s(x.name) && { name: s(x.name) }),
    ...(kind && { kind }),
    ...(s(x.container) && { container: s(x.container) }),
    ...((s(x.sig) ?? s(x.text) ?? s(x.signature)) && { text: s(x.sig) ?? s(x.text) ?? s(x.signature) }),
    rank,
  }
}

/**
 * 通用读法：{items:[…]}（可带 note、hasMore）或直接一个数组；引用结果的 items 里声明那一条（kind 是 declaration / def）排前面。
 * 读不懂返回 undefined（调用方按「这条路出错」往下走）
 */
export function parseFindJson(json: unknown, req: FindRequest, roots: string[]): FindOutcome | undefined {
  const o = (json && typeof json === 'object' ? json : undefined) as Record<string, unknown> | undefined
  const items = Array.isArray(json) ? json : Array.isArray(o?.items) ? (o!.items as unknown[]) : undefined
  if (!items) return undefined
  const hits: FindHit[] = []
  const target = o?.target && typeof o.target === 'object' ? (o.target as Record<string, unknown>) : undefined
  if (req.kind === 'refs' && target) {
    const h = hitOf(target, 0, roots)
    if (h) hits.push(h)
  }
  for (const it of items) {
    if (!it || typeof it !== 'object') continue
    const x = it as Record<string, unknown>
    const k = s(x.kind) ?? ''
    const rank: 0 | 1 =
      req.kind === 'refs'
        ? /^(decl|declaration|definition|def)$/i.test(k) || x.def === true
          ? 0
          : 1
        : DECL_KINDS.test(k) || req.kind !== 'text'
          ? 0
          : 1
    // 大纲的各项不带文件（UEToVS 的 get_file_outline、lua_code 的 outline 都把文件写在外层）
    const h = hitOf(x, rank, roots, s(o?.file))
    if (h) hits.push(h)
  }
  return {
    hits,
    ...(o?.hasMore === true && { more: true }),
    ...(s(o?.note) && { note: s(o?.note) }),
  }
}

const keyOf = (h: FindHit) => `${h.file.toLowerCase()}:${h.line ?? 0}`

/** 合并几条路的命中：同一个文件同一行只留排得最前的那条，再按等级、文件、行排 */
export function mergeHits(groups: FindHit[][]): FindHit[] {
  const best = new Map<string, FindHit>()
  const order: string[] = []
  for (const g of groups)
    for (const h of g) {
      const k = keyOf(h)
      const cur = best.get(k)
      if (!cur) order.push(k)
      if (!cur || h.rank < cur.rank || (h.rank === cur.rank && !cur.name && h.name)) best.set(k, h)
    }
  // 同一等级里保持各条路自己的顺序（索引按相关度排过），不按路径重排
  return order
    .map((k, i) => ({ h: best.get(k)!, i }))
    .sort((a, b) => a.h.rank - b.h.rank || a.i - b.i)
    .map((x) => x.h)
}

/** 一条命中写成一行：路径:行: [种类 所属.名字] 内容 */
export function hitLine(h: FindHit): string {
  const loc = h.line ? `${h.file}:${h.line}` : h.file
  const sym = h.name ? `${h.kind ? `${h.kind} ` : ''}${h.container ? `${h.container}.` : ''}${h.name}` : ''
  const body = [sym, h.text && h.text !== h.name ? h.text : ''].filter(Boolean).join('  ')
  return body ? `${loc}: ${body.slice(0, 240)}` : loc
}

/** 写成给 Agent 的文字：按字数预算分页，至少给一条 */
export function formatHits(hits: FindHit[], req: FindRequest, notes: string[]): string {
  const page = hits.slice(req.offset)
  const out: string[] = []
  let used = 0
  for (const h of page.slice(0, req.limit)) {
    const l = hitLine(h)
    if (out.length && used + l.length + 1 > BUDGET - 300) break
    out.push(l)
    used += l.length + 1
  }
  const next = req.offset + out.length
  const head = hits.length ? `${hits.length} 条${req.offset ? `（从第 ${req.offset + 1} 条起）` : ''}：` : '没有找到。'
  const tail = next < hits.length ? `\n还有 ${hits.length - next} 条：offset=${next} 接着看。` : ''
  return [head, ...out, ...notes.filter(Boolean)].join('\n') + tail
}
