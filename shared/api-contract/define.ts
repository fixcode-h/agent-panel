/**
 * 前后端接口契约的写法（重构文档第 9 条，ADR 0050）：每个接口一条 `endpoint({ method, path, body?, res })`，
 * 按模块放在 shared/api-contract/<模块>.ts。
 *
 * - 前端：web/src/lib/api-call.ts 的 `call(ep, …)` 按契约拼地址、带方法，返回类型从 `res` 推出来，
 *   不再在 api.ts 里手写 `request<T>`。
 * - 正式后端：路由校验入参用契约里的 `body`；出参在测试里按 `res` 查（scripts/e2e/17-contracts.mjs）。
 * - 演示后端：同一份探查（probe.ts）在 web/src/lib/demo-contract.test.ts 里跑。
 *
 * `res` 只写界面真读的字段时，用 `shaped<T>(schema)` 指定完整类型：运行时按 schema 查，类型按 T 给界面。
 * T 应该是前后端共用的函数产出的类型（例如 shared/child-row.ts 的 ChildRow），不要在这里另写一份。
 */
import { z } from 'zod'

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface Endpoint {
  method: Method
  /** 相对 /api 的路径，`:name` 是路径参数 */
  path: string
  /** 请求体（GET / DELETE 没有） */
  body?: z.ZodType
  /** 返回体；204 无内容的接口写 z.void() */
  res: z.ZodType
}

/** 定义一个接口：只是原样返回，好让 TypeScript 记住路径、方法和 schema 的字面类型 */
export const endpoint = <const E extends Endpoint>(e: E) => e

/**
 * 运行时按 schema 查、类型按 T 给：res 只写了界面必读的字段（looseObject），完整类型来自共用的函数或类型。
 * 返回的仍然是原来那个 schema，只是在类型上标成 ZodType<T>
 */
export const shaped = <T>(schema: z.ZodType) => schema as unknown as z.ZodType<T>

/** 返回体的类型（parse 之后的样子） */
export type ResOf<E extends Endpoint> = z.output<E['res']>
/**
 * 请求体的类型：按 parse 之后的样子（和 api.ts 一直传的 AgentInput 这类 z.infer 类型一致）。
 * 不用 z.input：带迁移（z.preprocess）的 schema 入参类型是 unknown，等于没有类型
 */
export type BodyOf<E extends Endpoint> = E['body'] extends z.ZodType ? z.output<E['body']> : never

/** 路径里的参数：'/tasks/:id/children' → { id: string } */
export type PathParams<P extends string> = P extends `${string}:${infer K}/${infer Rest}`
  ? { [k in K]: string } & PathParams<`/${Rest}`>
  : P extends `${string}:${infer K}`
    ? { [k in K]: string }
    : Record<never, never>

export type Query = Record<string, string | number | boolean | undefined>

/** 拼出实际地址：路径参数做 URL 编码，查询参数里 undefined / 空字符串的不带 */
export function urlOf(path: string, params: Record<string, string> = {}, query: Query = {}) {
  const filled = path.replace(/:(\w+)/g, (_, k: string) => {
    const v = params[k]
    if (v === undefined) throw new Error(`接口 ${path} 少了路径参数 ${k}`)
    return encodeURIComponent(v)
  })
  const q = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&')
  return q ? `${filled}?${q}` : filled
}

/**
 * 返回值是不是真的符合契约：parse 失败当然不符合；parse 成功但 schema 替它补了字段（默认值）也不符合——
 * 那说明服务端（或演示后端）没给这个字段，界面拿到的和 schema 推出的类型对不上。
 * 返回问题列表，空数组就是符合。只报前几条，免得一个数组里每项都报一遍
 */
export function contractProblems(schema: z.ZodType, value: unknown, limit = 8): string[] {
  const r = schema.safeParse(value)
  if (!r.success) return [z.prettifyError(r.error)]
  const out: string[] = []
  filled(value, r.data, '', out, limit)
  return out.map((p) => `缺字段 ${p}（schema 用默认值补上了）`)
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)

function filled(raw: unknown, parsed: unknown, at: string, out: string[], limit: number) {
  if (out.length >= limit) return
  if (Array.isArray(raw) && Array.isArray(parsed)) {
    parsed.forEach((p, i) => filled(raw[i], p, `${at}[${i}]`, out, limit))
    return
  }
  if (!isObj(raw) || !isObj(parsed)) return
  for (const [k, v] of Object.entries(parsed)) {
    if (!(k in raw)) {
      if (v !== undefined) out.push(`${at}.${k}`)
      if (out.length >= limit) return
      continue
    }
    filled(raw[k], v, `${at}.${k}`, out, limit)
  }
}
