/**
 * 执行代码类工具的「意图」：Agent 交一段 Lua / Python 时同时给一句中文说明这段要做什么，对话里的工具行显示这句，
 * 不再只显示 exec 或代码第一行（用户 2026-11-27）。
 * 插件工具在定义上标 intent（插件 SDK 的 McpTool.intent），面板给参数表补同一个 intent 参数和说明，
 * 交给 Agent 的 tools/list（server/plugins/mcp.ts）和设置 →「MCP」的参数表（server/mcp-catalog/plugins.ts）用同一份；
 * 对话的工具行（web/src/lib/tasks.ts 的 toolView）认参数里的 intent，任何 MCP 工具带了都优先显示它。
 */

export const INTENT_ARG = 'intent'

/** 补进参数表的说明：写给模型看 */
export const INTENT_HINT =
  '用中文一句话说明这次要做什么（目的或意图，例如「查看背包里第一件道具的数量」），不要复述代码；会显示在对话的工具卡片上，执行代码时必填'

/** 参数表补上 intent（已经有同名参数的照原样，不覆盖插件自己的说明） */
export function withIntent(schema: Record<string, unknown>, on: boolean | undefined): Record<string, unknown> {
  if (!on) return schema
  const props = (schema.properties ?? {}) as Record<string, unknown>
  if (INTENT_ARG in props) return schema
  return { ...schema, properties: { [INTENT_ARG]: { type: 'string', description: INTENT_HINT }, ...props } }
}

/** 调用参数里的意图：取第一行非空文字，没有返回空串 */
export function intentOf(args: Record<string, unknown>): string {
  const v = args[INTENT_ARG]
  if (typeof v !== 'string') return ''
  return (
    v
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? ''
  )
}
