/**
 * 代码索引类的 MCP 工具（UEToVS 的 search_lua、search_symbols 这类）：按符号找函数、类、GM 命令，比 rg 扫目录快得多也准得多。
 *
 * 为什么面板要专门认它们：Agent 拿到的搜索规则原来只教 rg，别家服务的工具又是 CLI 自己从 .mcp.json 装的，
 * 提示词里从来不出现这些工具名；Claude Code 工具一多还会把 MCP 工具延迟加载，Agent 只看得到名字、看不到说明，
 * 结果一律先 grep 整个目录（用户 2026-11-14 报：查 GM 为什么无效时先 grep 失败一次，追问后用 search_lua 一下定位）。
 * 所以面板认出项目里的这类工具，把服务名、工具名和一句说明直接写进提示词的「搜索（这个项目）」一节。
 */
import { hasParam, type ParamBrief } from './tool-params.ts'

/** 一个代码索引工具：服务名 + 工具名，desc 是工具说明的第一句（看得出管哪种语言） */
export interface CodeIndexTool {
  server: string
  tool: string
  desc?: string
}

// 名字里带「搜 / 找」和「符号 / 代码 / 定义 / 引用」这类词的才算：search_files 这种按文件名找的也算（比 find 快），
// 写东西、跑东西的工具（build、edit、run）一律不算
const SEARCH_WORD = /(search|find|lookup|locate|grep|query|goto|go_to)/i
const INDEX_WORD =
  /(symbol|lua|code|class|function|func|method|def|definition|reference|refs?\b|usage|caller|callee|text|file|source|type|struct|enum|cpp|blueprint)/i
const WRITE_WORD = /(write|edit|create|delete|remove|rename|build|compile|run|exec|set_|update)/i
// 名字就是 definition / references / symbols 这类（LSP 风格）的也算
const LSP_NAME = /^(get_?)?(symbols?|definitions?|references?|find_references|workspace_symbols?|document_symbols?)$/i

export function isCodeIndexTool(name: string): boolean {
  if (WRITE_WORD.test(name)) return false
  if (LSP_NAME.test(name)) return true
  return SEARCH_WORD.test(name) && INDEX_WORD.test(name)
}

/** 工具说明的第一句，最多 100 字：提示词里一行一个工具，够看出语言和用途就行 */
export function briefDesc(description: string | undefined): string | undefined {
  const s = (description ?? '')
    .trim()
    .split(/(?<=[。.！？!?])\s|\n/)[0]
    ?.trim()
  if (!s) return undefined
  return s.length > 100 ? `${s.slice(0, 99)}…` : s
}

/**
 * 项目设置里手动指定的一项：写成「服务名/工具名」（例如 uetovs/search_lua），格式不对的丢掉
 */
export function parseCodeIndexItem(item: string): Pick<CodeIndexTool, 'server' | 'tool'> | undefined {
  const m = item.trim().match(/^([^/\s]+)\/([^/\s]+)$/)
  return m ? { server: m[1], tool: m[2] } : undefined
}

/**
 * 项目接的 JetBrains IDE MCP 服务；router：工具列表里有 execute_tool（IDE 开了「仅路由器」，别的工具要经它转调）；
 * params：缓存里每个工具的参数表（server/mcp-catalog/external-titles.ts 探测时存下），还没问过这个服务时没有
 */
export interface IdeMcpServer {
  server: string
  router?: boolean
  params?: Record<string, ParamBrief[]>
}

/** 提示词里点名的工具最多几个：只为说清「谁有 projectPath、谁用 project」，不是把工具表抄一遍 */
const NAME_MAX = 4
const names = (xs: string[]) =>
  xs
    .slice(0, NAME_MAX)
    .map((x) => `\`${x}\``)
    .join('、') + (xs.length > NAME_MAX ? ` 等 ${xs.length} 个` : '')

