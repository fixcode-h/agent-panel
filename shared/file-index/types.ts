/**
 * 项目文件索引（设计稿 designs/项目文件索引-设计稿.md）的数据形状：项目设置里的那几项、状态、查询结果。
 * 索引只记目录和文件名，不读内容、不记大小和修改时间：要 mtime 的地方对查出来的那一小撮自己 stat
 */
import { z } from 'zod'

/** 盯着改动的方式：auto = Windows / macOS 用系统通知、Linux 不盯（逐目录 inotify 会碰上限还丢事件）；on / off 强制 */
export const FileIndexWatch = z.enum(['auto', 'on', 'off'])
export type FileIndexWatch = z.infer<typeof FileIndexWatch>

/**
 * 项目设置里的「文件索引」（Project.fileIndex，可选；没写时按下面的默认值）。
 * 排除目录不在这里：和搜索共用项目的 searchExclude（AI 初始化分析项目后填的那份）
 */
export const FileIndexSettings = z.object({
  /** 开关：默认开（用户 2026-11-23 定） */
  enabled: z.boolean().default(true),
  /** 只收版本管理里的文件（Git：ls-files --cached；P4：p4 have）。默认关：按磁盘 + 排除目录收，刚建还没 add 的也能找到 */
  vcsOnly: z.boolean().default(false),
  watch: FileIndexWatch.default('auto'),
  /** 额外收录的目录（绝对路径，或相对项目根）；文档根、UE 引擎目录由面板和插件自动加，不用写在这里 */
  extraRoots: z.array(z.string().trim().min(1).max(400)).max(20).default([]),
  /** 也收插件报上来的外部目录（UE 引擎目录这类）：默认收（用户 2026-11-23 定） */
  pluginRoots: z.boolean().default(true),
})
export type FileIndexSettings = z.infer<typeof FileIndexSettings>

/** 项目没写时的设置 */
export const fileIndexSettingsOf = (p: { fileIndex?: Partial<FileIndexSettings> } | undefined): FileIndexSettings =>
  FileIndexSettings.parse(p?.fileIndex ?? {})

/** 一份索引（一个根目录）现在的状态 */
export const FileIndexState = z.enum(['off', 'building', 'ready', 'verifying', 'error'])
export type FileIndexState = z.infer<typeof FileIndexState>

/** 一个根目录的状态（项目可能有好几个根：项目目录、文档根、额外目录、引擎目录） */
export const FileIndexRootStatus = z.object({
  /** 落盘文件名用的键（根路径 + 规则的哈希） */
  key: z.string(),
  root: z.string(),
  /** 这个根从哪来：project 项目目录、doc 文档根、extra 设置里加的、plugin:<插件 id> 插件报的 */
  source: z.string(),
  vcs: z.enum(['git', 'p4', 'svn', 'none']),
  state: FileIndexState,
  files: z.number(),
  dirs: z.number(),
  /** 落盘大小（字节）；还没写过盘是 0 */
  bytes: z.number(),
  /** 建立中：已读的目录数，和上次全量的目录数（第一次建时没有）；整体核对中：已核对的步数和总步数（files 为 0） */
  progress: z.object({ dirs: z.number(), files: z.number(), expect: z.number().optional() }).optional(),
  builtAt: z.number().optional(),
  buildMs: z.number().optional(),
  changedAt: z.number().optional(),
  verifiedAt: z.number().optional(),
  /** 最近一次变化是谁带来的：agent / panel / watch / verify / plugin */
  lastBy: z.string().optional(),
  /** 监听方式：system 系统通知、none 不盯（靠定时核对） */
  watching: z.enum(['system', 'none']),
  error: z.string().optional(),
})
export type FileIndexRootStatus = z.infer<typeof FileIndexRootStatus>

/** 一个项目的索引状态（项目设置的状态卡） */
export const FileIndexStatus = z.object({
  projectId: z.string(),
  enabled: z.boolean(),
  state: FileIndexState,
  files: z.number(),
  dirs: z.number(),
  bytes: z.number(),
  roots: z.array(FileIndexRootStatus),
})
export type FileIndexStatus = z.infer<typeof FileIndexStatus>

/** 数据页的一行：一份落盘的索引（含项目已经删了的「无主」索引） */
export const FileIndexDiskEntry = z.object({
  key: z.string(),
  root: z.string(),
  /** 用到它的项目；空数组就是无主 */
  projects: z.array(z.object({ id: z.string(), name: z.string() })),
  vcs: z.string(),
  state: FileIndexState,
  files: z.number(),
  dirs: z.number(),
  bytes: z.number(),
  changedAt: z.number().optional(),
  builtAt: z.number().optional(),
})
export type FileIndexDiskEntry = z.infer<typeof FileIndexDiskEntry>

export const FileIndexOverview = z.object({
  dir: z.string(),
  bytes: z.number(),
  entries: z.array(FileIndexDiskEntry),
})
export type FileIndexOverview = z.infer<typeof FileIndexOverview>

/** 按名字找 / 按文件夹取的结果：统一的列表信封（和 ADR 0067 的分页约定一致） */
export const FileIndexHits = z.object({
  count: z.number(),
  offset: z.number(),
  total: z.number(),
  hasMore: z.boolean(),
  /** 路径：项目目录里的用相对项目根的写法，其他根用绝对路径；都用 / 分隔 */
  items: z.array(z.string()),
  /** 索引还没建好，按已有的部分回答 */
  partial: z.boolean().optional(),
  /** 结果来自多久以前核对过的索引（毫秒）：找不到时提示 Agent refresh */
  ageMs: z.number().optional(),
})
export type FileIndexHits = z.infer<typeof FileIndexHits>

export const FileIndexFindQuery = z.object({
  q: z.string().max(400),
  under: z.array(z.string()).max(20).optional(),
  ext: z.array(z.string()).max(30).optional(),
  dirs: z.boolean().optional(),
  limit: z.number().int().min(1).max(5000).optional(),
  offset: z.number().int().min(0).optional(),
})
export type FileIndexFindQuery = z.infer<typeof FileIndexFindQuery>

/** 推给页面的事件：状态变了（建立进度、就绪、增删） */
export interface FileIndexSignal {
  type: 'file-index'
  projectId: string
  status: FileIndexStatus
}

/** 分页（服务端和演示共用）：items 已排好序 */
export function fileIndexPage(
  items: string[],
  offset: number,
  limit: number,
  extra: Partial<FileIndexHits> = {},
): FileIndexHits {
  const slice = items.slice(offset, offset + limit)
  return {
    count: slice.length,
    offset,
    total: items.length,
    hasMore: offset + slice.length < items.length,
    items: slice,
    ...extra,
  }
}
