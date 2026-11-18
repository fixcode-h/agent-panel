/**
 * 子对话的状态上报（ADR 0005）：面板写给父对话 Agent 的那封【子对话状态】信。
 * 只管措辞，什么时候报、报哪种由 server/tasks/children/report.ts 判；信固定用中文（提示词不翻译）
 */
import { DIAG_PARENT_RULE } from '../../bug/phase.ts'

/** 「下一步」那一句是哪种情况：调用方按子对话的状态挑一种，没有下一步时为 null */
export type ReportNext =
  /** 只剩合回却没请收尾：stops 是第几次停在这里，last 是面板最后一次转告 */
  | { kind: 'merge-only'; stops: number; nudged: boolean; isolated: boolean; last: boolean }
  /** 未完成且在走 Bug 诊断：stuck 是提醒过还停在原地 */
  | { kind: 'diagnosis'; id: string; stuck: boolean; rejected?: string }
  | { kind: 'unfinished'; id: string; stuck: boolean }
  /** 用户亲手停的 */
  | { kind: 'user-stopped' }
  /** 失败、中断，可以交回重试 */
  | { kind: 'retry'; id: string }

const nudgeText = (stuck: boolean) =>
  stuck
    ? '面板按它自己的计划提醒过它，它说了卡住或者连着几次都没动手，仍停在这里'
    : '它这一轮结束了，计划里有步骤还挂着等待，但它没有在跑的子任务、子对话或后台命令，面板不会再推它'

/** 【子对话状态】里的「下一步」，带开头的换行；没有时为空串 */
export function reportNextText(n: ReportNext | null): string {
  if (!n) return ''
  switch (n.kind) {
    case 'merge-only':
      return (
        `\n这是它第 ${n.stops} 次停在这里没请收尾${n.nudged ? '（面板已经提醒过它一次）' : ''}。` +
        `下一步：用 send_to_conversation 让它${n.isolated ? '在自己的分支里' : ''}评审处置完、跑通验证后调用 submit_merge；它请求收尾后你再 finish_child。` +
        (n.last
          ? '这是面板最后一次转告：交回后它仍不调用 submit_merge，就停下来告诉用户它卡在合回前、卡在哪，由用户决定，不要再来回催。'
          : '')
      )
    case 'diagnosis':
      // 诊断报告的每一步都由用户确认（ADR 0045）：不能叫父对话「缺信息就回答它」，它会替用户拍板（摸底报告第 1 条）
      // 诊断报告被面板退回太多次停下的：把退回原文带上，父对话照原文指出卡在哪一条，
      // 不要泛泛地再列一遍报告要有哪些小节（实跑 2026-11-18：问题都在格式和编号上，列小节没用）
      if (n.rejected)
        return `\n它交的诊断报告被面板核对退回了好几次，停下来了。面板最后一次退回的原文：\n${n.rejected}\n下一步：请用户去它的对话里看一眼，用户发「继续」它会照原文改好再交；你要转交意见就指出卡在原文的哪一条，不要另列报告要求。${DIAG_PARENT_RULE}不要另建子对话重做。`
      return `\n下一步：${nudgeText(n.stuck)}。${DIAG_PARENT_RULE}要补的事实、你自己的意见可以用 send_to_conversation 交给它（id ${n.id}），写明是你的意见；不要另建子对话重做。`
    case 'unfinished':
      return `\n下一步：${nudgeText(n.stuck)}，看上面的结果判断卡在哪：缺信息就回答它，方向不对就改要求，都用 send_to_conversation 交回这个子对话（id ${n.id}），写清新的要求或答案；不要只发「继续」（它会自己接着做，催也没用），也不要另建一个子对话重做。确实做不下去就告诉用户。`
    case 'user-stopped':
      // 用户亲手停的是「先别动」，不是失败：实测里父对话把它当成中断去交回重试，用户停它的意思就没了
      return '\n下一步：这是用户自己停掉的，不是失败。不要自动交回、重派或另建子对话重做；计划里等它的那一步继续等，用户要它接着做时会自己继续，或者交代你再交给它。'
    case 'retry':
      return `\n下一步：要重试就用 send_to_conversation 交回这个子对话（id ${n.id}），它在原来的会话里接着做；不要另建一个子对话重做。它确实起不来（交回时报错）再另建子对话接着做，并在派单里写明接手的是哪个子对话的活。`
  }
}

/** 摘要截掉的全文在哪（ADR 0041 第 14 节）：file 是存进父对话交接目录的路径，存不了时为 null */
export const fullSummaryAt = (title: string, file: string | null) =>
  file ? `完整总结在文件 ${file}，需要细节时读它；` : `完整总结在子对话「${title}」里；`

export interface ChildStatusLetter {
  title: string
  id: string
  /** 状态和原因（childReport 的 why，中文） */
  why: string
  /** reportNextText 的结果 */
  next: string
  /** 用户在子对话里直接交代过的原话 */
  userDirect?: string
  /** 最近的结果（要点） */
  summary: string
  /** 摘要截掉了全文时：fullSummaryAt 的结果 */
  fullAt?: string
}

/** 【子对话状态】信的正文 */
export function childStatusLetter(l: ChildStatusLetter): string {
  const direct = l.userDirect ? `\n用户在这个子对话里直接交代过：${l.userDirect}` : ''
  return `【子对话状态】「${l.title}」（id ${l.id}）${l.why}${l.next}${direct}${l.summary ? `\n最近的结果：${l.summary}${l.fullAt ? `\n（这是摘要。${l.fullAt}面板会自动给用户显示它的总结卡片，不用转述细节）` : ''}` : ''}`
}

/** 「合并中」没人在合，收尾请求退回待处理：留在父对话收件箱里让它重新 finish_child（why 是开头的原因） */
export const mergeReopenedLetter = (kid: { title: string; id: string }, why: string) =>
  `【子对话状态】「${kid.title}」（id ${kid.id}）${why}，这次合并没有完成，收尾请求退回待处理：重新调用 finish_child 合回它。`
