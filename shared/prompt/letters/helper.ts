/**
 * 子任务（引擎派出的子 Agent）和派它的对话之间的固定话术：结果交回、等待期间用户插话、续接和重试说明、
 * 补问 submit_result / submit_verdict、卡住重试、评审超时提醒。只管措辞，什么时候发由 shared/engine、shared/helper-summary 判
 */
import { clip } from '../../text.ts'
import { REVIEW_SOFT_LIMIT_MIN } from '../../review/limits.ts'

/** 子任务结果交给对话的 CLI。preempt：它正在回复等待期间的用户消息，先放下那条，做完再回去 */
export const helperPrompt = (late: string, preempt = false) =>
  preempt
    ? `【面板】你派出的子任务都结束了。先放下正在回复的这条用户消息，根据下面的结果把派子任务之前的工作做完；` +
      `做完后再回到那条用户消息，接着回复还没回复完的部分。\n\n${late}`
    : `【面板】你派出的子任务都结束了，结果如下：\n\n${late}\n\n请根据这些结果接着做。`

/** 等子任务期间用户发来的消息：马上回复，子任务的结果交回后再接着之前的工作 */
export const sideChatPrompt = (text: string) =>
  '【面板】你派出的子任务还在执行，用户在等待期间发来了消息。请直接回复这条消息，不要停下来等子任务；' +
  '需要用到子任务结果的部分说明会在结果交回后处理。子任务全部交回后面板会把结果交给你，到时先处理结果，' +
  `再回到这里没做完的部分。\n\n用户的消息：\n${text}`

/** 子任务续接上一次的会话（prev 是上一次那一步的标题）；段落标题在 shared/prompt/delta.ts 的 ALWAYS_SECTIONS 里 */
export const resumeSection = (prev: string) =>
  `## 接着上一次做\n这是你之前那个会话的延续（上一次是「${prev}」）：之前读过的文档和代码、给过的意见都还在上下文里，不用从头再读，只看这次交给你的增量和要确认的事。`

/** 子任务重试（again 是上次没做完的原因） */
export const retrySection = (again: string) =>
  `## 这是重试\n这个子任务上次没有做完：${clip(again, 600)}。还在同一个会话里的话，先看看之前已经做了哪些，从中断的地方接着做，已经做完的不用重做。`

/** 补问那一句（发给 Agent，不翻译） */
export const RESULT_ASK =
  '【面板】你还没有用 submit_result 工具交结果。面板只按这个工具判断子任务做完没有，不看回复里写了什么：现在调用它，state 写 done（做完）、unfinished（没做完）或 stuck（做不下去），summary 写结论和关键文件，没做完或卡住时 left 写还差什么、卡在哪。'

/** 补问那一句（发给 Agent，不翻译） */
export const VERDICT_ASK =
  '【面板】你还没有用 submit_verdict 工具交结论。面板只按这个工具判定通过还是不通过，不看回复里写了什么：现在调用它，verdict 写 pass 或 fail，不通过时 blockers 列出必须改的地方。'

/** 卡住重试时交给子任务的那句（发给 Agent，不翻译） */
export const stallRetryAsk = (error: string) =>
  `【面板】你上一次卡住了：${error}\n面板停掉了那次调用，接回这个会话。先看看已经做了哪些，从中断的地方接着做，已经做完的不用重做；做完照样用 submit_result 交结果。`

/** 评审到了软时限，插话叫它马上交卷 */
export const REVIEW_WRAP_NOTE = `【面板提醒】评审已经进行了 ${REVIEW_SOFT_LIMIT_MIN} 分钟：停止再读代码，按目前已确认的意见马上交卷（调用 submit_verdict 交结论，必须处置的意见列进 blockers）；没来得及确认的标「可能」，没看完的文件单列「没看完」。`
