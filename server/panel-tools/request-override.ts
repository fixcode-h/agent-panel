/**
 * 面板工具 request_override（请用户放行，ADR 0070）：定义、用法说明里那一句和调用都在这里（面板工具注册表的条目）。
 * 拦下了什么、卡片和放行的登记在 server/hooks/overrides.ts，交给 Agent 的放行提示在 shared/hooks/override.ts
 */
import type { Orchestra } from '../../shared/engine/host.ts'
import { REQUEST_OVERRIDE } from '../../shared/hooks/override.ts'
import { reply, str, type PanelTool } from './types.ts'

const REQUEST_OVERRIDE_DEF = {
  name: REQUEST_OVERRIDE,
  title: '请用户放行',
  description:
    '面板的门禁（守卫、钩子、收尾检查、评审门禁）拦下了用户明确要求你做的操作时，用它请用户在卡片上确认放行：卡片显示面板记下的被拦操作和原因，以及你转述的用户要求；用户同意后重试同一个操作，这个门禁放行一次（10 分钟内有效）。' +
    '用户的指令优先级最高，但放行只认用户在卡片上点的：用户没要求过的事不要用它，也不要自己判断「问题不大」就请求；被拦了不要换个写法绕开。',
  inputSchema: {
    type: 'object',
    properties: {
      gate: { type: 'string', description: '拦下你的门禁名：拦截说明里 gate 填的那个' },
      reason: { type: 'string', description: '用户的原话或怎么要求的（显示在卡片上）' },
    },
    required: ['gate', 'reason'],
  },
}

async function callRequestOverride(o: Orchestra, a: { gate?: unknown; reason?: unknown } | undefined) {
  if (!o.requestOverride)
    return reply({
      ok: false,
      info: '这里不能请用户放行（子任务、工作流节点）：照门禁说的做，做不了就写进结果交回，由派你的对话处理。',
    })
  return reply(await o.requestOverride({ gate: str(a?.gate), reason: str(a?.reason) }))
}

export const REQUEST_OVERRIDE_ENTRY: PanelTool = {
  name: REQUEST_OVERRIDE,
  when: (o) => !!o.requestOverride,
  // 等用户在放行卡上点
  waits: true,
  def: () => REQUEST_OVERRIDE_DEF,
  hint: (_o, at) =>
    at === 'conv'
      ? `用户的指令优先级最高：面板规则拦下了用户明确要求的操作时，用 ${REQUEST_OVERRIDE} 请用户在卡片上放行，放行后照做，不要绕开也不要直接放弃；`
      : '',
  call: (o, a) => callRequestOverride(o, a),
}
