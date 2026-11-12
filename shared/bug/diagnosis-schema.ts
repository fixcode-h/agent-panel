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
  /** 作者、日期、标题是面板从版本记录里取的（不是 Agent 写的）：报告上标「已核对」 */
  verified: z.boolean().optional().catch(undefined),
  /** 引入那次改动里出错点那几行的 diff 原文：面板交报告时用版本管理取（git show），Agent 不用写 */
  diff: z.string().max(8000).optional().catch(undefined),
})
export type BugAttribution = z.infer<typeof BugAttribution>

/**
 * 根因评级（用户 2026-11-10 定）：tier 是这个错在哪个层次——low 低级（粗心疏漏：写错名字、漏判空、漏改一处）、
 * mid 中级（逻辑和边界：条件、顺序、状态没想全）、high 高级（设计、并发时序、跨模块契约）；
 * percent 是对根因的把握（0–100）。决策卡上醒目显示，和引入这个问题的提交人放在一起
 */
export const BugRating = z.object({
  tier: z.enum(['low', 'mid', 'high']).catch('mid').default('mid'),
  percent: z.coerce.number().int().min(0).max(100).catch(0).default(0),
  why: str(500),
})
export type BugRating = z.infer<typeof BugRating>

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
  /**
   * 能直接跑的回归测试命令（分析稿 B9）：改前失败、改后通过的那几条。面板在改前的代码和现在的代码上各跑一次，
   * 真实输出放进修复、验证页；只重跑这个对话里 Agent 自己跑过的命令（权限已经过了 CLI 那一关）
   */
  commands: z.array(z.string().max(1000)).max(5).catch([]).default([]),
  runs: str(500),
})
export type BugResult = z.infer<typeof BugResult>

/** 面板跑一次命令的结果：code 是退出码（被停、没跑起来时为空），out 是输出的最后一段 */
export const RecheckRun = z.object({
  code: z.number().int().nullable(),
  out: z.string().max(8000).default(''),
  ms: z.number().default(0),
  timedOut: z.boolean().default(false),
  /** 没跑起来、没取到改前的代码：写原因，界面标「面板没有复核」 */
  error: z.string().max(1000).default(''),
})
export type RecheckRun = z.infer<typeof RecheckRun>

/**
 * 面板复核回归测试（分析稿 B9）：修复、验证这一版交上来、这一轮结束后，面板把 result.commands 在改前
 * （对话开始时的提交，加上现在的测试文件）和现在的代码上各跑一次。running 跑着；done 跑完（每条看 before / after）；
 * skipped 整体跑不了（why 写原因）。只记事实，判定在 shared/bug/recheck.ts
 */
export const Recheck = z.object({
  state: z.enum(['running', 'done', 'skipped']),
  why: z.string().max(1000).default(''),
  at: z.string(),
  doneAt: z.string().optional(),
  items: z
    .array(
      z.object({
        command: z.string(),
        before: RecheckRun.optional(),
        after: RecheckRun.optional(),
        /** 这条整条没跑（不是对话里跑过的命令）：写原因 */
        skip: z.string().max(500).default(''),
      }),
    )
    .default([]),
})
export type Recheck = z.infer<typeof Recheck>

/**
 * 直接修的 Bug（用户发 /fix 或选了直接修，分析稿 B2 第 ③ 条）的简版报告：不用确认，只读能回看。
 * cause 是 Agent 写的根因一句，change / verify 是 submit_merge 的说明和验证，files 是面板取的实际改动
 */
export const FixBrief = z.object({
  cause: z.string().max(2000),
  change: z.string().max(2000).default(''),
  verify: z.string().max(3000).default(''),
  files: z.array(z.string()).default([]),
  at: z.string(),
})
export type FixBrief = z.infer<typeof FixBrief>

/**
 * 报告的阶段：evidence 论证（还没定论，要加日志复现）、cause 根因（等用户同意）、plan 修复方案、
 * fix 修复（修完给用户看改了哪些代码、为什么，用户确认了才验证；用户 2026-11-10 定）、verify 验证（等用户复现给日志）。
 * 按顺序走，论证可以来回多轮；用户否决根因、AI 认可证据不够时回到论证
 */
export const BugPhase = z.enum(['evidence', 'cause', 'plan', 'fix', 'verify'])
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
    .array(
      z.object({
        see: str(1000),
        means: str(1000),
        /**
         * 可核对的写法：日志计划的编号（L2）出现了 / 没出现。用户贴了日志后面板自己对上是哪一种结果
         * （设计稿 2026-11-10 第 3.2 节）
         */
        match: z
          .object({ point: str(20), seen: z.boolean() })
          .optional()
          .catch(undefined),
      }),
    )
    .catch([])
    .default([]),
})
export type BugCollect = z.infer<typeof BugCollect>

