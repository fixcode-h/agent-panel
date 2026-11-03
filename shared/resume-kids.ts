import type { StopReason, Task } from './schema.ts'
import { activePlan, FAIL_PREFIX, rollUp, setStatus } from './plan.ts'
import { stopReasonText, taskDeleted } from './task.ts'

// 放在单独的文件里：shared/task.ts、shared/plan.ts 都快到行数上限（scripts/file-caps.json）

/** 父对话继续时要看的子对话字段 */
export type ResumeKid = Pick<Task, 'id' | 'title' | 'stopReason' | 'wrapRequest'>

/** 被连带打断、父对话继续时要接着做的停止原因：父对话停的、面板重启、卡住重开、核对时收口、整棵树到了用量上限 */
const AGAIN: StopReason[] = ['parent', 'restart', 'stalled', 'lost', 'budget']

/**
 * 父对话计划里等这个子对话的都已经收成「成功」，没有还在等、也没有失败的：父对话已经收下它的结果。
 * 之后它又被父对话的停止连带打断（比如正在回父对话的一句话），活本身已经交了，继续时不能让它从头再做一遍。
 * 被连带停下时等它的那一步保持「等待中」（ADR 0042，见 childReport 的 settle），所以这里不会把没交付的误判成已交付
 */
export function kidAccepted(parent: Pick<Task, 'plans'>, kidId: string): boolean {
  const plan = parent.plans?.at(-1)
  const waits = (plan?.steps ?? [])
    .flatMap((s) => [s, ...s.children])
    .flatMap((x) => x.waits)
    .filter((w) => w.kind === 'child' && w.ref === kidId)
  return waits.length > 0 && waits.every((w) => w.state === 'ok')
}

/**
 * 父对话继续时，停着的子对话分三类（实测报告问题 3）：
 * - resume：被连带打断、活还没交的，由面板拉起来接着做；
 * - userStopped：用户单独停掉的，那是用户明确的「先别动」，不拉、也不让父对话自动重派，在续接说明里列出来问用户；
 * - skipped：已经请父对话收尾（待收尾）或父对话已经收下结果的，不拉，免得把做完的事再做一遍。
 * kids 只传已停止、没收尾、没归档删除、没在执行的子对话（调用方先筛）
 */
export function sortStoppedKids<K extends ResumeKid>(parent: Pick<Task, 'plans'>, kids: K[]) {
  const out = { resume: [] as K[], userStopped: [] as K[], skipped: [] as K[] }
  for (const k of kids) {
    if (k.stopReason === 'user') out.userStopped.push(k)
    else if (!k.stopReason || !AGAIN.includes(k.stopReason)) continue
    else if (waitingWrap(k) || kidAccepted(parent, k.id)) out.skipped.push(k)
    else out.resume.push(k)
  }
  return out
}

/**
 * 首页「全部继续」（面板重启后，实测报告问题 18）能拉起哪些对话：只拉顶层的。
 * 子对话由父对话继续时连带拉起（上面的 sortStoppedKids 跳过用户停掉的、已交付的），这里再拉一遍就会重复拉起，
 * 用户单独停掉的子对话也会被推翻。只认停止原因是「面板重启」的：重启后用户继续过、又自己停掉的，
 * 或者已经做完的都不再列
 */
export function restartResumable(
  task: Pick<Task, 'parentTaskId' | 'imported' | 'archived' | 'resolved' | 'status' | 'stopReason' | 'deletedAt'>,
): boolean {
  if (task.parentTaskId || task.imported || task.archived || task.resolved || taskDeleted(task)) return false
  return (task.status === 'stopped' || task.status === 'failed') && task.stopReason === 'restart'
}

/** 已经请父对话收尾、在等父对话合并或跑测试：子对话这边没有活了。测试没通过退回修的（test-failed）还要它接着改，不算 */
function waitingWrap(k: ResumeKid) {
  const s = k.wrapRequest?.state
  return s === 'requested' || s === 'merging' || s === 'testing'
}

/** 续接说明里补的几行：没拉起来的子对话分别为什么没拉、父对话该怎么对待 */
export function kidsSkipNote(userStopped: ResumeKid[], skipped: ResumeKid[]): string[] {
  const names = (list: ResumeKid[]) => list.map((k) => `「${k.title}」（id ${k.id}）`).join('、')
  const lines: string[] = []
  if (userStopped.length)
    lines.push(
      `- 用户单独停掉的子对话：${names(userStopped)}。这是用户的决定，不是失败：面板没有拉起它们，不要自动交回、重派或另建子对话重做；在回复里告诉用户它们还停着，问要不要一起继续。`,
    )
  if (skipped.length)
    lines.push(
      `- 已经交付或在等你收尾的子对话没有重新拉起：${names(skipped)}。它们的活已经交了，不要让它们重做；请过收尾的按收尾请求用 finish_child 处理。`,
    )
  return lines
}

