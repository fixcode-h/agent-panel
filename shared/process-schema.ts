/**
 * 对话进程面板和内存曲线的数据结构（从 schema.ts 拆出来，schema.ts 原样转出，引用处不用改）。
 * 不引用 schema.ts 的值：schema.ts 用 export * 转出这里，反过来引用会成环，模块初始化时取到未定义的值
 */
import { z } from 'zod'

/**
 * 对话进程面板里的一条进程：面板登记的 CLI 或它起的子进程（MCP 服务、shell）。
 * 内存取不到时 rss 为 null（界面显示「未知」），不要用 0 冒充
 */
export const TaskProcess = z.object({
  pid: z.number(),
  /** 父进程；面板起的是 CLI 自己时为空 */
  parentPid: z.number().nullable().default(null),
  /** 命令行摘要：长参数（MCP 配置、临时目录）已经替换掉 */
  command: z.string().default(''),
  /** 归属：哪个对话/子对话/子任务/工作流起的；面板自己的动作（AI 创建、文档）为空 */
  ownerTaskId: z.string().default(''),
  ownerTitle: z.string().default(''),
  /** 进程启动时刻（epoch ms）；取不到时 null */
  startedAt: z.number().nullable().default(null),
  durationMs: z.number().nullable().default(null),
  /** 常驻内存（字节）；取不到时 null */
  rss: z.number().nullable().default(null),
  /** running 运行中；idle 很久没有输出；orphan 任务已经不在跑了（可清理） */
  status: z.enum(['running', 'idle', 'orphan']).default('running'),
  /** cli 面板起的那个进程；child 它起的子进程 */
  kind: z.enum(['cli', 'child']).default('cli'),
})
export type TaskProcess = z.infer<typeof TaskProcess>

/** 一个对话（含附属子对话、子任务）的进程与内存汇总：前端「内存合计」读 cliMemory */
export const TaskProcesses = z.object({
  sampledAt: z.number(),
  processes: z.array(TaskProcess).default([]),
  /** 这个对话及附属任务的 CLI 进程 RSS 合计；取不到系统信息时 null */
  cliMemory: z.number().nullable().default(null),
  /** 面板 server 自己的 RSS：不属于这个对话，界面上单独标明、不计入合计 */
  serverMemory: z.number(),
  /** totalMemory = cliMemory，不含面板自己的内存；cliMemory 未知时 null */
  totalMemory: z.number().nullable().default(null),
  /** 系统进程信息取不到的原因；取得到时为空字符串 */
  unavailable: z.string().default(''),
})
export type TaskProcesses = z.infer<typeof TaskProcesses>

/** 内存曲线上的一个点：t 采样时刻；cli 未知时 total 也是 null（断开而不是掉到 0） */
export const MemoryPoint = z.object({
  t: z.number(),
  /** 面板 server 自己的 RSS，只单独展示，不计入 total */
  server: z.number(),
  /** 这个对话及附属任务的 CLI 内存 */
  cli: z.number().nullable(),
  /** total = cli（不含面板）；cli 未知时 null */
  total: z.number().nullable(),
})
export type MemoryPoint = z.infer<typeof MemoryPoint>

/** 对话内存历史：按时间从旧到新，points 已经按时间范围裁过 */
export const TaskMemoryHistory = z.object({
  sampledAt: z.number(),
  intervalMs: z.number(),
  capacity: z.number(),
  points: z.array(MemoryPoint).default([]),
})
export type TaskMemoryHistory = z.infer<typeof TaskMemoryHistory>

/** 关闭一个进程的结果：失败时把系统给的真实错误带回来 */
export const KillProcessResult = z.object({
  ok: z.boolean(),
  pid: z.number(),
  error: z.string().default(''),
})
export type KillProcessResult = z.infer<typeof KillProcessResult>

/** 清理无效进程：只处理面板登记过、任务已经不在跑的 */
export const CleanProcessesInput = z.object({
  /** 用户在确认列表里勾选的 pid；为空时清全部符合的 */
  pids: z.array(z.number()).max(500).default([]),
})
export type CleanProcessesInput = z.infer<typeof CleanProcessesInput>

export const CleanProcessesResult = z.object({
  /** 真的发过结束的 */
  killed: z.array(z.number()).default([]),
  /** 觉得可以杀但被服务端拦下的（任务还在跑、命令行不像面板起的） */
  skipped: z.array(z.object({ pid: z.number(), reason: z.string() })).default([]),
  /** 登记还在但进程已经结束的（顺手把登记清掉） */
  gone: z.array(z.number()).default([]),
})
export type CleanProcessesResult = z.infer<typeof CleanProcessesResult>

/** AI 清理的建议：只是建议，用户确认后前端再调清理接口 */
export const ProcessSuggestResult = z.object({
  suggestions: z.array(z.object({ pid: z.number(), reason: z.string() })).default([]),
  /** CLI 的原文说明（没有解析出 JSON 时给用户看） */
  text: z.string().default(''),
  error: z.string().default(''),
})
export type ProcessSuggestResult = z.infer<typeof ProcessSuggestResult>

/**
 * 会话内存 AI 分析里的一个归属分组：按 ownerTaskId 汇总，子对话只算自己起的进程树。
 * rss 为 null 表示这个归属的进程都读不到内存（界面显示「未采集」），不是 0
 */
export const TaskMemoryOwner = z.object({
  taskId: z.string().default(''),
  title: z.string().default(''),
  /** 是不是当前打开的这个对话 */
  self: z.boolean().default(false),
  rss: z.number().nullable().default(null),
  /** 进程数，以及其中读到 RSS 的个数 */
  count: z.number().default(0),
  counted: z.number().default(0),
})
export type TaskMemoryOwner = z.infer<typeof TaskMemoryOwner>

/** 会话内存 AI 分析：报告、趋势摘要和交给 AI 的第一句话，界面据此打开排查弹窗 */
export const TaskMemoryAnalysis = z.object({
  sampledAt: z.number(),
  intervalMs: z.number(),
  /** 交给 AI 的报告正文（中文） */
  report: z.string().default(''),
  /** AI 分析的第一句话 */
  ask: z.string().default(''),
  /** 相关目录：项目路径；没有项目时为空（服务端用用户目录） */
  cwd: z.string().default(''),
  /** 最近一段的趋势，采样不足时 null */
  trend: z.enum(['up', 'down', 'flat']).nullable().default(null),
  /** 面板上显示的摘要（和报告里的趋势同源） */
  trendText: z.string().default(''),
  owners: z.array(TaskMemoryOwner).default([]),
  tree: z
    .object({ tasks: z.number(), children: z.number(), running: z.number() })
    .default({ tasks: 1, children: 0, running: 0 }),
})
export type TaskMemoryAnalysis = z.infer<typeof TaskMemoryAnalysis>