/**
 * JetBrains IDE 服务的调用规矩，接在「搜索」一节第一步后面。
 * 为什么要写：用户 2026-11-20 报 Agent 调 IDE 里的 lua_code 连着失败——
 * 一是 projectPath 填了工作目录（P4 工作区根），IDE 打开的是它下面的 Project 子目录，IDE 只认项目目录之内的路径，整轮都报
 * 「doesn't correspond to any open project」，Agent 换个查询词原样再调；
 * 二是经 execute_tool 转调时把命令写成 `lua_code action=search`，IDE 只认 `--参数名 值`。
 * 2026-11-21 又报：Agent 照「projectPath」那条给 lua_code 也传了 projectPath，被当成未知参数拒绝——
 * projectPath 是 IDE 自带工具的参数，插件工具用的是 project（项目名）。
 * 所以参数名不再手写（A2）：哪些工具有 projectPath、哪些用 project、转调的例子，都按缓存里服务自己报的参数表生成；
 * 还没问过这个服务（没有参数表）时只写「照工具自己的参数表传」，不点名任何参数
 */
export function ideMcpLines(servers: IdeMcpServer[] | undefined): string[] {
  if (!servers?.length) return []
  const all = servers.map((s) => `\`${s.server}\``).join('、')
  const tables = servers.flatMap((s) => Object.entries(s.params ?? {}))
  const withPath = tables.filter(([, p]) => hasParam(p, 'projectPath')).map(([n]) => n)
  const withProject = tables.filter(([, p]) => !hasParam(p, 'projectPath') && hasParam(p, 'project')).map(([n]) => n)
  const lines = [
    `   ${all} 是 JetBrains IDE 自带的 MCP 服务，调它的工具时：`,
    '   - 参数照这个工具自己的参数表传（只看得到名字的先加载它的说明），不要把一个工具的参数照搬到另一个工具上。报「未知参数」时照报错列出的可用参数改，不要换个值再试。',
  ]
  if (withPath.length)
    lines.push(
      `   - \`projectPath\` 只有参数表里列了它的工具才传（${names(withPath)}）${withProject.length ? `；${names(withProject)} 没有它，开了多个项目时用 \`project\` 传项目名，一般不用传` : ''}。传的时候必须是 IDE 里打开的项目目录或它里面的路径：IDE 打开的常常是工作目录下的子目录，工作目录本身对不上，没把握就不传；报 \`doesn't correspond to any open project\` 或 \`Unable to determine the target project\` 时，从报错里的 \`Currently open projects\` 挑这次要查的那个路径重调，同一个失败过的路径不要再用，列表里没有合适的就停下问用户。`,
    )
  const routers = servers.filter((s) => s.router)
  if (routers.length)
    lines.push(
      `   - ${routers.map((s) => `\`${s.server}\``).join('、')} 开了「仅路由器」：列表里看不到的工具经 \`execute_tool\` 转调，\`command\` 写成「工具名 --参数名 值」${routerExample(routers)}；值有空格加引号，数组和对象传 JSON。不要写成 \`参数名=值\` 这种 key=value。`,
    )
  lines.push('   - 报参数格式错、找不到项目这类错时先照报错改参数，不要原样或只换查询词重试。')
  return lines
}

/** 转调的例子从参数表里挑：第一个带枚举的必填参数的工具（lua_code 的 action），没有参数表就不举例 */
function routerExample(routers: IdeMcpServer[]): string {
  for (const s of routers)
    for (const [tool, params] of Object.entries(s.params ?? {})) {
      if (tool === 'execute_tool') continue
      const p = params.find((x) => x.required && x.type.includes(' | '))
      if (p) return `，例如 \`${tool} --${p.name} ${p.type.split(' | ')[0]}\``
    }
  return ''
}

/** 「搜索（这个项目）」一节的第一步：有认出的工具就逐个列出，没认出也提醒「工具列表里有就先用」 */
export function codeIndexLines(tools: CodeIndexTool[] | undefined): string[] {
  const head =
    '1. 先用代码索引 MCP 工具：按函数名、类名、变量名、GM 命令、报错里的标识符找代码时，先用它查到文件和行号，再直接读那一处；它没命中、不覆盖这种语言，或者要搜的是任意文本（日志原文、注释）时，才往下用 rg。'
  if (!tools?.length)
    return [
      head,
      '   这个项目没认出代码索引工具；工具列表里有名字像 `search_symbols`、`search_lua`、`find_references` 的 MCP 工具时照样先用（只看得到名字、看不到说明的，先加载它的说明再判断）。',
    ]
  return [
    head,
    '   这个项目接了这些（只看得到名字、看不到说明的，先加载它的说明再用，不要因此改用 rg）：',
    ...tools.map((t) => `   - ${t.server} 服务的 \`${t.tool}\`${t.desc ? `：${t.desc}` : ''}`),
  ]
}