/**
 * 对话被打断后点「继续执行」：交给 CLI 的那句话前面写清这是续接、中断时还有哪些没跑完。
 * 以前只把最后一条要求原样再发一遍：模型不知道自己被打断过，要么从头重做，要么不知道还有子任务、工作流没跑完；
 * 父对话也不知道面板已经把子对话拉起来了，又另建一个子对话重做（用户报过）。
 * resumed：面板这次连带拉起来的子对话标题；failed：没能拉起来的（父对话据此另建子对话接手，ADR 0032）
 */
export function resumeNote(
  task: Pick<Task, 'stopReason' | 'steps' | 'runs'> & { plans?: Task['plans']; stoppedJobs?: Task['stoppedJobs'] },
  resumed: string[] = [],
  failed: { id: string; title: string; error: string }[] = [],
): string {
  const lines = [
    `（面板说明：上一轮${task.stopReason ? `${stopReasonText(task.stopReason)}` : '被中断了'}，现在在原来的会话里接着做。` +
      '先看计划里没做完的步骤接着做，已经完成的不要重做。）',
  ]
  if (resumed.length)
    lines.push(
      `- 一起中断的子对话已经由面板拉起来接着做：${resumed.map((x) => `「${x}」`).join('、')}。不用另建子对话重做，等它们的结果；要补充就 send_to_conversation 交给它们。`,
    )
  if (failed.length)
    lines.push(
      `- 没能拉起来的子对话：${failed.map((k) => `「${k.title}」（id ${k.id}，${k.error.split('\n')[0].slice(0, 120)}）`).join('、')}。` +
        '计划里等它的那一步已退回进行中；需要的话另建子对话接手（它原来的改动还在它的目录 / 分支里），不要干等它的结果。',
    )
  const helpers = task.steps.filter((s) => s.slot === 'sub' && s.interrupted && s.status !== 'done')
  if (helpers.length)
    lines.push(
      `- 中断时没跑完的子任务：${helpers.map((s) => `「${s.title}」（id ${s.id}）`).join('、')}。还需要就用 spawn_agents 带 resume: <id> 在原来的会话里接着跑，不要重新派一个（有中断没做完的子任务时另派新的会被拒绝）；不需要了就用 stop_subtask 终止。`,
    )
  const runs = (task.runs ?? []).filter((r) => r.status === 'stopped' || r.status === 'running')
  if (runs.length)
    lines.push(
      `- 中断时没跑完的工作流：${runs.map((r) => `「${r.workflowName || r.workflowId}」`).join('、')}。计划里绑着它的那一步已退回进行中（需要修复），还要跑就用 start_plan 重新启动那一步。`,
    )
  const jobs = task.stoppedJobs ?? []
  if (jobs.length)
    lines.push(
      `- 中断时一起停掉的后台命令：${jobs.map((j) => `「${j.name}」（${j.command.split('\n')[0].slice(0, 120)}）`).join('、')}。它们不会再推回结果，不要等；还需要结果就用 run_background 重新启动，不需要了就在计划里把等它的那一步改掉。`,
    )
  return lines.join('\n')
}

/**
 * 子对话重新跑起来了（父对话继续时连带拉起，或者用户直接继续它）：父计划里等它、已经收成失败的等待改回「等待中」，
 * 它做完时结果才对得上、父对话才会被叫醒（ADR 0042）。那一步只因为等它而退回「需要修复」的，也改回等待中。
 * 返回有没有改动（调用方据此落盘）
 */
export function rearmKidWait(parent: Pick<Task, 'plans'>, kidId: string, now = new Date().toISOString()): boolean {
  const plan = activePlan(parent)
  if (!plan) return false
  let changed = false
  for (const step of plan.steps) {
    let touched = false
    for (const item of [...step.children, step]) {
      const hit = item.waits.filter((w) => w.kind === 'child' && w.ref === kidId && w.state === 'failed')
      if (!hit.length) continue
      for (const w of hit) w.state = 'waiting'
      changed = touched = true
      if (item.status !== 'running' || item.waits.some((w) => w.state === 'failed')) continue
      // 「需要修复」是 settleWait 因为等的结果失败写上的：失败的等待都恢复了，这句说明也就过时了
      if (item.note.startsWith(FAIL_PREFIX)) item.note = ''
      setStatus(item, 'waiting', now)
    }
    if (!touched || !step.children.length) continue
    // 主步骤原先也因为「需要修复」退回了进行中：子步骤都不在做了就跟着回到等待中（rollUp 只把「待做」改成等待中）
    if (step.status === 'running' && !step.children.some((c) => c.status === 'running')) setStatus(step, 'waiting', now)
    rollUp(step, now)
  }
  if (changed) plan.updatedAt = now
  return changed
}
