/** 英文词典的一部分，键是中文原文：工具网关改道模式的查找接管（ADR 0084 第二期）——设置「工具路由」「调用记录」和工具卡片上的小标 */
export const EN_TOOL_TAKEOVER: Record<string, string> = {
  '搜索命令和自带的按内容搜改走面板的查找，结果是面板和原命令的并集；拿不准的照原样跑':
    "Search commands and built-in content search go through the panel's find; the result is the union of the panel's and the original command's; anything uncertain runs as is",
  '面板改走 {cap} ·': 'Panel rerouted to {cap} ·',
  '面板改走 {cap} · {via}': 'Panel rerouted to {cap} · {via}',
  '一条回复里发几个工具调用：{v}': 'Several tool calls in one reply: {v}',
  关自带工具: 'Hide built-in tools',
  '只用面板的 MCP': "Panel's MCP only",
  改写成: 'Rewritten to',
  '{to}（{decision}，按 {by} 认的；没有真的改）': '{to} ({decision}, matched by {by}; not actually changed)',
  照原样跑: 'Ran as is',
  路由: 'Route',
}
