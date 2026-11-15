/**
 * 用户对诊断报告的决定怎么落地（复查报告 A4）：记决定（shared/bug/diagnosis.ts 的 decideDiagnosis），
 * 再按 shared/bug/transition.ts 列出的动作执行——给日志计划拍快照、当场关闭时上报父对话、把话交给子对话。
 * 路由和「这一轮结束时执行排队的取消」都走这一个函数，不在各处各自判断后续动作。
 *
 * 它正在回复时点取消（摸底报告第 19 条）：以前直接报 409「等这一轮结束再取消」，用户只能干等再点一次。
 * 现在先记下，这一轮结束时照常执行（取消要收口计划，和正在回复的这一轮抢着写会互相覆盖，所以仍不能当场做）
 */
import { randomUUID } from 'node:crypto'
import type { Task } from '../../shared/schema.ts'
import { decideDiagnosis, diagnosisMessage, type DiagnosisDecision } from '../../shared/bug/diagnosis.ts'
import { decisionEffects } from '../../shared/bug/transition.ts'
import { t } from '../../shared/i18n.ts'
import { log } from '../log.ts'
import { taskMap } from '../runtime/task-state.ts'
import { previewCleanup, snapshotLogBase, snapshotPre } from './bug-cleanup.ts'
import type { TasksScope } from './scope.ts'
import type { Live } from './types.ts'

type Decide = DiagnosisDecision & { drop: string[]; revertFix: boolean }
type Scope = Pick<TasksScope, 'taskDir' | 'store' | 'reportToParent' | 'wakeConv'>

/** 它在回复时用户点的取消：这一轮结束时执行。只在内存里——面板重启后对话已经停了，用户再点一次就能当场取消 */
const queuedCancel = taskMap<{ version: number; decision: Decide }>('diagnosis-cancel')

export const queueCancel = (taskId: string, version: number, decision: Decide) =>
  queuedCancel.set(taskId, { version, decision })

export const cancelQueued = (taskId: string) => queuedCancel.has(taskId)

/** 记下决定并执行随之而来的动作；返回要交给子对话的话（页面带上用户附的文件再发） */
export async function applyDecision(
  s: Scope,
  task: Task,
  entry: Live | undefined,
  version: number,
  decision: Decide,
): Promise<{ ok: true; task: Task; message: string } | { ok: false; error: string }> {
  const dir = await s.taskDir(task).catch(() => '')
  // 取消：服务端自己查临时日志（不信页面传的），有就先叫它删；用户勾的新文件只认查出来的那几个
  let cleanup
  if (decision.cancel) {
    const p = await previewCleanup(task, dir)
    const drop = decision.drop.filter((f) => p.created.includes(f))
    const files = [...new Set(p.found.map((x) => x.file))]
    cleanup = { found: p.found, drop, revertFix: decision.revertFix, pre: await snapshotPre(task, dir, files) }
  }
  const r = decideDiagnosis(task, version, decision, randomUUID, undefined, cleanup)
  if (!r.ok) return r
  const d = task.bug?.diagnoses?.find((x) => x.version === version)
  const effects = decisionEffects(d, decision, r.message, !!task.parentTaskId)
  if (d && effects.some((e) => e.kind === 'snapshot-log-base')) await snapshotLogBase(task, dir, d).catch(() => {})
  if (decision.cancel) task.updatedAt = new Date().toISOString()
  if (entry) entry.rev++
  const saved = (await s.store.update(task.id, task)) ?? task
  if (effects.some((e) => e.kind === 'report-parent'))
    await s
      .reportToParent(saved)
      .catch((e) => log.warn('task', '取消修复后上报父对话失败', { task: task.id, error: (e as Error).message }))
  return { ok: true, task: saved, message: r.message }
}

/** 一轮结束：有排队的取消就执行；要它删临时日志时由面板把话交给它（页面早就关了，没人替它发） */
export async function afterTurnCancel(s: Scope, entry: Live) {
  const q = queuedCancel.get(entry.task.id)
  if (!q) return
  queuedCancel.delete(entry.task.id)
  const r = await applyDecision(s, entry.task, entry, q.version, q.decision)
  if (!r.ok) {
    // 这一轮里它交了新的一版：用户取消的那一版已经被顶掉，不替用户取消新的，在对话里写明让用户自己决定
    const at = new Date().toISOString()
    entry.task.messages.push(
      diagnosisMessage(
        randomUUID(),
        q.version,
        t('你点的取消没有执行：它这一轮交了新的一版，要取消请在新一版上再点'),
        at,
      ),
    )
    entry.rev++
    await s.store.update(entry.task.id, entry.task)
    return
  }
  if (r.message) await s.wakeConv(entry.task.id, r.message)
}
