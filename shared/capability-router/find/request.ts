/**
 * 把 find 工具的参数翻成 FindRequest，并推出语言：Agent 不用说「这是 Lua」，按扩展名、目录、名字的写法推。
 * 推不出来时是 other：先走面板按文本找，没查到才问外部服务，不会把 C++ 名字先交给 Lua 的服务
 */
import { FIND_KINDS, FIND_LANGS, type FindKind, type FindLang, type FindRequest } from './types.ts'
import { categoryOf } from './categories.ts'

const extOf = (p: string) => p.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? ''

/**
 * 按扩展名、目录、名字写法推是哪一类（规则在 ./categories.ts 的分类表）；拿不准返回 other。
 * include / members 只有 C++ 有
 */
export function inferLang(r: Pick<FindRequest, 'query' | 'under' | 'ext' | 'file' | 'kind'>): FindLang {
  const exts = [...(r.ext ?? [])]
  if (r.file) exts.push(extOf(r.file))
  if (r.kind === 'outline') exts.push(extOf(r.query))
  const lang = categoryOf({ query: r.query, exts: exts.filter(Boolean), dirs: r.under ?? [] })
  if (lang === 'other' && (r.kind === 'include' || r.kind === 'members')) return 'cpp'
  return lang
}

const list = (v: unknown): string[] | undefined => {
  const xs = Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(',') : []
  const out = xs.map((x) => x.trim()).filter(Boolean)
  return out.length ? out : undefined
}
const int = (v: unknown, dflt: number, min: number, max: number) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : dflt
}

export const isFindKind = (v: string): v is FindKind => (FIND_KINDS as readonly string[]).includes(v)

/** 工具参数 → 请求；参数不对返回说明（写清怎么改） */
export function findRequestOf(kind: FindKind, a: Record<string, unknown>): FindRequest | string {
  const query = typeof a.query === 'string' ? a.query.trim() : ''
  if (!query) return kind === 'outline' ? 'outline 要在 query 里写文件路径' : `${kind} 要在 query 里写要找的名字或文本`
  const base = {
    kind,
    query,
    under: list(a.under),
    ext: list(a.ext),
    file: typeof a.file === 'string' && a.file.trim() ? a.file.trim() : undefined,
    line: a.line === undefined ? undefined : int(a.line, 0, 1, 1e7) || undefined,
  }
  const lang =
    typeof a.lang === 'string' && (FIND_LANGS as readonly string[]).includes(a.lang)
      ? (a.lang as FindLang)
      : inferLang(base)
  return {
    ...base,
    lang,
    wide: a.wide === true || a.wide === 'true',
    limit: int(a.limit, kind === 'outline' ? 100 : 50, 1, 200),
    offset: int(a.offset, 0, 0, 100_000),
  }
}

/** 记录里一句话说清要什么 */
export function describeFind(r: FindRequest): string {
  const lang = r.lang === 'cpp' ? 'C++ ' : r.lang === 'lua' ? 'Lua ' : r.lang === 'data' ? '文件 ' : ''
  const what = { symbol: '声明', refs: '引用', outline: '大纲', members: '成员', include: '头文件', text: '文本' }[
    r.kind
  ]
  return `${lang}${what} ${r.query}`
}
