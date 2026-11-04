import { z } from 'zod'
import type { TaskMessage } from './schema.ts'

/**
 * 钩子（ADR 0049）：模型准备结束这一轮时（turn.beforeEnd），CLI 先问面板；计划没做完、也没在等任何结果时
 * 面板答「拦住」并给出下一步，CLI 在同一轮里接着做，对话里不再另起一轮【面板】提醒。
 *
 * 这里放和 CLI 无关的部分：CLI 定义里的 hooks 字段、面板的判断结果、给 Claude Code 这类「钩子是一条命令」的 CLI
 * 用的转发脚本。怎么装进 CLI（参数、扩展、mod）写在各自的 CLI 定义里，代码按字段走，不按 CLI 的名字分支。
 *
 * 硬规则：面板只按结构化状态判断（计划、提问、子对话、后台命令、submit_* 交没交），不读模型回复的文字。
 * 转发脚本发给面板之前就把原生输入里的回复文字（last_assistant_message 这类）丢掉，面板根本拿不到
 */

/** 面板事件：现在只有「结束前」；工具前 / 工具后 / 上下文恢复见设计稿 docs/openspec/changes/agent-hooks 的 P2 */
export const HookEvent = z.enum(['turn.beforeEnd'])
export type HookEvent = z.infer<typeof HookEvent>

/**
 * CLI 定义里的「结束前钩子」怎么装：
 * - via=command：CLI 的钩子是一条命令（Claude Code 的 Stop）。面板在这一轮的临时目录写转发脚本（{hookScript}）
 *   和 files 里的配置，args 加在参数后面；拦住时转发脚本把 block 模板（{reason} 填好）原样打印给 CLI。
 * - via=extension：钩子写在面板每轮已经装进 CLI 的扩展里（Pi 的 -e 桥接扩展、Command Code 的 --mod），
 *   扩展自己按 HOOK_URL_ENV 或 {url}/hook 问面板，这里只声明「这个 CLI 支持」。
 */
export const BeforeEndSpec = z.object({
  via: z.enum(['command', 'extension']),
  args: z.array(z.string()).default([]),
  files: z.record(z.string(), z.unknown()).default({}),
  /** 拦住时 CLI 要的输出（via=command）；里面的 {reason} 换成面板给的说明 */
  block: z.unknown().optional(),
  /** 原生输入里要丢掉、不交给面板的字段（模型回复的文字），见上面的硬规则 */
  dropInput: z.array(z.string()).default([]),
  why: z.string().default(''),
})
export type BeforeEndSpec = z.infer<typeof BeforeEndSpec>

export const HooksSpec = z.object({
  beforeEnd: BeforeEndSpec.optional(),
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

/** 放行：不表态 */
export const allowEnd = (why: string): BeforeEndDecision => ({ block: false, why })

/** 转发地址的环境变量：面板起 CLI 时放进去，钩子命令、Command Code 的 mod 从这里取 */
export const HOOK_URL_ENV = 'AGENT_PANEL_HOOK_URL'

/** Pi 扩展续跑时追加的那条消息的类型：面板的输出解析按它认出来，不画成用户消息 */
export const HOOK_CONTINUE_TYPE = 'agent-panel-continue'

/** 转发超时：面板没回就放行，钩子坏了不能把对话卡住 */
export const HOOK_TIMEOUT_MS = 5000

/** 按模板填 {reason}：模板里的字符串原样替换，对象、数组逐层替换 */
export function fillBlock(tpl: unknown, reason: string): unknown {
  if (typeof tpl === 'string') return tpl.replace(/\{reason\}/g, () => reason)
  if (Array.isArray(tpl)) return tpl.map((x) => fillBlock(x, reason))
  if (tpl && typeof tpl === 'object')
    return Object.fromEntries(Object.entries(tpl).map(([k, v]) => [k, fillBlock(v, reason)]))
  return tpl
}

/** 转发脚本在这一轮临时目录里的文件名 */
export const HOOK_SCRIPT = 'agent-panel-hook.mjs'

/**
 * via=command 的 CLI 这一轮要加的参数和要写的文件：{dir} 换成面板这一轮的临时目录，{hookScript} 换成转发脚本。
 * 路径一律用正斜杠：钩子命令在 Windows 上也可能交给 bash 执行，反斜杠会被当成转义
 */
export function hookInstall(spec: BeforeEndSpec, dir: string) {
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
  if (spec.via !== 'command') return { args: [] as string[], files: [] as { path: string; content: unknown }[] }
  return {
    args: spec.args.map((a) => fill(a) as string),
    files: [
      { path: script, content: hookForwarderSource(spec.dropInput) as unknown },
      ...Object.entries(spec.files).map(([p, content]) => ({ path: fill(p) as string, content: fill(content) })),
    ],
  }
}

/** 从原生输入里取面板要的那一点：只认几个已知的「已经续过」标记，其余（含回复文字）一律不要 */
export function beforeEndInput(native: unknown, drop: string[] = []): BeforeEndInput {
  if (!native || typeof native !== 'object') return {}
  const o = { ...(native as Record<string, unknown>) }
  for (const k of drop) delete o[k]
  return { again: o.stop_hook_active === true }
}

/**
 * 转发脚本（via=command）：CLI 在模型准备结束时运行它，stdin 进原生 JSON。
 * 只做转发，不判断：丢掉回复文字，POST 给面板，面板回了 output 就原样打印，其余（面板没起来、超时、出错）什么都不打印，
 * CLI 就照常结束。用 node:http 不用 fetch：老版本 Node 没有 fetch，也省得被代理环境变量改道
 */
export function hookForwarderSource(drop: string[]) {
  return `// Agent 面板的结束前钩子转发（ADR 0049）：只转发，不判断；面板没回就放行
import { request } from 'node:http'

const url = process.env.${HOOK_URL_ENV}
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
  const body = JSON.stringify({ event: 'turn.beforeEnd', native })
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
  req.setTimeout(${HOOK_TIMEOUT_MS}, () => req.destroy())
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
