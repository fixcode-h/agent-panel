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

/** 方案比较一项的判定 */
export const Grade = z.enum(['good', 'cost', 'bad'])
export type Grade = z.infer<typeof Grade>

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
  /**
   * 五项各自的判定（用户 2026-11-07 确认的报告设计）：good 好、cost 有代价、bad 不满足，比较表里画成 ✓ ⚠ ✗，
   * 不用读完每格就能比
   */
  grades: z
    .object({
      covers: Grade.optional().catch(undefined),
      misses: Grade.optional().catch(undefined),
      surface: Grade.optional().catch(undefined),
      risk: Grade.optional().catch(undefined),
      fit: Grade.optional().catch(undefined),
      verifiable: Grade.optional().catch(undefined),
    })
    .catch({})
    .default({}),
  /** 会动到的契约：data 数据格式、api 接口、config 配置项；报告最上面的「要注意」按它提醒 */
  touches: z
    .array(z.enum(['data', 'api', 'config']))
    .catch([])
    .default([]),
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
  /** expect 的结构化写法：看到什么 → 说明什么，一种结果一行（用户复现完自己就能对上） */
  outcomes: z
    .array(z.object({ see: str(1000), means: str(1000) }))
    .catch([])
    .default([]),
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
        /** 编号 H1、H2…：日志计划的 hypothesis 按编号对上，面板核对每个待验证的假设都有日志 */
        id: str(20),
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
  /** 证据链三环：trigger 触发 → fault 出错点 → symptom 现象，每环一句话加证据（日志原文、测试输出、path:line） */
  chain: z
    .array(
      z.object({
        step: z.enum(['trigger', 'fault', 'symptom']).catch('fault').default('fault'),
        text: str(1500),
        proof: str(2000),
      }),
    )
    .catch([])
    .default([]),
  /** 关键代码：出错的那几行（面板从工作区读出来显示，不让 Agent 抄）；mark 是出错的那一行 */
  codeRef: z
    .object({
      file: str(500),
      start: z.coerce.number().int().positive(),
      end: z.coerce.number().int().positive(),
      mark: z.coerce.number().int().positive().optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
  /** 具体改动：一个文件一行写要改什么（方案页的「具体改动」表；files 没写时由它补） */
  changes: z
    .array(z.object({ file: str(500), what: str(2000), isNew: z.boolean().catch(false).default(false) }))
    .catch([])
    .default([]),
  /** 论证阶段：要加的临时日志 */
  logPlan: z.array(BugLogPoint).catch([]).default([]),
  /** 论证 / 验证阶段：复现步骤、日志在哪、过滤条件、每种结果说明什么 */
  collect: BugCollect.optional().catch(undefined),
}

const FileLineSchema = z.object({ file: z.string(), line: z.number().int(), text: z.string() })

/**
 * 取消修复后的清理（用户 2026-11-10 定）：running 叫 Agent 删了、等这一轮结束核对；done 核对通过、报告关闭；
 * failed 没删干净、等用户选再删一次还是自己处理；skipped 用户选了不删 / 自己删，直接关闭。
 * found 是点取消时面板查到的临时日志；pre 是点取消那一刻各文件内容的哈希（核对「删多了」用，内容在对话目录）
 */
export const CleanupState = z.object({
  state: z.enum(['running', 'done', 'failed', 'skipped']),
  found: z.array(FileLineSchema).default([]),
  /** 用户勾了要一起删的、为排查新建的文件 */
  drop: z.array(z.string()).default([]),
  /** 用户要求修复也撤掉（共用目录、已修完时） */
  revertFix: z.boolean().default(false),
  /** 核对没过的地方 */
  failed: z
    .array(
      z.object({
        file: z.string(),
        left: z.array(FileLineSchema).default([]),
        blank: z.array(FileLineSchema).default([]),
        extra: z.array(FileLineSchema).default([]),
        removed: z.array(FileLineSchema).default([]),
      }),
    )
    .default([]),
  /** 用户勾的要删的新文件里核对时还在的 */
  kept: z.array(z.string()).default([]),
  pre: z.record(z.string(), z.string()).default({}),
  at: z.string(),
  checkedAt: z.string().optional(),
})
export type CleanupState = z.infer<typeof CleanupState>

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
  answers: z
    .array(
      z.object({
        id: z.number().int(),
        answer: z.string(),
        /** 对这条意见的态度：adopted 采纳、explained 解释、disagree 不同意（报告上画成胶囊） */
        stance: z.enum(['adopted', 'explained', 'disagree']).optional().catch(undefined),
      }),
    )
    .default([]),
  /** 第 2 版起：相比上一份改了什么（一两句，写在报告最上面） */
  whatChanged: z.string().default(''),
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
  /** 用户取消修复后删临时日志的进度（shared/bug-cleanup.ts）：Agent 删、面板核对，通过了才关闭报告 */
  cleanup: CleanupState.optional().catch(undefined),
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
