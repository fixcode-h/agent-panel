/**
 * 引擎宿主里的项目文件索引（file_index 工具，设计稿：项目文件索引）：按名字找文件、按文件夹取、让索引核对 / 重建。
 * 真正查索引在服务端（server/file-index/agent-tool.ts），引擎只把工具参数交过去、把文字结果交回 CLI
 */
export interface FileIndexArgs {
  action: 'find' | 'list' | 'refresh' | 'rebuild' | 'status'
  /** find：空格分隔的词都要命中文件名（带 / 的词按路径），带 * ? 的按通配 */
  query?: string
  /** list / refresh：目录（相对项目根或绝对路径） */
  dir?: string
  /** find：只在这些目录里找 */
  under?: string[]
  ext?: string[]
  /** find：找目录而不是文件 */
  dirs?: boolean
  /** list：整棵子树的文件 */
  recursive?: boolean
  limit?: number
  offset?: number
}

export type FileIndexRun = (a: FileIndexArgs, signal?: AbortSignal) => Promise<{ text: string; error?: boolean }>

export interface FileIndexHost {
  /** 项目开着文件索引时才有（不在项目里、项目关了索引时没有，file_index 工具也不列） */
  fileIndex?: FileIndexRun
}

export interface OrchFileIndex {
  fileIndex?: FileIndexRun
}
