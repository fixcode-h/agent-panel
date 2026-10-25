import type { McpEntry, McpServer } from './library.ts'

/**
 * 项目里的 MCP 配置：只读扫描项目目录下各 CLI / 编辑器认的配置文件，列出来给用户看，可以导入成面板管理的配置
 * （写进各 CLI 的全局配置，见 server/mcp-store.ts）。
 *
 * 扫描规则写在 server/project-mcp.ts 的 SOURCES 里，每条都注明了依据。
 * 导入只写 CLI 的全局配置，不改用户项目里的文件，所以不需要备份：原文一直在用户自己的文件里。
 */
export interface ProjectMcpDetected {
  name: string
  server: McpServer
  /** 相对项目根的配置文件，例如 .mcp.json、.vscode/mcp.json */
  file: string
  /** 这个文件是什么（哪个工具认的），界面上标在文件名后面 */
  source: string
  /**
   * 和 CLI 全局配置里的同名工具比：
   * new 只在项目里有；same 已经一样；different 全局有同名但配置不同（导入会覆盖全局那一份）
   */
  status: 'new' | 'same' | 'different'
  /** 这一条在文件里的内容（JSON 化后的原文），导入前留档、AI 排查时一起交给 AI */
  raw: string
  /** 名字合不合面板的规则（项目里的名字可能带空格、点），不合的导入前要改名 */
  nameOk: boolean
}

export interface ProjectMcpOverview {
  /** 项目的本地目录；空表示项目还没设目录 */
  path: string
  /** 面板能管 MCP 的 CLI 和它们读的全局配置文件 */
  clis: { id: string; name: string; file: string }[]
  /** 面板管理的（在各 CLI 全局配置里的） */
  servers: McpEntry[]
  /** 项目目录里识别到的（只读） */
  detected: ProjectMcpDetected[]
  /** 读不懂的配置文件：只提示，不影响别的文件 */
  errors: { file: string; error: string }[]
}

/** 导入结果：没做成的逐条给出原因，界面上照实显示 */
export interface ProjectMcpImportResult {
  overview: ProjectMcpOverview
  done: { name: string; file: string }[]
  skipped: { name: string; file: string; reason: string }[]
}

/**
 * 面板自己的 MCP 地址（http://127.0.0.1:<端口>/api/mcp/ask/<令牌>，老版本还有 /api/mcp/orch/<令牌>）。
 * 这些是面板执行时临时写进项目的，不是用户的工具：项目设置不把它们列成可导入项，执行前和启动时会清掉失效的。
 * 给 port 时只认这个端口（别的端口可能是另一个正在跑的面板）
 */
const PANEL_MCP_URL = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::(\d+))?\/api\/mcp\/(?:ask|orch)\/([\w-]+)\/?$/
export function isPanelMcpUrl(url: unknown, port?: number) {
  const m = typeof url === 'string' ? PANEL_MCP_URL.exec(url.trim()) : null
  return !!m && (port === undefined || Number(m[1] ?? 80) === port)
}
export const panelMcpToken = (url: string) => PANEL_MCP_URL.exec(url.trim())?.[2] ?? ''
