import { z } from 'zod'
import type { TaskMessage } from './schema.ts'
import type { HookEventName, ToolKind } from './hook-defs.ts'

/**
 * 钩子（ADR 0049）：模型准备结束这一轮时（turn.beforeEnd），CLI 先问面板；计划没做完、也没在等任何结果时
 * 面板答「拦住」并给出下一步，CLI 在同一轮里接着做，对话里不再另起一轮【面板】提醒。第二期加了工具前、工具后、
 * 上下文恢复（压缩之后）三个事件，内置钩子和用户钩子都挂在它们上（规范见 shared/hook-defs.ts）。
 *
 * 这里放和 CLI 无关的部分：CLI 定义里的 hooks 字段、面板的判断结果、给 Claude Code 这类「钩子是一条命令」的 CLI
 * 用的转发脚本。怎么装进 CLI（参数、扩展、mod）写在各自的 CLI 定义里，代码按字段走，不按 CLI 的名字分支。
 *
 * 硬规则：面板只按结构化状态判断（计划、提问、子对话、后台命令、submit_* 交没交），不读模型回复的文字。
 * 转发脚本发给面板之前就把原生输入里的回复文字（last_assistant_message 这类）丢掉，面板根本拿不到
 */

/**
 * CLI 定义里的「结束前钩子」怎么装：
 * - via=command：CLI 的钩子是一条命令（Claude Code 的 Stop）。面板在这一轮的临时目录写转发脚本（{hookScript}）
 *   和 files 里的配置；拦住时转发脚本把 block 模板（{reason} 填好）原样打印给 CLI。
 * - via=extension：钩子写在面板每轮已经装进 CLI 的扩展里（Pi 的 -e 桥接扩展、Command Code 的 --mod），
 *   扩展自己按 HOOK_URL_ENV 或 {url}/hook 问面板，这里只声明「这个 CLI 支持」。
 * 钩子配置可以写进文件（files，Claude Code 的 --settings），也可以直接写成参数（args，Codex 的 -c hooks.Stop=…）
 */
export const BeforeEndSpec = z.object({
  via: z.enum(['command', 'extension']),
  files: z.record(z.string(), z.unknown()).default({}),
  /** 装这个事件要加的参数（钩子配置直接写在参数里的 CLI） */
  args: z.array(z.string()).default([]),
  /** 拦住时 CLI 要的输出（via=command）；里面的 {reason} 换成面板给的说明 */
  block: z.unknown().optional(),
  why: z.string().default(''),
})
export type BeforeEndSpec = z.infer<typeof BeforeEndSpec>

/** 工具前、工具后、上下文恢复：都是一条命令的钩子（Claude Code、Codex），files 是要合进钩子配置的那一段，args 是要加的参数 */
export const EventSpec = z.object({
  files: z.record(z.string(), z.unknown()).default({}),
  args: z.array(z.string()).default([]),
  /** 拒绝这次工具调用时 CLI 要的输出（tool.before），{reason} 换成原因 */
  deny: z.unknown().optional(),
  /** 补给模型的一段说明（{text}）；没有这一项表示这个事件不能补说明 */
  context: z.unknown().optional(),
  why: z.string().default(''),
})
export type EventSpec = z.infer<typeof EventSpec>

export const HooksSpec = z.object({
  /** 装钩子要加的参数（命令类钩子的配置文件路径），有任何一个命令类事件要装时才加 */
  args: z.array(z.string()).default([]),
  /**
   * 钩子要先「信任」才会跑的 CLI 怎么信任面板自己的钩子：rpc 表示开始前用常驻协议查一遍钩子、
   * 只把命令里引用了 HOOK_SCRIPT_ENV 的那几条（面板的转发脚本）记成信任（Codex 的 hooks/list + config/batchWrite）
   */
  trust: z.enum(['rpc']).optional(),
  beforeEnd: BeforeEndSpec.optional(),
  events: z
    .object({
      'tool.before': EventSpec.optional(),
      'tool.after': EventSpec.optional(),
      'context.restored': EventSpec.optional(),
    })
    .default({}),
  /** 原生输入里要丢掉、不交给面板的字段（模型回复的文字），见上面的硬规则 */
  dropInput: z.array(z.string()).default([]),
  /** 各家工具名对照到面板的工具类别（用户钩子按类别匹配） */
  toolNames: z.record(z.string(), z.array(z.string())).default({}),
  /** 以这些开头的 shell 命令算改文件（Codex 的模型有时用 shell 跑 apply_patch，钩子收到的工具名是 Bash） */
  editCommands: z.array(z.string()).default([]),
  /** 原生输入里工具名、参数、文件路径在哪个字段 */
  toolFields: z
    .object({
      name: z.string().default('tool_name'),
      input: z.string().default('tool_input'),
      path: z.array(z.string()).default(['file_path']),
    })
    .default({ name: 'tool_name', input: 'tool_input', path: ['file_path'] }),
})
export type HooksSpec = z.infer<typeof HooksSpec>

