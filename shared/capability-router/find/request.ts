/**
 * 把 find 工具的参数翻成 FindRequest，并推出语言：Agent 不用说「这是 Lua」，按扩展名、目录、名字的写法推。
 * 推不出来时是 other：只走通用的路（文本搜索），不会把 C++ 名字错交给 Lua 的服务
 */
import { FIND_KINDS, type FindKind, type FindLang, type FindRequest } from './types.ts'

const LUA_EXT = /^lua$/
const CPP_EXT = /^(h|hpp|hh|hxx|inl|c|cc|cpp|cxx|ipp|cs)$/

const extOf = (p: string) => p.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? ''
const norm = (p: string) => p.replace(/\\/g, '/')

/** 按扩展名、目录、名字写法推语言；拿不准返回 other */
export function inferLang(r: Pick<FindRequest, 'query' | 'under' | 'ext' | 'file' | 'kind'>): FindLang {
  const exts = [...(r.ext ?? []).map((e) => e.replace(/^\./, '').toLowerCase())]
  if (r.file) exts.push(extOf(r.file))
  if (r.kind === 'outline') exts.push(extOf(r.query))
  if (exts.some((e) => LUA_EXT.test(e))) return 'lua'
  if (exts.some((e) => CPP_EXT.test(e))) return 'cpp'
  const dirs = (r.under ?? []).map((d) => norm(d).toLowerCase())
  // UnLua / slua 的脚本目录、C++ 的 Source 目录：UE 项目最常见的两种限定
  if (dirs.some((d) => /(^|\/)(content\/script|script|scripts|lua)(\/|$)/.test(d))) return 'lua'
  if (dirs.some((d) => /(^|\/)(source|plugins\/[^/]+\/source)(\/|$)/.test(d))) return 'cpp'
  // A:B 只有 Lua 有；A::B 只有 C++ 有；UE 的类型前缀（AActor、UObject、FVector、ECollision…）按 C++ 算
  if (/^[A-Za-z_]\w*:[A-Za-z_]\w*$/.test(r.query)) return 'lua'
  if (/::/.test(r.query)) return 'cpp'
  if (r.kind === 'include' || r.kind === 'members') return 'cpp'
  return 'other'
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
    typeof a.lang === 'string' && ['cpp', 'lua', 'other'].includes(a.lang) ? (a.lang as FindLang) : inferLang(base)
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
  const lang = r.lang === 'cpp' ? 'C++ ' : r.lang === 'lua' ? 'Lua ' : ''
  const what = { symbol: '声明', refs: '引用', outline: '大纲', members: '成员', include: '头文件', text: '文本' }[
    r.kind
  ]
  return `${lang}${what} ${r.query}`
}
