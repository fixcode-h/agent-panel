/** 英文词典的一部分，键是中文原文：外部 MCP 服务代理（设置「Agent 工具 → 工具路由」的「给 Agent 的工具」，ADR 0085） */
export const EN_MCP_PROXY: Record<string, string> = {
  '经面板代理：调用都进调用记录，面板补参数、等索引':
    'Proxied by the panel: every call is recorded, and the panel fills in parameters and waits for indexing',
  '设置里关了代理，照旧直接挂在 CLI 上': 'Proxying is turned off in settings, so it stays attached to the CLI directly',
  '这个 CLI 不能只挂面板的服务，照旧直接挂':
    "This CLI can't be limited to the panel's server, so it stays attached directly",
  '这一轮没有面板的工具服务，照旧直接挂': 'This run has no panel tool server, so it stays attached directly',
  '面板连不上它，退回直接挂在 CLI 上': "The panel can't reach it, so it falls back to being attached to the CLI",
  '面板的客户端不支持它的协议，退回直接挂在 CLI 上':
    "The panel's client doesn't support its protocol, so it falls back to being attached to the CLI",
  '最近代理调用出过错，先退回直接挂在 CLI 上':
    'A proxied call failed recently, so for now it falls back to being attached to the CLI',
  '给 Agent 的工具': 'Tools given to agents',
  外部服务经面板代理: 'Proxy external servers through the panel',
  '开着时 CLI 只挂面板一个服务，项目和全局配置里的外部服务由面板代为调用，每次调用都进调用记录；代理不了的照旧直接挂':
    "When on, the CLI only attaches the panel's server; external servers from project and global configs are called by the panel on its behalf and every call is recorded. Servers that can't be proxied stay attached directly",
  '这个项目还没有对话开跑过：开跑时面板按这个 CLI 会挂的外部服务算一遍，记在这里':
    'No conversation has run in this project yet: when one starts, the panel works out the external servers this CLI would attach and records them here',
  '被能力接管、代理时不给 Agent 的外部工具（查找一律用面板的 find）：':
    "External tools taken over by a capability and not given to agents when proxied (searching always uses the panel's find):",
  '改用 {use} · 登记：{by}': 'Use {use} instead · registered by: {by}',
  '{when}开跑 · {title}': 'Ran {when} · {title}',
  没有外部服务: 'No external servers',
  代理: 'Proxied',
  直接挂: 'Direct',
  '给了 {n} 个工具': '{n} tools given',
  '没给：': 'Not given:',
  '改用 {use}': 'Use {use} instead',
  面板代为调用外部服务: 'The panel called the external server on your behalf',
  '面板代理 {server} · {tool}': 'Panel proxy {server} · {tool}',
}