/** 面板对「结束前」的回答：block 时 reason 是交给 Agent 的说明（不翻译），why 是写进日志的原因 */
export interface BeforeEndDecision {
  block: boolean
  reason?: string
  why: string
}

/** 转发时带上的原生输入里，面板唯一会看的字段：CLI 告诉面板这次是不是已经被钩子续过一次 */
export interface BeforeEndInput {
  again?: boolean
}

/** 工具前、工具后、上下文恢复交给面板的事实：都从原生输入里按 CLI 定义取，不含模型回复的文字 */
export interface HookFacts {
  /** path 是第一个文件（相对项目根判断范围时用）；paths 是这次要改的全部文件（补丁一次可以改好几个） */
  tool?: { kind: ToolKind; name: string; input: Record<string, unknown>; path: string; paths: string[] }
  /** 上下文恢复的来由：compact（压缩之后）、resume（续接）、startup（新开） */
  source?: string
}

/** 面板对其余事件的回答：deny 只对 tool.before，context 是补给模型的一段说明 */
export interface HookAnswer {
  deny?: boolean
  reason?: string
  context?: string
}

/** 放行：不表态 */
export const allowEnd = (why: string): BeforeEndDecision => ({ block: false, why })

/** 转发地址的环境变量：面板起 CLI 时放进去，钩子命令、Command Code 的 mod 从这里取 */
export const HOOK_URL_ENV = 'AGENT_PANEL_HOOK_URL'

/**
 * 转发脚本路径的环境变量：钩子命令写成 node "$AGENT_PANEL_HOOK_SCRIPT" 时，命令本身每轮都一样。
 * Codex 按命令内容算信任的哈希，路径每轮换（临时目录）的话每轮都要重新信任；引用环境变量就只需信任一次
 */
export const HOOK_SCRIPT_ENV = 'AGENT_PANEL_HOOK_SCRIPT'

/** Pi 扩展续跑时追加的那条消息的类型：面板的输出解析按它认出来，不画成用户消息 */
export const HOOK_CONTINUE_TYPE = 'agent-panel-continue'

/** 转发超时：面板没回就放行，钩子坏了不能把对话卡住（用户钩子自己可以设到 60 秒，转发就按它放宽） */
export const HOOK_TIMEOUT_MS = 5000
/** 转发脚本最多等面板这么久：用户钩子的超时上限 60 秒再留一点余量 */
export const FORWARD_TIMEOUT_MS = 65_000

/** 按模板填 {reason} / {text}：模板里的字符串原样替换，对象、数组逐层替换 */
export function fillTpl(tpl: unknown, vars: { reason?: string; text?: string }): unknown {
  if (typeof tpl === 'string')
    return tpl.replace(/\{reason\}/g, () => vars.reason ?? '').replace(/\{text\}/g, () => vars.text ?? '')
  if (Array.isArray(tpl)) return tpl.map((x) => fillTpl(x, vars))
  if (tpl && typeof tpl === 'object')
    return Object.fromEntries(Object.entries(tpl).map(([k, v]) => [k, fillTpl(v, vars)]))
  return tpl
}

/** 转发脚本在这一轮临时目录里的文件名 */
export const HOOK_SCRIPT = 'agent-panel-hook.mjs'

/** 这个 CLI（按定义）能装哪些事件：结束前看 beforeEnd，其余看 events */
export function supportedEvents(spec: HooksSpec | undefined): HookEventName[] {
  if (!spec) return []
  return [
    ...(spec.beforeEnd ? (['turn.beforeEnd'] as const) : []),
    ...(Object.keys(spec.events) as (keyof HooksSpec['events'])[]).filter((k) => spec.events[k]),
  ]
}

/** 同一个配置文件的几段合在一起：对象逐层合并，数组接在一起（几个事件各自往 hooks 下面加自己的那一项） */
function mergeConfig(a: unknown, b: unknown): unknown {
  if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b]
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const out: Record<string, unknown> = { ...(a as Record<string, unknown>) }
    for (const [k, v] of Object.entries(b as Record<string, unknown>)) out[k] = k in out ? mergeConfig(out[k], v) : v
    return out
  }
  return b
}

/**
 * 命令类钩子这一轮要加的参数和要写的文件：只装 active 里的事件（没人用的工具前 / 工具后不装，免得每次工具调用都多跑一次脚本）。
 * {dir} 换成面板这一轮的临时目录，{hookScript} 换成转发脚本。路径一律用正斜杠：钩子命令在 Windows 上也可能交给 bash 执行，
 * 反斜杠会被当成转义。没有要装的返回空
 */
