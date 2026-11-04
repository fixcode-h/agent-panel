import { FORWARD_TIMEOUT_MS, HOOK_CONTINUE_TYPE, HOOK_EVENTS_ENV, HOOK_TIMEOUT_MS, HOOK_URL_ENV } from './hooks.ts'

/**
 * Command Code 的 mod 里那几段钩子（ADR 0049）：面板每轮只装一个 mod（shared/prompt-lang.ts 的 promptLangModSource），
 * 回复语言规则和钩子都在里面。从 prompt-lang.ts 拆出来：那边管提示词的语言，这里管钩子。
 *
 * 只转发，不判断，也不带模型回复的文字；面板没回、这一轮没挂面板的编排工具（没有转发地址）就放行。
 * 用了哪几个事件按 HOOK_EVENTS_ENV 来，没人用的工具前 / 工具后不必每次工具调用都多问一次。
 * 输出的是一段 mod 源码（纯 JS，Command Code 直接加载），返回值里的 HOOKS 交给 cmd.hooks，panelOn(cmd) 订阅压缩事件
 */
export function hookModSource() {
  return `// 钩子（ADR 0049）：问面板这个事件怎么办
const HOOK_EVENTS = () => String(process.env.${HOOK_EVENTS_ENV} || '').split(',')
async function askPanel(event, native, ms) {
  const url = process.env.${HOOK_URL_ENV}
  if (!url || typeof fetch !== 'function') return undefined
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event, native }),
      signal: AbortSignal.timeout(ms),
    })
    return await r.json()
  } catch {
    return undefined
  }
}
// 结束前：计划没做完、也没在等结果就接着做（onStop 返回 continue）
async function onStop() {
  const d = await askPanel('turn.beforeEnd', {}, ${HOOK_TIMEOUT_MS})
  return d && d.block && d.reason ? { continue: true, reason: d.reason } : undefined
}
const toolOf = (p) => ({ tool_name: p && p.toolName, tool_input: (p && p.input) || {} })
// 工具前：拒绝时 block，原因作为这次调用的结果交给模型；补的说明接在结果后面
async function beforeToolCall(p) {
  if (!HOOK_EVENTS().includes('tool.before')) return undefined
  const d = await askPanel('tool.before', toolOf(p), ${FORWARD_TIMEOUT_MS})
  if (d && d.deny && d.reason) return { block: true, additionalContext: d.reason }
  return d && d.context ? { additionalContext: d.context } : undefined
}
// 工具后：补的说明接在结果后面
async function afterToolCall(p) {
  if (!HOOK_EVENTS().includes('tool.after')) return undefined
  const out = Array.isArray(p && p.result) ? p.result.map((c) => (c && c.type === 'text' ? c.text : '')).join('\\n') : String((p && p.result) || '')
  const d = await askPanel('tool.after', { ...toolOf(p), tool_output: out.slice(0, 4000), is_error: !!(p && p.isError) }, ${FORWARD_TIMEOUT_MS})
  return d && d.context ? { additionalContext: d.context } : undefined
}
// 压缩之后：Command Code 只有 compaction_done 事件（只能看不能改），先问面板，下一回合开始时补一条不显示的消息
let restored = null
function panelOn(cmd) {
  if (!HOOK_EVENTS().includes('context.restored') || typeof cmd.on !== 'function') return
  cmd.on('compaction_done', () => {
    restored = askPanel('context.restored', { source: 'compact' }, ${FORWARD_TIMEOUT_MS})
  })
}
async function onTurnStart({ state }, ctx) {
  if (!restored) return state
  const d = await restored
  restored = null
  if (!d || !d.context || !ctx || !ctx.session) return state
  const { message } = ctx.session.appendCustomMessageEntry({ customType: '${HOOK_CONTINUE_TYPE}', content: d.context, display: false })
  return { ...state, messages: [...state.messages, message] }
}
const HOOKS = { onStop, beforeToolCall, afterToolCall, onTurnStart }
`
}
