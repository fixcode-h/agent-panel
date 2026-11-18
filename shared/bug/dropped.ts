/**
 * 交报告、记档案时，Agent 写了却被档案 schema 悄悄丢掉的字段。
 * 档案 schema 为了容错，字段几乎都带 `.catch`：数组超了条数、某一项格式不对，整组变成 []；字符串超了长度变成 ''。
 * 丢掉本身不报错，后面的核对就拿着空数组说「C1 在 codeRefs 里没有」——Agent 明明写了，只好乱改别处
 * （实跑 2026-11-18：codeRefs 写了 8 条，上限 6 条整组被丢，退回的话却指向 stack 的 refs，三次退回用完停下）。
 * 这里把 Agent 原样交上来的值和解析后的值对一遍，丢了的按路径和原因列出来，一次说清。只放纯函数
 */
import { z } from 'zod'

/** 最多列几处：再多 Agent 也是整块重写 */
const MAX_LIST = 8

type Schema = z.ZodType
type Def = { type: string; innerType?: Schema; shape?: Record<string, Schema>; element?: Schema }
const defOf = (s: Schema) => (s as unknown as { _zod: { def: Def } })._zod.def

/** 去掉 default / catch / optional 这几层包装，拿到真正校验的那一层 */
function bare(s: Schema): Schema {
  let cur = s
  for (let i = 0; i < 10; i++) {
    const d = defOf(cur)
    if (!['default', 'prefault', 'catch', 'optional', 'nullable', 'readonly'].includes(d.type) || !d.innerType)
      return cur
    cur = d.innerType
  }
  return cur
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
/** 原样交上来的「有内容」：空串、空数组、undefined 不算 */
const filled = (v: unknown) =>
  v !== undefined && v !== null && !(typeof v === 'string' && !v.trim()) && !(Array.isArray(v) && !v.length)
/** 解析后被清空了 */
const emptied = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)

/** 为什么没收下：用不带 catch 的那一层重新校验，取第一条问题 */
function reason(s: Schema, raw: unknown): string {
  const r = s.safeParse(raw)
  if (r.success) return '格式不对'
  const is = r.error.issues[0] as {
    code: string
    path: PropertyKey[]
    maximum?: number | bigint
    minimum?: number | bigint
    origin?: string
    expected?: string
  }
  const [head, ...rest] = is.path
  const where =
    head === undefined
      ? ''
      : `${typeof head === 'number' ? `第 ${head + 1} 项` : String(head)}${rest.length ? `的 ${rest.map(String).join('.')}` : ''}`
  const unit = is.origin === 'string' ? '字' : '条'
  const size = typeof raw === 'string' ? `${raw.length} 字` : Array.isArray(raw) ? `${raw.length} 条` : ''
  const what =
    is.code === 'too_big'
      ? `最多 ${String(is.maximum)} ${unit}${!where && size ? `，交了 ${size}` : ''}`
      : is.code === 'too_small'
        ? `至少 ${String(is.minimum)}`
        : is.code === 'invalid_type'
          ? `类型不对，要 ${is.expected ?? '别的类型'}`
          : is.code === 'invalid_value'
            ? '取值不在可选的几个里'
            : '格式不对'
  return where ? `${where}，${what}` : what
}

function walk(schema: Schema, raw: unknown, got: unknown, path: string, out: string[]) {
  if (out.length >= MAX_LIST || !filled(raw)) return
  const s = bare(schema)
  const d = defOf(s)
  const shorter = Array.isArray(raw) && Array.isArray(got) && got.length < raw.length
  if (emptied(got) || shorter) {
    out.push(`${path}：${reason(s, raw)}，整${Array.isArray(raw) ? '组' : '项'}没收下`)
    return
  }
  if (d.type === 'object' && d.shape && isObj(raw) && isObj(got))
    for (const [k, sub] of Object.entries(d.shape)) walk(sub, raw[k], got[k], `${path}.${k}`, out)
  else if (d.type === 'array' && d.element && Array.isArray(raw) && Array.isArray(got))
    raw.forEach((x, i) => walk(d.element!, x, got[i], `${path}[${i}]`, out))
}

/**
 * Agent 交的这些字段里被 schema 丢掉的地方；都收下了返回 ''。
 * shape 是档案 schema 的字段表（BugCase.shape），input 是 Agent 原样交的参数
 */
export function droppedFields(shape: Record<string, Schema>, input: Record<string, unknown>): string {
  const out: string[] = []
  for (const [k, schema] of Object.entries(shape)) {
    if (!filled(input[k])) continue
    const r = schema.safeParse(input[k])
    walk(schema, input[k], r.success ? r.data : undefined, k, out)
  }
  if (!out.length) return ''
  return `这些字段写了但没收下（超了上限或格式不对，面板会把整组丢掉，后面的编号核对也会跟着对不上）：\n${out.map((x) => `- ${x}`).join('\n')}\n按上限删减或改好格式再交。`
}
