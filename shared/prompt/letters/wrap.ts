/**
 * 子对话收尾的几封信：子对话请父对话收尾（【收尾请求】）、面板推子对话去请收尾、推父对话处理在等的收尾请求、
 * 父对话收尾的结果（【父对话收尾】）。只管措辞，什么时候发由 server/tasks/children、server/tasks/merge 判
 */
import { BUG_RECORD_ASK } from '../../builtin/bug-method.ts'

export interface WrapRequestLetter {
  title: string
  id: string
  /** 独立分支（没有时是共用目录） */
  worktree?: { branch: string; baseBranch?: string }
  /** 下面几段都是调用方截好（长的存进文件只留路径）的文字，没有就不写 */
  tests: string
  noBuild?: string
  note?: string
  triage?: string
  fixBrief?: string
  /** 用户报的 Bug 的记录草稿 */
  record?: string
  /** 显式放行的记录（overrideText 的结果） */
  bypass?: string
}

/** 【收尾请求】：子对话 submit_merge 后交给父对话 */
export function wrapRequestLetter(l: WrapRequestLetter): string {
  const wt = l.worktree
  return `【收尾请求】子对话「${l.title}」（id ${l.id}）只剩${wt ? '合回' : '验收'}了：计划其余步骤都做完、后台命令都结束、没有待回答的提问。
${wt ? `它在独立分支 ${wt.branch} 里的验证` : '它和你共用目录（改动已经在你的目录里，没有分支要合），它的验证'}：${l.tests}${l.noBuild ? `\n合回后不用编译：${l.noBuild}` : ''}${l.note ? `\n它的说明：${l.note}` : ''}${l.triage ? `\n它对评审意见的处置（评审只出意见，采不采纳是它核实后定的；驳回或留作已知问题的理由站不住时打回给它）：\n${l.triage}` : ''}${l.fixBrief ? `\n${l.fixBrief}` : ''}${l.record ? `\n这是用户报的 Bug。收下它（finish_child）之后：${BUG_RECORD_ASK}下面是 Bug 记录的草稿（用户同意写时派「文档」原样附上，不用它再从对话里摘）：\n${l.record}` : ''}${l.bypass ? `\n⚠️ 它这次的收尾用了**显式放行**：评审门禁被绕过，记录如下（谁、什么时候、为什么、原本拦住什么）——用户要求带着这个问题先合并，你如果觉得理由站不住，打回给它或者直接问用户：\n${l.bypass}` : ''}
${
  wt
    ? `请你收尾：调用 finish_child（id ${l.id}），面板把它的分支合回「${wt.baseBranch || '你所在的分支'}」、把它计划里的收尾步骤标完成、结束它并删除独立分支和分支。`
    : `请你验收：核对它的验证和改动，没问题就调用 finish_child（id ${l.id}），面板把它计划里的收尾步骤标完成、结束它。`
}验证不够、你看出问题时不要收，用 send_to_conversation 把要补的交回给它。`
}

/** 在等父对话收尾的子对话 */
export interface WrapWaitingKid {
  id: string
  title: string
  /** 有独立分支要合回（否则是验收共用目录里的改动） */
  branch: boolean
}

const wrapWaitingLines = (kids: WrapWaitingKid[]) =>
  kids
    .map(
      (k) =>
        `- 「${k.title}」（id ${k.id}）：${k.branch ? '合回它的独立分支' : '验收它的改动'}，验证够了就调用 finish_child（id ${k.id}）；要它补的用 send_to_conversation 交回`,
    )
    .join('\n')

const WRAP_WAITING_TAIL = '直接调用工具处理，不用先说明；收尾请求里有它的验证结果，核对后决定合回还是交回。'

/** 父对话一轮结束了，还有子对话在等它收尾：推它一轮 */
export const wrapWaitingNudge = (kids: WrapWaitingKid[]) =>
  `【面板】这些子对话已经请你收尾，你这一轮结束了却还没处理，它们一直在等你：\n${wrapWaitingLines(kids)}\n` +
  WRAP_WAITING_TAIL

