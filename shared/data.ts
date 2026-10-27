import { z } from 'zod'
import { t } from './i18n.ts'

/** 用户数据目录里的几类数据，设置的「数据」里按类显示占用、清理、导入导出 */
export const DATA_KINDS = [
  { id: 'config', label: t('配置'), hint: t('设置、角色、工作流和分类'), clearable: false },
  {
    id: 'projects',
    label: t('项目'),
    hint: t('添加的项目（不会动项目目录里的文件）；清理时任务记录一起清掉'),
    clearable: true,
  },
  { id: 'tasks', label: t('任务记录'), hint: t('执行过的工作流、对话和聊天，包括输出和用量'), clearable: true },
  {
    id: 'workspace',
    label: t('对话工作目录'),
    hint: t('每个对话自己的目录，Agent 在里面写文件、下载网页；清理只删目录内容，对话记录还在'),
    // 逐个对话清理（见「设置 → 数据」的清理面板），不能整类清空：在跑的和回收站里的不能动
    clearable: false,
  },
  { id: 'uploads', label: t('附件'), hint: t('任务里附上的文件和图片'), clearable: true },
  { id: 'cache', label: t('缓存'), hint: t('下载的更新包、损坏文件的备份，可以随时清理'), clearable: true },
] as const

export type DataKind = (typeof DATA_KINDS)[number]['id']

/**
 * 不参与导出 / 导入的分类：对话工作目录是 Agent 下载的网页快照、装好的依赖，几百 MB，
 * 塞进备份文件会让导出没法用。独立分支（worktrees/）连 DATA_KINDS 都不进：四 GB、十几万个文件，
 * 每次打开设置都递归一遍太慢，它只在清理面板里按需统计
 */
export const NOT_EXPORTED: DataKind[] = ['workspace']

/** 能导出 / 导入的分类：缓存是下载的更新包，工作目录和独立分支是执行时产生的中间产物 */
export const EXPORTABLE_KINDS = DATA_KINDS.filter((k) => k.id !== 'cache' && !NOT_EXPORTED.includes(k.id))

/** 分类能不能导出（导入时也只认这些：否则一份伪造的备份能把 chats/ 目录清掉） */
export const canExport = (id: string): id is DataKind =>
  DATA_KINDS.some((k) => k.id === id && k.id !== 'cache' && !NOT_EXPORTED.includes(k.id))

/** 单个对话的工作目录超过这个大小就在「数据」里标出来提示清理（只标一行，不弹窗） */
export const CHAT_WORKSPACE_WARN_BYTES = 200 * 1024 * 1024

/** 「设置 → 数据」里最多列出多少个对话工作目录（按占用倒序），其余只计入合计 */
export const CHAT_WORKSPACE_TOP_N = 20

/**
 * 面板自己产生的构建产物：都由 npm run 重新生成，可以一键清。
 * 它们不在数据目录里（在仓库 / 安装目录下），所以不进 DATA_KINDS 的占用统计，单独一块
 */
export const BUILD_OUTPUTS = [
  { id: 'dist', label: t('正式版前端'), hint: t('npm run build 生成，清掉后重新构建就有了') },
  { id: 'dist-demo', label: t('演示版前端'), hint: t('vite build --mode demo 生成，界面检查用') },
  { id: 'release', label: t('历史安装包'), hint: t('npm run package 生成，旧版本的包可以清') },
  { id: 'ui-shots', label: t('界面检查截图'), hint: t('node scripts/ui-check.mjs 生成，可以清') },
] as const
export type BuildOutputId = (typeof BUILD_OUTPUTS)[number]['id']

/**
 * 面板进程的一次内存采样（字节）。
 * 只记面板这个 Node 服务进程自己的内存；它启动的编码 CLI 是子进程，内存另算（见 MemoryUsage.child）
 */
export const MemorySample = z.object({
  /** 采样时刻（ISO）：序列按它排序，曲线的时间轴也用它 */
  at: z.string(),
  rss: z.number(),
  heapTotal: z.number(),
  heapUsed: z.number(),
  external: z.number(),
  /** Buffer、TypedArray 的底层内存（算在 external 里）：大文件、图片、日志缓冲堆在这里 */
  arrayBuffers: z.number(),
  /** 采样这一刻正在执行的任务数：曲线涨的那段时间是不是在跑任务，一眼能对上 */
  running: z.number().int(),
  /**
   * 采样这一刻面板拉起的子进程（CLI 等）合计内存。
   * 这台机器上读不到时是 null（界面显示「未采集」），不能写成 0：0 会被当成真的没占用
   */
  child: z.number().nullable(),
})
export type MemorySample = z.infer<typeof MemorySample>