export function hookInstall(spec: HooksSpec, dir: string, active: HookEventName[]) {
  const d = dir.replace(/\\/g, '/')
  const script = `${d}/${HOOK_SCRIPT}`
  const fill = (v: unknown): unknown =>
    typeof v === 'string'
      ? v.replace(/\{dir\}/g, () => d).replace(/\{hookScript\}/g, () => script)
      : Array.isArray(v)
        ? v.map(fill)
        : v && typeof v === 'object'
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [fill(k) as string, fill(x)]))
          : v
  const parts: { files: Record<string, unknown>; args: string[] }[] = []
  if (active.includes('turn.beforeEnd') && spec.beforeEnd?.via === 'command') parts.push(spec.beforeEnd)
  for (const ev of ['tool.before', 'tool.after', 'context.restored'] as const)
    if (active.includes(ev) && spec.events[ev]) parts.push(spec.events[ev]!)
  if (!parts.length)
    return {
      args: [] as string[],
      files: [] as { path: string; content: unknown }[],
      env: {} as Record<string, string>,
    }
  const merged = new Map<string, unknown>()
  for (const p of parts)
    for (const [k, v] of Object.entries(p.files)) merged.set(k, merged.has(k) ? mergeConfig(merged.get(k), v) : v)
  return {
    args: [...spec.args, ...parts.flatMap((p) => p.args)].map((a) => fill(a) as string),
    env: { [HOOK_SCRIPT_ENV]: script },
    files: [
      { path: script, content: hookForwarderSource(spec.dropInput) as unknown },
      ...[...merged].map(([p, content]) => ({ path: fill(p) as string, content: fill(content) })),
    ],
  }
}

/** 从原生输入里取「结束前」要的那一点：只认几个已知的「已经续过」标记，其余（含回复文字）一律不要 */
export function beforeEndInput(native: unknown, drop: string[] = []): BeforeEndInput {
  if (!native || typeof native !== 'object') return {}
  const o = { ...(native as Record<string, unknown>) }
  for (const k of drop) delete o[k]
  return { again: o.stop_hook_active === true }
}

/** 从原生输入里取工具前 / 工具后、上下文恢复要的事实：工具名对照到类别，文件路径按定义里的字段取 */
export function hookFacts(spec: HooksSpec, native: unknown): HookFacts {
  if (!native || typeof native !== 'object') return {}
  const o = native as Record<string, unknown>
  const name = typeof o[spec.toolFields.name] === 'string' ? (o[spec.toolFields.name] as string) : ''
  const source = typeof o.source === 'string' ? o.source : undefined
  if (!name) return source ? { source } : {}
  const raw = o[spec.toolFields.input]
  const input = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  let kind = (Object.entries(spec.toolNames).find(([, names]) => names.includes(name))?.[0] ?? 'any') as ToolKind
  const cmd = typeof input.command === 'string' ? input.command.trim() : ''
  if (kind === 'shell' && spec.editCommands.some((c) => cmd.startsWith(c))) kind = 'edit'
  const field = spec.toolFields.path.map((k) => input[k]).find((v) => typeof v === 'string') as string | undefined
  // 补丁（apply_patch）没有单独的路径参数：从补丁头「*** Add/Update/Delete File: 路径」里取
  const paths = field
    ? [field]
    : kind === 'edit'
      ? Object.values(input)
          .filter((v): v is string => typeof v === 'string')
          .flatMap((v) => [...v.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1].trim()))
      : []
  return { tool: { kind, name, input, path: paths[0] ?? '', paths }, ...(source ? { source } : {}) }
}

/**
 * 转发脚本（命令类钩子）：CLI 运行它时第一个参数是面板事件，stdin 进原生 JSON。
 * 只做转发，不判断：丢掉回复文字，POST 给面板，面板回了 output 就原样打印，其余（面板没起来、超时、出错）什么都不打印，
 * CLI 就照常往下走。用 node:http 不用 fetch：老版本 Node 没有 fetch，也省得被代理环境变量改道
 */
export function hookForwarderSource(drop: string[]) {
  return `// Agent 面板的钩子转发（ADR 0049）：只转发，不判断；面板没回就放行
import { request } from 'node:http'

const url = process.env.${HOOK_URL_ENV}
const event = process.argv[2] || 'turn.beforeEnd'
const DROP = ${JSON.stringify(drop)}
let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => (raw += c))
process.stdin.on('end', () => {
  if (!url) return
  let native = {}
  try {
    native = JSON.parse(raw || '{}')
  } catch {}
  for (const k of DROP) delete native[k]
  const body = JSON.stringify({ event, native })
  const req = request(url, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
    let text = ''
    res.setEncoding('utf8')
    res.on('data', (c) => (text += c))
    res.on('end', () => {
      try {
        const r = JSON.parse(text)
        if (r && r.output) process.stdout.write(JSON.stringify(r.output))
      } catch {}
    })
  })
  req.setTimeout(${FORWARD_TIMEOUT_MS}, () => req.destroy())
  req.on('error', () => {})
  req.end(body)
})
`
}

/**
 * 拦住之后记进对话的那一行（panel: 'hook'）：界面画成回复里的一行「面板让它接着做」，点开看交给它的说明。
 * 只给人看，不交给 CLI（CLI 已经从钩子拿到了说明）
 */
export function hookMarker(reason: string, id: string, agentId: string, step: string): TaskMessage {
  return {
    id,
    role: 'system',
    agentId,
    step,
    text: reason,
    tools: [],
    panel: 'hook',
    at: new Date().toISOString(),
  }
}
