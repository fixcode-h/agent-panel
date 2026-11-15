/**
 * 诊断报告的状态表（复查报告 A4）：一版报告在什么状态下能变成什么，用户的决定之后面板要做哪几件事。
 *
 * 为什么要有：以前 `d.status = …` 在 diagnosis.ts、chat.ts、auto.ts 里各改各的，决定之后的动作
 * （把话交给子对话、上报父对话、给日志计划拍快照）由路由各自判断，取消后忘了上报父对话、
 * 它在回复时点取消直接报错（摸底报告第 4、19 条）都出在这里。现在状态只经 moveDiagnosis 改，
 * 不合法的转换直接报错不去猜；决定之后的动作由 decisionEffects 列出来，服务端和演示后端照单执行。
 */
import type { Diagnosis } from './diagnosis-schema.ts'
import { phaseOf } from './phase.ts'

export type DiagnosisStatus = Diagnosis['status']

/**
 * 每个状态能去哪：
 * - pending（等用户）：用户同意、退回、贴日志、取消，或者被新交的一版顶掉
 * - questioned（退回了、等新一版）：新一版交上来时顶掉
 * - approved：日志计划同意后请用户复现（requestLogs）、撤回在对话里的确认（retractChat），回到等用户
 * - answered、superseded、cancelled 是终点：取消后再接着做是交新的一版（shared/bug/reopen.ts），不改旧的
 */
const MOVES: Record<DiagnosisStatus, readonly DiagnosisStatus[]> = {
  pending: ['approved', 'questioned', 'answered', 'cancelled', 'superseded'],
  questioned: ['superseded'],
  approved: ['pending'],
  answered: [],
  superseded: [],
  cancelled: [],
}

export const canMoveDiagnosis = (from: DiagnosisStatus, to: DiagnosisStatus) => MOVES[from].includes(to)

/** 改一版报告的状态：只走状态表里有的路，没有的抛错（是面板自己的逻辑错了，不是用户操作的问题） */
export function moveDiagnosis(d: Diagnosis, to: DiagnosisStatus): void {
  if (!canMoveDiagnosis(d.status, to))
    throw new Error(`诊断报告第 ${d.version} 版不能从 ${d.status} 变成 ${to}（shared/bug/transition.ts 的状态表）`)
  d.status = to
}

/** 用户的决定之后面板要做的事 */
export type DiagnosisEffect =
  /** 把这段话作为新消息交给子对话（页面发：要带上用户附的文件） */
  | { kind: 'wake'; message: string }
  /** 报告当场关闭、没有话要交给子对话：这一轮不会再开，只能现在上报父对话（摸底报告第 4 条） */
  | { kind: 'report-parent' }
  /** 同意加日志：给日志计划里的文件拍快照，取消修复后核对「日志删干净了」用 */
  | { kind: 'snapshot-log-base' }

export function decisionEffects(
  d: Diagnosis | undefined,
  decision: { approve: boolean; cancel?: boolean },
  message: string,
  hasParent: boolean,
): DiagnosisEffect[] {
  const out: DiagnosisEffect[] = []
  if (message) out.push({ kind: 'wake', message })
  if (d && decision.approve && !decision.cancel && phaseOf(d) === 'evidence') out.push({ kind: 'snapshot-log-base' })
  if (decision.cancel && !message && hasParent) out.push({ kind: 'report-parent' })
  return out
}
