/**
 * 推对话接着做的提醒：计划没做完就停了（一轮结束后推一轮 / 要结束时同一轮里拦住）、没列计划时的收尾自检、
 * 计划没跟上动手的进度。只管措辞，什么时候推由 server/tasks/drive.ts、before-end.ts 和 shared/plan/pace.ts 判
 */

/** 交给 Agent 的说法里，怎么结束的那一句（提醒、提示词都引用它；不翻译） */
export const END_TURN_HOW =
  '做完了就调用 end_turn（outcome: done），之后必须用一句话简短说明收尾，不要重复总结；做不下去就调用 end_turn（outcome: blocked），need 写缺什么。'

/** 没列计划时的收尾自检（用户 2026-11-05 定的说法） */
export const CHECK_REMINDER =
  '【面板】（收尾自检）这次的事做完了吗？没做完就直接调用工具接着做，不用先说明；' + END_TURN_HOW

/** 计划没做完的提醒要点名的那一步：failed 是等的结果没成功、要先修的，否则 next 是接着做的那一步 */
export interface PlanNudge {
  done: number
  total: number
  failed?: { title: string; note: string }
  next?: { title: string }
}

const nextStep = (p: PlanNudge, fixHow: string) =>
  p.failed
    ? `「${p.failed.title}」${p.failed.note}。${fixHow}`
    : p.next
      ? `接着做「${p.next.title}」：`
      : '接着做下一步：'

const BLOCKED_HOW = '确实做不下去就调用 end_turn（outcome: blocked），need 写卡在哪一步、需要什么。'

/** 一轮结束了计划还没做完、也没在等结果：推它一轮 */
export const planNudge = (p: PlanNudge) =>
  `【面板】你的计划才做了 ${p.done}/${p.total}，也没有在等任何结果，这一轮却结束了。` +
  nextStep(p, '先查清原因、修好后重做，不要把它当成失败放着；确实不做了就标成跳过并说明原因，然后接着做计划。') +
  '直接调用工具去做，不用先说明；一步做完就用 set_plan 标完成，并在同一条回复里接着调用工具做下一步，直到计划做完再调用 end_turn（outcome: done）。' +
  BLOCKED_HOW

/** 要结束这一轮时计划还没做完、也没在等结果：同一轮里拦住 */
export const planBlock = (p: PlanNudge) =>
  `【面板】你的计划才做了 ${p.done}/${p.total}，也没有在等任何结果，先别结束。` +
  nextStep(p, '先查清原因、修好后重做；确实不做了就标成跳过并说明原因，然后接着做计划。') +
  '直接调用工具去做，不用先说明；一步做完就用 set_plan 标完成，接着做下一步，直到计划做完再调用 end_turn（outcome: done）。' +
  BLOCKED_HOW

/** 有没开始的步骤、却没有进行中的步骤，对话在改文件、跑命令 */
export const PLAN_NONE_RUNNING =
  '【面板】计划里现在没有进行中的步骤，你却在改文件、跑命令：先用 set_plan（partial: true，带步骤 id）把正在做的那一步标成进行中，已经做完的标完成，再接着做。'

/** 进行中的那一步很久没动：how 是「超过几分钟、改文件和跑命令几次」 */
export const planStaleHint = (title: string, how: string) =>
  `【面板】计划里「${title}」上次更新以后，已经${how}，计划没再动过。这一步做完了就马上用 set_plan（partial: true，带步骤 id）标完成、把下一步标进行中，再接着做；不要几步做完再一起补。这一步确实还没做完就接着做，不用回复这句。`
