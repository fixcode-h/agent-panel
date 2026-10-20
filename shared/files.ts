/** 文件浏览：项目里的文件列表（带 git 状态）、按文件名或内容搜索、看单个文件的内容 */

/** 文件在 git 里的状态；未改动的文件为空字符串 */
export type FileStatus = '' | 'M' | 'A' | 'D' | 'R' | 'U' | '?'

export interface FileEntry {
  /** 相对项目目录，统一用 / 分隔 */
  path: string
  status: FileStatus
  /** 重命名、复制前的路径 */
  from?: string
}

export interface FileTree {
  dir: string
  /** 当前分支；不是 git 仓库或分离 HEAD 时为空 */
  branch: string | null
  isGit: boolean
  files: FileEntry[]
  /** 文件太多，只列了前面一部分 */
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
