/**
 * 查找能力（能力路由的第一个能力）：找符号、引用、大纲、成员、头文件、任意文本。按名字找文件仍由文件索引直接答（file_index 的老路）。
 * 请求不管从面板工具 find 来、还是（第二期）从接管的 rg / grep 来，都先翻成 FindRequest
 */

export const FIND_KINDS = ['symbol', 'refs', 'outline', 'members', 'include', 'text'] as const
export type FindKind = (typeof FIND_KINDS)[number]

/** 按语言分路：cpp 走 VS（UEToVS）、lua 走 IDEA（lua_code），都由插件登记；other 只有通用的路 */
export const FIND_LANGS = ['cpp', 'lua', 'other'] as const
export type FindLang = (typeof FIND_LANGS)[number]

export interface FindRequest {
  kind: FindKind
  /** symbol / refs / members / include：名字（可带 A::B、A.B、A:B）；outline：文件；text：要搜的文本 */
  query: string
  lang: FindLang
  /** 只在这些目录里找（相对项目根或绝对路径） */
  under?: string[]
  /** 只要这些扩展名 */
  ext?: string[]
  /** refs：符号所在的文件和行（同名符号多时挑准哪一个） */
  file?: string
  line?: number
  /** 把项目外的（引擎源码、库）也算上 */
  wide?: boolean
  limit: number
  offset: number
}

/** 一条命中：统一的形状，几条路的结果才能合并、去重、排序 */
export interface FindHit {
  /** 相对项目根（项目外的保留绝对路径），正斜杠 */
  file: string
  line?: number
  col?: number
  /** 符号名、种类、所属：符号类结果才有 */
  name?: string
  kind?: string
  container?: string
  /** 签名或那一行的内容 */
  text?: string
  /** 排序用：声明 0、引用 1、其他文本 2 */
  rank: 0 | 1 | 2
}

/** 一条路查回来的结果：hits 为空表示「没有」，note 是路自己的说明（索引还没建完之类） */
export interface FindOutcome {
  hits: FindHit[]
  more?: boolean
  note?: string
  /** 本机缺的程序（例如 rg）：这次只能降级查，界面上提醒用户装 */
  missing?: MissingProgram[]
}

/** 面板要用、本机没装的程序：名字和当前平台的安装命令 */
export interface MissingProgram {
  program: string
  install: string
}

/**
 * 外部 MCP 服务上的一条查找路（插件经 ServerPlugin.findSources 登记，例如 UE 插件登记 UEToVS、IDEA 的 lua_code）：
 * 面板按工具名在这一轮能用的服务里找到它，按 args 拼参数、自己当客户端去调（server/capability-router/external.ts），
 * 返回的 JSON 按统一规则读成命中（items[].file/line、target）；形状特别的给 parse
 */
export interface ExternalFindSource {
  /** 记录和设置页里显示，例如 'uetovs.search_symbols' */
  id: string
  /** 工具名：在服务的工具表里按它认（不限服务名，IDE 开了仅路由器时经 execute_tool 转调） */
  tool: string
  kinds: FindKind[]
  langs: FindLang[]
  /** 越小越先用；面板自带的文本搜索兜底是 1000 */
  rank: number
  /**
   * 这个请求它接不接、参数怎么拼；返回 null 表示这个请求它不管（例如 outline 给的不是 .lua 文件）。
   * 分页由面板做（几条路合并后才分页）：要 offset + limit 条、从头开始，不要把 offset 传给服务
   */
  args: (req: FindRequest) => Record<string, unknown> | null
  /** 结果特别的自己读；不给按 items / target 的通用规则读 */
  parse?: (json: unknown, req: FindRequest) => FindOutcome
  /** 查到这些就够了、不再往下兜底（symbol / outline 默认够；refs 默认还要用文本补动态调用） */
  final?: boolean
}
