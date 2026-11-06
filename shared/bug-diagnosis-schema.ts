import { z } from 'zod'

/**
 * Bug 的诊断报告（ADR 0045）：父对话派来的 Bug，子对话查到根因、修之前交这份报告，用户确认了方案才能改。
 * 只放 zod 结构（schema.ts 引用它，避免循环）；渲染、校验、收尾核对在 bug-diagnosis.ts
 */

/**
 * 用户在报告上的标注：question 是疑问（要它查清、补证据），change 是改方案（换修法、改范围），
 * info 是补充信息（用户知道的事实，不用回答，下一版要用上）。answer 是下一版里 Agent 对这条的回答
 */
export const DiagnosisNote = z.object({
  id: z.number().int(),
  quote: z.string().max(2000).default(''),
  kind: z.enum(['question', 'change', 'info']).default('question'),
  comment: z.string().max(4000).default(''),
})
export type DiagnosisNote = z.infer<typeof DiagnosisNote>

const str = (max: number) => z.string().max(max).catch('').default('')

/** 级别（ADR 0046）：快速 / 标准 / 深入，按难度定要求；协调器派单初判，子对话可升级、降级要写理由 */
export const BugLevel = z.enum(['quick', 'standard', 'deep'])
export type BugLevel = z.infer<typeof BugLevel>

/** 调用栈的一跳 */
export const BugHop = z.object({
  file: str(500),
  line: z.coerce.number().int().positive().optional().catch(undefined),
  fn: str(300),
  note: str(1000),
})
export type BugHop = z.infer<typeof BugHop>

/** 时间线的一条：event 现象时间线的事件、state 状态流转、change 变更时间线（提交、依赖、配置、数据、环境） */
export const BugTimelineItem = z.object({
  at: str(100),
  source: str(500),
  kind: z.enum(['event', 'state', 'change']).catch('event').default('event'),
  text: str(2000),
  /** 异常的那一条（第一个异常事件、引入问题的那次变更） */
  abnormal: z.boolean().catch(false).default(false),
})
export type BugTimelineItem = z.infer<typeof BugTimelineItem>

/** 责任类别：本次改动、近期变更、历史遗留、外部依赖、环境配置、数据、用户操作、未确定 */
export const BugBlame = z.enum(['current', 'recent', 'legacy', 'external', 'environment', 'data', 'user', 'unknown'])
export type BugBlame = z.infer<typeof BugBlame>

/** 版本归因：引入点（哪次改动、谁、什么时候）和怎么确定的 */
export const BugAttribution = z.object({
  category: BugBlame.catch('unknown').default('unknown'),
  change: str(200),
  author: str(200),
  date: str(100),
  title: str(500),
  how: z.enum(['blame', 'bisect', 'diff', 'log', 'none']).catch('none').default('none'),
  confidence: z.enum(['high', 'medium', 'low']).catch('low').default('low'),
  note: str(2000),
})
export type BugAttribution = z.infer<typeof BugAttribution>

/** 一个候选修法和五项比较 */
export const BugOption = z.object({
  id: str(20),
  title: str(300),
  change: str(3000),
  files: z.array(z.string().max(500)).catch([]).default([]),
  covers: str(1500),
  misses: str(1500),
  surface: str(1000),
  risk: str(1500),
  fit: str(1000),
  verifiable: str(1000),
})
export type BugOption = z.infer<typeof BugOption>

/** 修完的结果：影响面逐条的验证、回归测试；收尾核对按它看 */
export const BugResult = z.object({
  reproBefore: str(3000),
  reproAfter: str(3000),
  impactChecks: z
    .array(z.object({ area: str(300), command: str(1000), output: str(2000) }))
    .catch([])
    .default([]),
  regressionTests: z.array(z.string().max(500)).catch([]).default([]),
  runs: str(500),
})
export type BugResult = z.infer<typeof BugResult>

/**
 * 报告的阶段：evidence 论证（还没定论，要加日志复现）、cause 根因（等用户同意）、plan 修复方案、verify 验证（修完等用户复现给日志）。
 * 按顺序走，论证可以来回多轮；用户否决根因、AI 认可证据不够时回到论证
 */
export const BugPhase = z.enum(['evidence', 'cause', 'plan', 'verify'])
export type BugPhase = z.infer<typeof BugPhase>

/** 日志计划的一处：加在哪、打什么、用来区分哪个假设 */
export const BugLogPoint = z.object({
  id: str(20),
  file: str(500),
  line: z.coerce.number().int().positive().optional().catch(undefined),
  fn: str(300),
  print: str(1000),
  hypothesis: str(300),
})
export type BugLogPoint = z.infer<typeof BugLogPoint>

/** 怎么让用户复现、贴回什么：论证阶段和验证阶段都用 */
export const BugCollect = z.object({
  steps: z.array(z.string().max(500)).catch([]).default([]),
  where: str(500),
  filter: str(300),
  /** 每种结果说明什么（论证）/ 看到什么算修好了（验证） */
  expect: str(2000),
})
export type BugCollect = z.infer<typeof BugCollect>