/** 父对话要结束这一轮时还有子对话在等它收尾：同一轮里拦住 */
export const wrapWaitingBlock = (kids: WrapWaitingKid[]) =>
  `【面板】这些子对话已经请你收尾，它们一直在等你，先处理再结束：\n${wrapWaitingLines(kids)}\n` + WRAP_WAITING_TAIL

/**
 * 独立分支的子对话一轮结束了还没请收尾：merged 是分支已经在父对话的分支里（自己 git merge 过去的），
 * 否则 what 列出没合回的改动（几个提交、几个未提交的文件）
 */
export const mergeOwedNudge = (st: { merged: true } | { merged: false; what: string[] }) =>
  st.merged
    ? '【面板】你的分支已经在父对话的分支里了，但还没请父对话收尾，计划停在「合回父对话所在的分支」。直接调用 submit_merge（tests 写上跑过的验证），父对话确认后面板标完成并删除分支。以后收尾都用 submit_merge，不要自己或派子任务去 git merge。'
    : `【面板】你的独立分支里还有没合回父对话分支的改动（${st.what.join('、')}），也还没请父对话收尾。按「验证」在你的分支里跑通编译和测试后调用 submit_merge（tests 写上跑了什么、结果如何），父对话会合并、标完成并删除分支；没合回去之前不算做完。验证没过就修好再交，确实不该合并就说明原因。`

/** 共用目录的子对话一轮结束了还没请父对话验收：changes 是改过的文件数，p4 是还有 P4 分 changelist 没做 */
export const deliverOwedNudge = (changes: number, p4: boolean) =>
  `【面板】${changes ? `你改了 ${changes} 个文件，` : '计划只剩收尾，'}还没请父对话验收。你和父对话共用目录（P4、没有版本管理或项目设成共用目录），没有分支要合，但收尾的必备步骤一样要做：改了代码先按「收尾前评审」派评审、逐条处置${p4 ? '，P4 按文件类型分好 changelist' : ''}，按「验证」跑通编译和测试，再调用 submit_merge（tests 写上跑了什么、结果如何，handoff 写交接要点）。没请父对话验收之前不算做完；确实不该交付就说明原因。`

/** 子对话要结束这一轮却还没请收尾 / 验收：同一轮里拦住（isolated 是有独立分支） */
export const mergeOwedBlock = (isolated: boolean) =>
  isolated
    ? '【面板】你还没请父对话收尾：独立分支里的改动没合回之前不算做完。按「验证」跑通编译和测试，然后直接调用 submit_merge（tests 写上跑了什么、结果如何），父对话会合并、标完成并删除分支；不要自己 git merge。验证没过就修好再交，确实不该合并就调用 end_turn（outcome: blocked）说明原因。'
    : '【面板】你还没请父对话验收：改了代码先按「收尾前评审」派评审、逐条处置，按「验证」跑通编译和测试，再直接调用 submit_merge（tests 写上跑了什么、结果如何，handoff 写交接要点）。确实不该交付就调用 end_turn（outcome: blocked）说明原因。'

/** 【父对话收尾】合回成功，告诉子对话 */
export const parentMergedLetter = (info: string) =>
  `【父对话收尾】已合回原分支：${info}
父对话已经验收合并。计划、后台命令、提问都收口后面板结束这个子对话并删除独立分支；不要再改已经合进去的文件。`

/** 【父对话收尾】共用目录的子对话被验收 */
export const PARENT_ACCEPTED_LETTER =
  '【父对话收尾】父对话已验收你的改动。计划、后台命令、提问都收口后面板结束这个子对话；不要再改这次交付的文件。'

/** 【父对话收尾】合回失败，退回给子对话处理 */
export const parentMergeFailedLetter = (info: string) =>
  `【父对话收尾】没能合回原分支：${info}
在你的分支里处理好、重新跑通验证后再调用 submit_merge 请父对话收尾。`
