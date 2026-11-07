import { BugCase, type BugLevel } from '../../shared/bug-diagnosis-schema.ts'
import { taskLog } from '../task-log.ts'
import type { TasksScope } from './scope.ts'

/** 交给子对话的话前面加的说明：它从这一条开始按完整流程走，之前改过的文件要在报告里交代 */
export const BUG_UPGRADE_HEAD =
  '【改按用户报的 Bug 处理】用户要求把你正在处理的这个问题改按完整的 Bug 查找流程处理：你现在有了 submit_diagnosis，接下来按完整流程分阶段交诊断报告（论证、根因、修复方案、验证），用户在弹窗里同意之前不再改任何文件；之前已经改过的文件写进报告（改了什么、要不要保留）。'

/**
 * 父对话 send_to_conversation 写了 kind: "bug"：把已有子对话标成用户报的 Bug（用户 2026-11-07 要的）。
 * 和用户在子对话里发 /bug 一样（server/tasks/conversation-routes.ts）：标上 Task.bug 它才有 submit_diagnosis、
 * 改文件前要过诊断关卡；续接的会话里没有完整流程，记 bugMethodPending 让下一轮补带一次（server/exec/bug-prompt.ts）。
 * 正在回复的这一轮换不了工具，先拒绝；挂着等下一句的旧进程由交付时的「选择对不上」重开（runner 的 stillCurrent）。
 * 返回要交给子对话的话（已经是 Bug 的原样交）
 */
export async function upgradeChildToBug(
  sc: Pick<TasksScope, 'live' | 'store'>,
  parentId: string,
  id: string,
  message: string,
  level?: BugLevel,
): Promise<{ ok: false; info: string } | { ok: true; message: string; note: string }> {
  const live = sc.live.get(id)
  const child = live?.task ?? (await sc.store.get(id))
  if (!child || child.parentTaskId !== parentId) return { ok: false, info: '找不到这个子对话' }
  if (child.bug) return { ok: true, message, note: '它已经在按用户报的 Bug 流程处理，这条按普通消息交给它。' }
  if (child.working)
    return {
      ok: false,
      info: `子对话「${child.title}」正在回复，这一轮里换不了工具，没有升级：等它这一轮结束（做完会汇报给你）再用 kind: "bug" 交一次，或者请用户先停止它。`,
    }
  child.bug = true
  child.bugMethodPending = true
  if (level && !child.bugCase) child.bugCase = BugCase.parse({ level, levelNote: '父对话初判' })
  await sc.store.update(id, child)
  taskLog(id, '升级为用户报的 Bug', { by: 'parent', level: level ?? '' })
  return {
    ok: true,
    message: `${BUG_UPGRADE_HEAD}\n\n${message}`,
    note: '已把它标成用户报的 Bug：它接下来按完整流程分阶段交诊断报告，报告交上来时告诉用户去哪里看。',
  }
}