/** 关键代码里的一处标记：line 那一行，text 是行里真正出错的那几个字（面板逐字核对、行内高亮），note 行尾说明 */
export const CodeMark = z.object({
  line: z.coerce.number().int().positive(),
  text: str(300),
  note: str(200),
  level: z.enum(['fault', 'related', 'skipped']).catch('related').default('related'),
})
export type CodeMark = z.infer<typeof CodeMark>

/** 一段关键代码：Agent 只写位置和标记，代码原文由面板交报告时读出来存进 snapshot（之后回看都是当时的代码） */
export const CodeRef = z.object({
  id: str(20),
  role: z.enum(['fault', 'trigger', 'caller', 'expected']).catch('fault').default('fault'),
  file: str(500),
  start: z.coerce.number().int().positive(),
  end: z.coerce.number().int().positive(),
  marks: z.array(CodeMark).max(20).catch([]).default([]),
  snapshot: z
    .object({ text: z.string().max(20000), at: z.string() })
    .optional()
    .catch(undefined),
})
export type CodeRef = z.infer<typeof CodeRef>

/**
 * 一条原文引用：log 用户贴的日志（from 第几份报告上贴的，start~end 行，面板取原文），
 * run 本对话跑过的命令输出（text 原样复制，面板在工具输出里逐字找），note 描述（不核对，报告上标成「描述」）
 */
export const BugQuote = z.object({
  id: str(20),
  kind: z.enum(['log', 'run', 'note']).catch('note').default('note'),
  from: z.coerce.number().int().positive().optional().catch(undefined),
  start: z.coerce.number().int().positive().optional().catch(undefined),
  end: z.coerce.number().int().positive().optional().catch(undefined),
  text: str(4000),
  /** 原文里的关键值（left=0）：要在原文里逐字出现，报告上高亮 */
  highlight: z.array(z.string().max(200)).max(10).catch([]).default([]),
})
export type BugQuote = z.infer<typeof BugQuote>

/** 档案里结构化的几块（ADR 0046）：诊断报告的每一版都带着，草稿也是这几块 */
export const BugCaseFields = {
  level: BugLevel.catch('standard').default('standard'),
  levelNote: str(1000),
  stack: z.array(BugHop).catch([]).default([]),
  timeline: z.array(BugTimelineItem).catch([]).default([]),
  attribution: BugAttribution.optional().catch(undefined),
  rating: BugRating.optional().catch(undefined),
  /**
   * 查出来不用改代码（分析稿 B5）：是配置、数据、本来就这么设计、用法不对或外部依赖的问题。
   * 根因那一版带上它，用户同意后不再出修复方案，按 how 告诉用户怎么处理后直接收尾
   */
  noFix: z
    .object({ kind: z.enum(['config', 'data', 'design', 'usage', 'external']).catch('config'), how: str(2000) })
    .optional()
    .catch(undefined),
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
        /** 依据引用的原文编号：构造数据复现时，已排除的假设要有日志或命令输出原文 */
        refs: z.array(z.string().max(20)).max(10).catch([]).default([]),
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
        /** 这一环引用的原文编号（quotes 的 Q1、codeRefs 的 C1）：面板核对编号存在，报告上带原文 */
        refs: z.array(z.string().max(20)).max(10).catch([]).default([]),
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
  /** 多段关键代码（出错点、触发条件、调用方、对照的正确写法），代码由面板交报告时取快照（bug-quotes.ts） */
  codeRefs: z.array(CodeRef).max(6).catch([]).default([]),
  /** 日志、命令输出的原文引用：面板按来源取原文或逐字核对，对不上拒收 */
  quotes: z.array(BugQuote).max(30).catch([]).default([]),
  /** 期望和实际：一行一个值，actual 引用原文编号 */
  expectVsActual: z
    .array(z.object({ what: str(300), expected: str(500), actual: str(500), ref: str(100) }))
    .max(10)
    .catch([])
    .default([]),
  /** 复现用的是什么：user 用户的数据 / 环境，constructed 构造的数据（只算推演），test 测试用例 */
  reproKind: z.enum(['user', 'constructed', 'test']).optional().catch(undefined),
  /**
   * 具体改动：一个文件一行写要改什么（方案页的「具体改动」表；files 没写时由它补）。
   * 修完交修复（phase: fix）时改写成实际改了什么，why 写为什么这么改（「修复」那一步按文件和实际 diff 对上显示）
   */
  changes: z
    .array(
      z.object({
        file: str(500),
        what: str(2000),
        why: str(1500),
        isNew: z.boolean().catch(false).default(false),
      }),
    )
    .catch([])
    .default([]),
  /** 论证阶段：要加的临时日志 */
  logPlan: z.array(BugLogPoint).catch([]).default([]),
  /** 论证 / 验证阶段：复现步骤、日志在哪、过滤条件、每种结果说明什么 */
  collect: BugCollect.optional().catch(undefined),
}

