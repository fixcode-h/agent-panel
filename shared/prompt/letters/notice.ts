/**
 * 面板在父子对话之间转的通知信：前置没合回、文件撞了、父对话之间传话、状态询问、卡住重启、换人接手、
 * 改按 Bug 处理、工作流运行的结果。只管措辞，什么时候发由 server/tasks 下各自的文件判
 */
import { clip } from '../../text.ts'

interface Conv {
  id: string
  title: string
}

/** 【前置没合回】排在后面的子对话因为前置出了问题还没启动；bad 是出问题的前置和原因 */
export const afterDepsLetter = (k: Conv, bad: (Conv & { why: string })[]) =>
  `【前置没合回】子对话「${k.title}」（id ${k.id}）排在 ${bad.map((b) => `「${b.title}」（id ${b.id}）`).join('、')} 之后，` +
  `${bad.map((b) => `「${b.title}」${b.why}`).join('；')}，所以它还没启动。` +
  `前置修好合回后它会自动开始；要它现在就开始，用 send_to_conversation 交给它（写清前置没做完、它该怎么办）；确实不做了就在计划里把那一步标跳过。`

/** 【文件撞了】共用目录里子对话改了已经归别的子对话的文件；list 是撞了的文件 */
export const fileClashLetter = (child: Conv, list: string) =>
  `【文件撞了】子对话「${child.title}」（id ${child.id}）这一轮改了已经归别的子对话、改动还没被你验收的文件：${list}。` +
  `它们和你共用一个目录，后写的会覆盖先写的（P4 里一个文件也分不进两个 changelist）。验收前先定谁的版本算数：` +
  `用 send_to_conversation 让一方撤回，或等另一方被你验收后再改，必要时自己核对文件内容；不要同时收下两边。`

/** 【父对话传话】一个父对话用 message_peer 发给另一个父对话 */
export const peerRelayLetter = (from: Conv, text: string) =>
  `【父对话传话】来自「${from.title}」（id ${from.id}）：${text}\n要回话就用 message_peer 回给它；只协调，不用替它做决定。`

/** 【状态询问】子对话 mins 分钟没有输出，以父对话的名义问它 */
export const idleAskLetter = (mins: number) =>
  `【状态询问】你已经 ${mins} 分钟没有输出了。请简短报告：现在在做什么、是否卡住；` +
  `卡住请说明卡在哪一步、需要什么才能继续。没有卡住就说明下一步还要多久，然后接着做。`

/** 【卡住重启】问过没回复，停掉 CLI 接回原会话 */
export const stuckRestartLetter = (mins: number) =>
  `【卡住重启】你已经 ${mins} 分钟没有任何输出，状态询问也没有回复，面板判断 CLI 卡住了，已经停掉它并接回这个会话。` +
  `先用一句话说明刚才卡在哪一步，再从中断的地方接着做；已经做完的不用重做。`

/** 【子对话换人接手】告诉父对话：old 卡住了，已经新开 next 接手 */
export const childReplacedLetter = (old: Conv, why: string, next: Conv) =>
  `【子对话换人接手】「${old.title}」（id ${old.id}）卡住了：${why}。面板停掉它、接回原会话重启也没恢复，` +
  `已经新开子对话「${next.title}」（id ${next.id}）带上原任务和已有进展接手，计划里等它的步骤改成了等新的子对话。` +
  `不要再交回原来的子对话，等新的子对话回报。`

/** 交给子对话的话前面加的说明：它从这一条开始按完整流程走，之前改过的文件要在报告里交代 */
export const BUG_UPGRADE_HEAD =
  '【改按用户报的 Bug 处理】用户要求把你正在处理的这个问题改按完整的 Bug 查找流程处理：你现在有了 submit_diagnosis，接下来按完整流程分阶段交诊断报告（论证、根因、修复方案、验证），用户在弹窗里同意之前不再改任何文件；之前已经改过的文件写进报告（改了什么、要不要保留）。'

/** 【工作流运行】一次运行出错、等合回或结束了，告诉发起它的对话；line 是 runLine 的一行状态 */
export const flowRunLetter = (r: { line: string; phase: string; error: string; summary?: string }) =>
  [
    `【工作流运行】${r.line}`,
    r.phase === 'failed' && r.error ? `出错：${clip(r.error, 600)}` : '',
    (r.phase === 'ready' || r.phase === 'done') && r.summary ? `结论：\n${clip(r.summary, 1500)}` : '',
    r.phase === 'ready'
      ? '看过结论后用 finish_workflow 合回（merge）或放弃（discard）；要改某个节点用 revise_workflow 退回。'
      : '',
    r.phase === 'failed' ? '要它带着意见重跑就用 revise_workflow；不做了就 stop_workflow。' : '',
  ]
    .filter(Boolean)
    .join('\n')

/** 【工作流运行】用户把节点的确认交给父对话决定 */
export const flowDelegateLetter = (r: { workflow: string; id: string; node: string; detail: string }) =>
  `【工作流运行】工作流「${r.workflow}」（id ${r.id}）的节点「${r.node}」做完了，用户请你决定：\n${clip(r.detail, 3000)}\n\n用 answer_workflow 回答：confirm 通过，revise 写清改什么。`