/**
 * 内存这一块：最新一次采样 + 最近一段时间的序列 + 采样设置 + 面板规模。
 * /data 和 /data/memory 共用一份（后者只取内存，不遍历数据目录，前端定时刷新用它）
 */
export const MemoryUsage = z.object({
  /** 最近一次采样，等于 samples 的最后一个 */
  memory: MemorySample,
  /** 采样序列，按时间正序；保留最近两小时（见 sampling.keepMs） */
  samples: z.array(MemorySample),
  sampling: z.object({
    /** 采样间隔（毫秒），在设置里改，改完下一次采样生效 */
    intervalMs: z.number().int(),
    /** 序列保留多长时间（毫秒） */
    keepMs: z.number().int(),
  }),
  /** 面板进程启动到现在（毫秒） */
  uptimeMs: z.number(),
  /**
   * 面板启动的 CLI 子进程（运行中的任务、检测命令等）。
   * Windows 上不引依赖读不到它们的内存，bytes 是 null，界面显示「—」而不是 0：0 会被当成真的没占用
   */
  child: z.object({ processes: z.number().int(), bytes: z.number().nullable() }),
  /** 面板现在的规模：内存数值跟这些数量比才有意义 */
  scale: z.object({
    tasks: z.number().int(),
    chats: z.number().int(),
    projects: z.number().int(),
    running: z.number().int(),
  }),
})
export type MemoryUsage = z.infer<typeof MemoryUsage>

/**
 * 「设置 → 数据」的清理面板：对话工作目录 Top N、构建产物。
 * 和 DataUsage 分开取：这一份要逐个目录 stat；内存曲线按采样间隔刷新时不该带上它
 */
export const CleanupReport = z.object({
  chats: z.object({
    /** 所有对话工作目录合计（不只列出来的前 N 个），口径和 DataUsage 的 workspace 一致 */
    bytes: z.number(),
    files: z.number().int(),
    /** 按占用倒序的前 CHAT_WORKSPACE_TOP_N 个 */
    top: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        bytes: z.number(),
        files: z.number().int(),
        /** 在回收站里：保留期内恢复还要用这个目录，不能清 */
        trashed: z.boolean(),
        /** 正在执行（含等下一句、预热）：Agent 正在里面写文件，不能清 */
        running: z.boolean(),
        /** 对话记录已经不在了：目录还在（删对话时文件被占用、rm 失败），照样可以清 */
        orphan: z.boolean(),
      }),
    ),
    /** 列表之外还有几个对话有工作目录 */
    more: z.number().int(),
  }),
  builds: z.array(
    z.object({
      id: z.enum(BUILD_OUTPUTS.map((b) => b.id) as [BuildOutputId, ...BuildOutputId[]]),
      bytes: z.number(),
      /** 这个目录在不在：不在时界面显示「不在」而不是 0 B */
      present: z.boolean(),
    }),
  ),
})
export type CleanupReport = z.infer<typeof CleanupReport>

/**
 * 独立分支（worktrees/）的占用和可清清单。单独一个接口：它要跑 git 判定、递归四 GB / 十几万个文件，
 * 比对话工作目录重得多，只在用户点「检查」或清理时取，不跟着设置页每次打开扫一遍
 */
export const WorktreeCleanup = z.object({
  bytes: z.number(),
  /** 判定和定时清扫一致（改动都已合回原分支、任务已收口或记录不在），再加上没有目标的链接 */
  stale: z.array(z.object({ dir: z.string(), bytes: z.number(), reason: z.string() })),
  staleBytes: z.number(),
})
export type WorktreeCleanup = z.infer<typeof WorktreeCleanup>

/** 设置的「数据」接口：各类数据的占用，加上内存采样 */
export const DataUsage = z.object({
  /** 数据目录的绝对路径 */
  dir: z.string(),
  kinds: z.array(
    z.object({
      id: z.enum(DATA_KINDS.map((k) => k.id) as [DataKind, ...DataKind[]]),
      files: z.number().int(),
      bytes: z.number(),
    }),
  ),
  /** 运行日志：每次启动一个文件，写满 5 MB 换下一个；在线演示没有 */
  logs: z.object({ dir: z.string(), current: z.string(), files: z.number().int(), bytes: z.number() }).optional(),
  ...MemoryUsage.shape,
})
export type DataUsage = z.infer<typeof DataUsage>
