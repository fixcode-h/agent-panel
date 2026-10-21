/** 文件浏览：项目里的文件（带 git 状态）、按层读取目录、按文件名或内容搜索、看单个文件的内容 */

/** 文件在 git 里的状态；未改动的文件为空字符串 */
export type FileStatus = '' | 'M' | 'A' | 'D' | 'R' | 'U' | '?'

export interface FileEntry {
  /** 相对项目目录，统一用 / 分隔 */
  path: string
  status: FileStatus
  /** 重命名、复制前的路径 */
  from?: string
}

/** 项目的根信息：列表按层读取，这里只说明目录、分支和是不是 git 仓库 */
export interface FileTree {
  dir: string
  /** 当前分支；不是 git 仓库或分离 HEAD 时为空 */
  branch: string | null
  isGit: boolean
}

/** 目录里的一项 */
export interface DirEntry {
  name: string
  /** 相对项目目录，统一用 / 分隔 */
  path: string
  kind: 'dir' | 'file'
  status: FileStatus
  from?: string
}

/** 目录的一层：只包含这一层的直接子项，展开下一层时再单独请求 */
export interface DirLevel {
  dir: string
  /** 相对目录，根目录为空字符串 */
  path: string
  entries: DirEntry[]
  /** git 状态这次没拿到（超时或出错），这一层的条目都没有状态 */
  statusSkipped?: boolean
}

/** 按文件名搜索的结果 */
export interface NameSearch {
  files: FileEntry[]
  /** 命中太多，只显示了一部分 */
  truncated: boolean
}

/** 按内容搜索命中的一段 */
export interface ContentHit {
  /** 行号，从 1 开始 */
  line: number
  text: string
}

export interface ContentFile {
  path: string
  hits: ContentHit[]
}

export interface ContentSearch {
  files: ContentFile[]
  /** 命中太多，只显示了一部分 */
  truncated: boolean
}

export interface FileContent {
  path: string
  exists: boolean
  binary?: boolean
  content: string
  truncated: boolean
}

/** 搜索方式：按文件名，或按文件内容 */
export type SearchMode = 'name' | 'content'
