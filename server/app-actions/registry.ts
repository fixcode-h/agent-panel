import { z } from 'zod'
import { log } from '../log.ts'

/**
 * 软件操作的动作注册表（见 docs/adr/0011-app-actions-for-agents.md）：
 * Agent 经 MCP 的 app_actions / app_do、脚本经 /api/actions 调的都是这一份表。
 * 加一个能力 = 在对应组的文件里加一项 defineAction，工具表、派发、提示词都不用改。
 */

/** read 只读；write 能改回来；danger 停止、删除这类不可撤销的，只在用户明确要求时用 */
export type ActionLevel = 'read' | 'write' | 'danger'

/** 谁在调：对话里的 CLI 调用才有，HTTP 入口没有 */
export interface ActionCaller {
  taskId: string
  projectId: string
  /** 子对话的父对话；顶层对话为空 */
  parentTaskId: string
}

export interface ActionHost {
  /** 进程内调面板自己的接口（path 不带 /api）：和界面点按钮走同一段代码 */
  api(method: string, path: string, body?: unknown): Promise<unknown>
  /** 推给打开着的面板页面做界面操作，返回几个页面收到 */
  ui(action: string, args: Record<string, unknown>): number
}

export interface ActionCtx extends ActionHost {
  caller?: ActionCaller
}

export interface AppAction {
  /** <组>.<动词>，组名就是所在文件名 */
  name: string
  title: string
  /** 给模型看：什么时候用、会怎样 */
  description: string
  level: ActionLevel
  input: z.ZodType
  run(args: any, ctx: ActionCtx): Promise<unknown>
}

/** 参数类型由 input 推出来，run 里不用再自己断言 */
export function defineAction<S extends z.ZodType>(a: {
  name: string
  title: string
  description: string
  level: ActionLevel
  input: S
  run(args: z.infer<S>, ctx: ActionCtx): Promise<unknown>
}): AppAction {
  return a
}

/** 动作里出的错：原因直接交给模型 */
export class ActionError extends Error {}

export const groupOf = (name: string) => name.split('.')[0]

export function createRegistry(list: AppAction[]) {
  const map = new Map<string, AppAction>()
  for (const a of list) {
    if (!/^[a-z]+\.[a-z_]+$/.test(a.name)) throw new Error(`动作名要写成 <组>.<动词>：${a.name}`)
    if (map.has(a.name)) throw new Error(`动作重名：${a.name}`)
    map.set(a.name, a)
  }
  return {
    list: (group?: string) => [...map.values()].filter((a) => !group || groupOf(a.name) === group),
    get: (name: string) => map.get(name),
    groups: () => [...new Set([...map.keys()].map(groupOf))],
    /** 执行一个动作：参数先过 zod；出错时返回原因而不是抛出，模型和 HTTP 调用方都按 ok 判断 */
    async run(
      name: string,
      raw: unknown,
      ctx: ActionCtx,
    ): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
      const a = map.get(name)
      if (!a) return { ok: false, error: `没有这个动作：${name}。可用的动作：${[...map.keys()].join('、')}` }
      const p = a.input.safeParse(raw ?? {})
      if (!p.success) return { ok: false, error: `${name} 的参数不对：${z.prettifyError(p.error)}` }
      const started = Date.now()
      const who = { action: name, caller: ctx.caller?.taskId ?? '' }
      try {
        const result = await a.run(p.data, ctx)
        log.info('action', `执行了 ${name}`, { ...who, ms: Date.now() - started })
        return { ok: true, result: result ?? { ok: true } }
      } catch (e) {
        const error = (e as Error).message || String(e)
        log.warn('action', `${name} 没有执行成功`, { ...who, error })
        return { ok: false, error }
      }
    },
  }
}

export type ActionRegistry = ReturnType<typeof createRegistry>

/** 参数说明：从 zod 生成 JSON Schema，只留模型要看的属性、类型、说明和必填 */
export function paramsOf(a: AppAction) {
  const s = z.toJSONSchema(a.input, { io: 'input', unrepresentable: 'any' }) as {
    properties?: Record<string, Record<string, unknown>>
    required?: string[]
  }
  return { properties: s.properties ?? {}, required: s.required ?? [] }
}

/** 给模型看的动作目录：一个动作一段，参数写成「名字?: 类型 — 说明」 */
export function catalogText(list: AppAction[]) {
  if (!list.length) return '没有这一组动作'
  return list
    .map((a) => {
      const { properties, required } = paramsOf(a)
      const params = Object.entries(properties).map(([k, v]) => {
        const type = Array.isArray(v.enum) ? v.enum.map((x) => JSON.stringify(x)).join(' | ') : String(v.type ?? 'any')
        const desc = typeof v.description === 'string' ? ` — ${v.description}` : ''
        return `    ${k}${required.includes(k) ? '' : '?'}: ${type}${desc}`
      })
      return [
        `${a.name} [${a.level}] ${a.title}`,
        `  ${a.description}`,
        ...(params.length ? ['  参数：', ...params] : []),
      ].join('\n')
    })
    .join('\n\n')
}

/** 进程内调接口：拿到 JSON，非 2xx 把接口给的原因抛成 ActionError */
export async function callApi(
  fetcher: (req: Request) => Response | Promise<Response>,
  method: string,
  path: string,
  body?: unknown,
) {
  const port = Number(process.env.PORT ?? 8787)
  const res = await fetcher(
    new Request(`http://127.0.0.1:${port}/api${path}`, {
      method,
      headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  if (!res.ok) {
    const why = data && typeof data === 'object' && 'error' in data ? String((data as { error: unknown }).error) : text
    throw new ActionError(why || `接口返回 ${res.status}`)
  }
  return data
}
