import type { StopReason, Task } from './schema.ts'

// 放在单独的文件里：shared/task.ts、shared/plan.ts 都快到行数上限（scripts/file-caps.json）

/** 父对话继续时要看的子对话字段 */
export type ResumeKid = Pick<Task, 'id' | 'title' | 'stopReason' | 'wrapRequest'>

/** 被连带打断、父对话继续时要接着做的停止原因：父对话停的、面板重启、卡住重开、核对时收口 */
const AGAIN: StopReason[] = ['parent', 'restart', 'stalled', 'lost']

/**
 * 父对话计划里等这个子对话的都已经收成「成功」，没有还在等、也没有失败的：父对话已经收下它的结果。
 * 之后它又被父对话的停止连带打断（比如正在回父对话的一句话），活本身已经交了，继续时不能让它从头再做一遍。
 * 父对话停止时还在等它的那一步会被收成失败（见 noteParent 的 cascaded），所以这里不会把没交付的误判成已交付
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