/** 档案里结构化的几块（ADR 0046）：诊断报告的每一版都带着，草稿也是这几块 */
export const BugCaseFields = {
  level: BugLevel.catch('standard').default('standard'),
  levelNote: str(1000),
  stack: z.array(BugHop).catch([]).default([]),
  timeline: z.array(BugTimelineItem).catch([]).default([]),
  attribution: BugAttribution.optional().catch(undefined),
  consistency: z
    .array(z.object({ observation: str(1000), explanation: str(2000) }))
    .catch([])
    .default([]),
  hypotheses: z
    .array(
      z.object({
        text: str(1500),
        status: z.enum(['confirmed', 'excluded', 'open']).catch('open').default('open'),
        basis: str(2000),
      }),
    )
    .catch([])
    .default([]),
  impact: z
    .array(z.object({ area: str(300), effect: str(1500), verify: str(1000) }))
    .catch([])
    .default([]),
  options: z.array(BugOption).catch([]).default([]),
  chosen: z
    .object({ id: str(20), why: str(2000), whyNotOthers: str(2000) })
    .optional()
    .catch(undefined),
  /** 根因还没找到时：下一步要加的日志、要用户提供什么 */
  next: str(3000),
  /** 论证阶段：要加的临时日志 */
  logPlan: z.array(BugLogPoint).catch([]).default([]),
  /** 论证 / 验证阶段：复现步骤、日志在哪、过滤条件、每种结果说明什么 */
  collect: BugCollect.optional().catch(undefined),
}

export const Diagnosis = z.object({
  ...BugCaseFields,
  /** 旧数据没有：按 confirmed 推（phaseOf） */
  phase: BugPhase.optional().catch(undefined),
  /** 交报告的顺序号（第几份）：接口、对话里那一行都按它认；界面和提示词里的「第几版」是 rev */
  version: z.number().int(),
  /**
   * 第几版（用户 2026-11-06 定）：只在之前的结论被推翻时 +1（回到更早的阶段、确认过的方案换掉），
   * 按意见修改、阶段往下走都还是同一版（nextRev）。旧数据没有：按 version 显示
   */
  rev: z.number().int().optional(),
  at: z.string(),
  symptom: z.string().default(''),
  repro: z.string().default(''),
  location: z.string().default(''),
  evidence: z.string().default(''),
  rootCause: z.string().default(''),
  /** 根因已经用日志、测试证实；false 是还只是假设（报告上标出来） */
  confirmed: z.boolean().default(false),
  excluded: z.string().default(''),
  fix: z.string().default(''),
  /** 方案里要改的文件（相对项目根）：收尾时实际改动按它核对 */
  files: z.array(z.string()).default([]),
  risk: z.string().default(''),
  verify: z.string().default(''),
  /** 第 2 版起：逐条回答上一版的疑问和改方案（id 对上一版 notes 的 id） */
  answers: z.array(z.object({ id: z.number().int(), answer: z.string() })).default([]),
  /**
   * cancelled：用户在审阅弹窗里点了「取消」，这次不修了（计划收口成完成，对话等用户下一句）。
   * answered：用户贴了日志（论证阶段复现的结果、验证阶段的结果），交给 AI 分析
   */
  status: z.enum(['pending', 'questioned', 'approved', 'answered', 'superseded', 'cancelled']).default('pending'),
  /** 论证阶段：用户同意加日志后，AI 加好了日志、请用户复现（request_logs）。有它且 pending 就是「等你复现」 */
  awaiting: z
    .object({ at: z.string(), added: z.array(z.string().max(500)).default([]), collect: BugCollect.optional() })
    .optional(),
  /** 用户贴回的日志（文字部分；附件随消息交给 AI，这里只记文件名） */
  logs: z.string().max(20000).default(''),
  logFiles: z.array(z.string().max(500)).default([]),
  /** 验证阶段：修完的结果（回归测试、影响面逐条的验证），交验证那一版时从档案里带上 */
  result: BugResult.optional().catch(undefined),
  notes: z.array(DiagnosisNote).default([]),
  overall: z.string().default(''),
  decidedAt: z.string().optional(),
  /** 交报告时工作区已经改了的文件：确认之前就动了手的，审阅时摆出来 */
  before: z.array(z.string()).default([]),
})
export type Diagnosis = z.infer<typeof Diagnosis>

/**
 * Bug 档案草稿（ADR 0046）：子对话查的过程中用 update_bug_case 随查随记（传哪个字段就换掉哪个字段），
 * submit_diagnosis 把它和这次交的内容合起来冻结成一版；修完的结果（result）也记在这里，收尾时核对
 */
export const BugCase = z.object({
  symptom: str(4000),
  repro: str(4000),
  location: str(4000),
  evidence: str(8000),
  rootCause: str(4000),
  confirmed: z.boolean().catch(false).default(false),
  excluded: str(4000),
  fix: str(6000),
  files: z.array(z.string().max(500)).catch([]).default([]),
  risk: str(4000),
  verify: str(4000),
  ...BugCaseFields,
  result: BugResult.optional().catch(undefined),
  updatedAt: z.string().optional(),
})
export type BugCase = z.infer<typeof BugCase>
