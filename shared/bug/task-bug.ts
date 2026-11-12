import { z } from 'zod'
import { BugCase, Diagnosis, FixBrief } from '../bug-diagnosis-schema.ts'

/**
 * 对话上和用户报的 Bug 有关的数据（重构文档第 15 条）：原来平铺在 Task 顶层（bug、bugFix、diagnoses、bugCase、
 * fixBrief、logBase、bugMethodPending），收进 task.bug 一个子对象。普通对话没有 task.bug。
 * 旧数据由 server/migrations/0004-task-bug.ts 一次性转过来，旧导出文件导入时由 liftBugFields 转。
 */
export const TaskBug = z.object({
  /**
   * report：父对话派来、或用户 /bug 标的 Bug（ADR 0045），修之前交诊断报告 diagnoses，用户确认方案才能改（原 task.bug）；
   * fix：直接修的用户 Bug（send_to_conversation 的 kind: "fix"，分析稿 B2），收尾时留简版报告 fixBrief，不交诊断报告（原 task.bugFix）
   */
  kind: z.enum(['report', 'fix']),
  diagnoses: z.array(Diagnosis).optional(),
  /** Bug 档案草稿（ADR 0046）：update_bug_case 随查随记，submit_diagnosis 冻结成一版（原 task.bugCase） */
  case: BugCase.optional(),
  /** 直接修的 Bug 的简版报告（根因一句、改了什么、怎么验证的）：只读，见 shared/bug-fix-brief.ts */
  fixBrief: FixBrief.optional(),
  /**
   * 加临时日志之前各文件的快照（文件相对路径 → 内容哈希，内容存在对话目录的 log-base/ 下；不存在的文件记空串）。
   * 用户同意加日志时拍，只用来在取消修复后核对日志删干净了没有（shared/bug-cleanup.ts），不拿来还原
   */
  logBase: z.record(z.string(), z.string()).optional(),
  /** 父对话把已有子对话升级成用户报的 Bug（ADR 0057）：下一轮补带一次完整流程，带过就清掉（原 task.bugMethodPending） */
  methodPending: z.boolean().optional(),
})
export type TaskBug = z.infer<typeof TaskBug>

/**
 * 往 task.bug 里写字段时取它：调用方已经确认这是 Bug 对话（交报告、记档案、拍日志快照都只有 Bug 对话能走到）。
 * 万一没有（数据被手改过），按要交报告的 Bug 补上，不让这次写入丢掉
 */
export const bugOf = (t: { bug?: TaskBug }): TaskBug => (t.bug ??= { kind: 'report' })

/** 旧格式平铺在 Task 顶层的字段 → task.bug 里的键 */
const LEGACY_KEYS = {
  diagnoses: 'diagnoses',
  bugCase: 'case',
  fixBrief: 'fixBrief',
  logBase: 'logBase',
  bugMethodPending: 'methodPending',
} as const

/**
 * 把旧格式的原始任务 JSON（顶层 bug: true / bugFix: true 和其余 Bug 字段）就地改成 task.bug 子对象，返回改没改。
 * 已经是新格式（bug 是对象）的不动，所以可以重复跑。只给一次性迁移和导入旧导出文件用，读任务时不再调。
 * 旧格式里 bug 和 bugFix 同时为真（直接修的子对话被升级成要交报告的 Bug）按 report 算：升级后走的是完整流程
 */
export function liftBugFields(raw: Record<string, unknown>): boolean {
  if (raw.bug !== undefined && typeof raw.bug === 'object') return false
  const legacy = ['bug', 'bugFix', ...Object.keys(LEGACY_KEYS)].filter((k) => k in raw)
  if (!legacy.length) return false
  const kind = raw.bug === true ? 'report' : raw.bugFix === true ? 'fix' : undefined
  const bug: Record<string, unknown> = {}
  for (const [from, to] of Object.entries(LEGACY_KEYS)) if (raw[from] !== undefined) bug[to] = raw[from]
  for (const k of legacy) delete raw[k] // delete-ok: 原始 JSON 对象，不是经 store.update 合并的 Task
  // 不是 Bug 的对话上残留的空字段（旧版本写过 diagnoses: [] 之类）直接丢掉，不凭空造出 task.bug
  if (kind) raw.bug = { kind, ...bug }
  return true
}
