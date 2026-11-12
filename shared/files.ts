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

/** 表格文件里的一张表：每行是各列的文字，行尾的空列不补齐 */
export interface SheetData {
  name: string
  rows: string[][]
  /** 表太大，只给了前面一部分 */
  truncated?: boolean
  /** xlsx 里隐藏的工作表（state="hidden" / "veryHidden"）：切换条上标灰、排到最后 */
  hidden?: boolean
  /** xlsx 读出的格子之外的显示信息（合并单元格、批注、超链接、底色）：只读，保存时不动它们 */
  look?: SheetLook
}

/** 合并单元格：左上角（行、列都从 0 数）和占几行几列 */
export interface SheetMerge {
  r: number
  c: number
  rows: number
  cols: number
}

/** 一格的批注（Excel 的「批注」和新版的「备注」都算） */
export interface SheetNote {
  r: number
  c: number
  text: string
  author?: string
}

/** 一格的超链接：url 是外部地址，loc 是表内位置（Sheet2!A1） */
export interface SheetLink {
  r: number
  c: number
  url?: string
  loc?: string
  /** Excel 里给链接写的提示文字 */
  tip?: string
}

/** 一行的底色（整行大半格子同一底色时）：团队拿它标「待定」「废弃」行，颜色写 #rrggbb */
export interface SheetRowFill {
  r: number
  color: string
}

export interface SheetLook {
  merges?: SheetMerge[]
  notes?: SheetNote[]
  links?: SheetLink[]
  fills?: SheetRowFill[]
}

export interface FileContent {
  path: string
  exists: boolean
  binary?: boolean
  /** 表格文件（xlsx）解析出来的各张表：有它时虽然是二进制文件，文件弹窗按表格显示 */
  sheets?: SheetData[]
  content: string
  truncated: boolean
  /** 文件大小（字节）；文件不存在时没有 */
  size?: number
  /** 修改时间（ISO）；文件不存在时没有 */
  mtime?: string
  /** 文件现在用的换行符：保存时按原样回写，不把 CRLF 的文件改成 LF */
  eol?: 'lf' | 'crlf'
}

/** 写文件、新建文件的结果：写完之后的大小 */
export interface FileWrite {
  path: string
  size: number
}

/** 一个项目和 git 比的差异；不是 git 仓库或文件没提交过时 git 为 false，用 note 说明原因 */
export interface FileDiff {
  path: string
  dir: string
  diff: string
  git: boolean
  /** 文件在基准提交里原来就有 */
  before: boolean
  /** 看不到正常差异时给前端的说明 */
  note?: string
}

/** 搜索方式：按文件名，或按文件内容 */
export type SearchMode = 'name' | 'content'
