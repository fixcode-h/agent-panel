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
  { id: 'uploads', label: t('附件'), hint: t('任务里附上的文件和图片'), clearable: true },
  { id: 'cache', label: t('缓存'), hint: t('下载的更新包、损坏文件的备份，可以随时清理'), clearable: true },
] as const

export type DataKind = (typeof DATA_KINDS)[number]['id']

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