/** 修复改了的一个文件：增删行数不算临时日志；diff 只留 @@ 开头的几段，太长截断 */
export const FixFile = z.object({
  file: z.string(),
  add: z.number().int(),
  del: z.number().int(),
  diff: z.string().max(20000),
  isNew: z.boolean().default(false),
})
export type FixFile = z.infer<typeof FixFile>

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

/**
 * 环境（面板自动采集，分析稿 B4）：交第一份报告时面板自己取，不靠 Agent 填（Agent 填的经常是「未知」）。
 * 每一项都可能取不到（不是 Git 仓库、命令超时），取不到就留空 / 不带，报告里只显示取到的
 */
export const BugEnv = z.object({
  at: str(40),
  /** 操作系统和版本，例如 Windows 11 Pro 10.0.26100 (x64) */
  os: str(200),
  node: str(50),
  /** CLI 的名字和模型：从任务取 */
  cli: str(100),
  model: str(200),
  /** 项目目录（用户的工作区）现在的分支 */
  branch: str(300),
  /** 最近 10 次提交：短哈希、标题、作者、日期 */
  commits: z
    .array(z.object({ hash: str(40), title: str(300), author: str(200), date: str(40) }))
    .max(10)
    .catch([])
    .default([]),
  /** 未提交改动的文件（最多 30 个，多出来的只记个数） */
  dirty: z.array(z.string().max(500)).max(30).catch([]).default([]),
  dirtyMore: z.coerce.number().int().min(0).catch(0).default(0),
  /** 依赖锁文件最近一次改动的提交 */
  lock: z
    .object({ file: str(200), hash: str(40), title: str(300), date: str(40) })
    .optional()
    .catch(undefined),
})
export type BugEnv = z.infer<typeof BugEnv>

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
  /** 验证这一版：出错点那几段代码修前（根因版的快照）和现在的对照，面板交验证时算出来 */
  fixDiffs: z.array(z.object({ id: z.string(), file: z.string(), diff: z.string().max(8000) })).default([]),
  /**
   * 修复、验证这一版：交报告时每个改了的文件和对话开始时比的 diff（临时日志的行去掉了），「修复」那一步按它显示改了哪些代码。
   * 面板交报告时取（shared/bug/fix.ts），不让 Agent 抄
   */
  fixFiles: z.array(FixFile).default([]),
  /** 用户取消修复后删临时日志的进度（shared/bug/cleanup.ts）：Agent 删、面板核对，通过了才关闭报告 */
  cleanup: CleanupState.optional().catch(undefined),
  /** 环境（面板自动采集）：交第一份报告时取，后面几份沿用同一份（shared/bug/env.ts）；旧报告没有 */
  env: BugEnv.optional().catch(undefined),
  /** 面板复核回归测试（分析稿 B9）：修复、验证这一版才有，见 shared/bug/recheck.ts */
  recheck: Recheck.optional().catch(undefined),
  /**
   * 确认次数按风险收放（分析稿 B2）：autoNext 是用户同意这一版时勾了「后面几步没有要注意的就自动通过」；
   * auto 是这一版由面板按这个设置自动通过的（不是用户点的）；merged 是用户确认修复时面板已复核过
   * 「改前失败、改后通过」，验证合在这一次确认里，不再单独交验证（shared/bug/auto.ts）
   */
  autoNext: z.boolean().optional(),
  auto: z.boolean().optional(),
  merged: z.boolean().optional(),
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
  /**
   * 交报告被面板连续退回的次数（分析稿 B8）：从用户最近一条消息算起，交成功清零。
   * total 是这个 Bug 一共被退回几次（流程数据用）；since 是开始计数时用户最后一条消息的 id
   */
  rejects: z
    .object({ n: z.number().int().catch(0), total: z.number().int().catch(0), since: z.string().catch('') })
    .optional()
    .catch(undefined),
  /**
   * 观察期里又报了同类问题（分析稿 B13，shared/bug/observe.ts）：面板派新 Bug 时按关键词对上观察中的旧 Bug，
   * 新的记 relapseOf（原来那个的 id），原来的记 relapses（又报的那几个）。Agent 不写，面板写
   */
  relapseOf: z.string().max(100).optional().catch(undefined),
  relapses: z
    .array(z.object({ id: str(100), title: str(200), at: str(40) }))
    .max(20)
    .optional()
    .catch(undefined),
  updatedAt: z.string().optional(),
})
export type BugCase = z.infer<typeof BugCase>
