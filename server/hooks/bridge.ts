import {
  allowEnd,
  beforeEndInput,
  fillTpl,
  hookFacts,
  type BeforeEndDecision,
  type BeforeEndInput,
  type HookAnswer,
  type HookFacts,
  type HooksSpec,
} from '../../shared/hooks.ts'
import { HookEventName, isNotifyEvent } from '../../shared/hook-defs.ts'
import { log } from '../log.ts'

/** 这一轮挂在面板工具通道上的钩子：CLI 定义里的装法（输出模板），以及按事件回答的两个函数 */
export interface BridgeHook {
  spec: HooksSpec
  beforeEnd?: (input: BeforeEndInput) => Promise<BeforeEndDecision>
  on?: (event: HookEventName, facts: HookFacts) => Promise<HookAnswer>
}

/**
 * 回答一次钩子（ADR 0049）：结束前交给 beforeEnd，其余交给 on，再按 CLI 定义里的模板翻成 CLI 要的输出（output）。
 * block / deny / reason / context 也原样带上：Pi 的扩展、Command Code 的 mod 自己读这几项，不用模板。
 * 出错一律回「不表态」
 */
export async function answerHook(h: BridgeHook, event: string, native: unknown): Promise<Record<string, unknown>> {
  const ev = HookEventName.safeParse(event)
  if (!ev.success) return {}
  try {
    if (ev.data === 'turn.beforeEnd') {
      if (!h.beforeEnd) return {}
      const d = await h.beforeEnd(beforeEndInput(native, h.spec.dropInput)).catch((e: Error) => {
        log.warn('agent', '结束前钩子判断出错，放行', { error: e.message })
        return allowEnd('error')
      })
      if (!d.block || !d.reason) return { block: false }
      const tpl = h.spec.beforeEnd?.via === 'command' ? h.spec.beforeEnd.block : undefined
      return { block: true, reason: d.reason, ...(tpl ? { output: fillTpl(tpl, { reason: d.reason }) } : {}) }
    }
    // 只通知的面板事件由面板自己发，不从 CLI 进来
    if (!h.on || isNotifyEvent(ev.data)) return {}
    const facts = hookFacts(h.spec, dropped(native, h.spec.dropInput))
    const a = await h.on(ev.data, facts)
    const es = h.spec.events[ev.data as keyof HooksSpec['events']]
    if (a.deny && a.reason && ev.data === 'tool.before')
      return { deny: true, reason: a.reason, ...(es?.deny ? { output: fillTpl(es.deny, { reason: a.reason }) } : {}) }
    if (a.context && es?.context) return { context: a.context, output: fillTpl(es.context, { text: a.context }) }
    return {}
  } catch (e) {
    log.warn('agent', '钩子出错，不表态', { event, error: (e as Error).message })
    return {}
  }
}

/** 原生输入去掉回复文字：面板这一侧再丢一遍，转发脚本漏了也不会进到判断里 */
function dropped(native: unknown, drop: string[]) {
  if (!native || typeof native !== 'object') return native
  const o = { ...(native as Record<string, unknown>) }
  for (const k of drop) delete o[k]
  return o
}
