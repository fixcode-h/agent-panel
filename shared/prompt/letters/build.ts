/**
 * 编译和父对话测试的几封信（ADR 0004）：子对话申请编译、编译结果推回、排队占位、父对话合回后替它跑的测试结果。
 * 只管措辞，什么时候发由 server/tasks/merge/build.ts、build-results.ts、test-runs.ts 判
 */

interface Conv {
  id: string
  title: string
}

/** 【编译申请】子对话申请 UE 编译，交给父对话；checks 是它做过的检查 */
export const buildAskLetter = (child: Conv, note: string, checks = '') =>
  `【编译申请】子对话「${child.title}」（id ${child.id}）申请 UE 编译：${note}${checks ? `\n它做过的检查：${checks.slice(0, 400)}` : ''}
按申请处理：还有别的子对话的申请没编时合成一次，用 request_build 向面板申请编译，children 写上这些子对话的 id；编译结果面板会同时推给你和它们，失败时它们自己修好再申请。`

/** 【编译申请】面板重启前替子对话起的编译没跑完：留在父对话收件箱里让它重新申请 */
export const buildReopenedLetter = (kid: Conv) =>
  `【编译申请】面板重启前替子对话「${kid.title}」（id ${kid.id}）起的编译没跑完，结果没有拿到：重新调用 request_build（children 写 ["${kid.id}"]），结果会推给它。`

/** 【编译占位】告诉占着编译的父对话：parent 排在它后面 */
export const buildQueuedLetter = (parent: Conv, note: string) =>
  `【编译占位】父对话「${parent.title}」（id ${parent.id}）申请了编译（${note.slice(0, 200)}），排在你占着的编译后面，你的编译跑完它会自动开始。你还要连着编、或者需要它等你的改动时，用 message_peer 告诉它。`

/** 【父对话编译结果】推给子对话 */
export const buildResultLetter = (result: string) => `【父对话编译结果】${result}`

/** 【父对话编译结果】编译通过，子对话已经请过收尾，只等父对话收下 */
export const buildPassedWaitingLetter = (result: string) =>
  `【父对话编译结果】编译通过：${result}\n你已经请父对话验收，等它收下，不用再做什么。`

/** 编译结果里给父对话的一行：这个子对话编译通过了、已经在等它收尾 */
export const buildPassedParentLine = (kid: Conv) =>
  `子对话「${kid.title}」（id ${kid.id}）申请的编译通过了，它已经请你收尾、正在等你：核对它的收尾请求，没问题就调用 finish_child（id ${kid.id}）；要它补的用 send_to_conversation 交回。它不会自己再动。`

/** 【父对话测试通过】lines 是每步测试的耗时行 */
export const parentTestPassedLetter = (lines: string[]) =>
  `【父对话测试通过】父对话在它自己的目录里跑完了范围为「全量，合并后由父对话跑」的步骤（耗时是面板按后台命令的真实起止时间记的）：\n${lines.join('\n') || '（没有记录）'}\n已合回原分支，收尾完成。收尾总结里要有一份「编译 / 测试耗时」：照上面的行写，再加上你自己跑过的步骤（看后台命令结果里的用时）；没跑过的不写，没有记录的写「未记录」，不要编数字。`

/** 【父对话测试未通过】failedText 是报错原文，lines 是已记录的耗时行 */
export const parentTestFailedLetter = (child: Conv, failedText: string, lines: string[]) =>
  `【父对话测试未通过】来自子对话「${child.title}」（id ${child.id}）：你的分支已经合回，但父对话在它的目录里跑这条步骤时失败了，下面是它的报错。\n${failedText}\n${lines.length ? `已记录的耗时：\n${lines.join('\n')}\n` : ''}你的独立分支还在：按报错修好、在你的分支里重新跑通其它检查后调用 submit_merge；合回去时面板会把这些步骤全部重跑一遍（跑过也不跳过），通过才收尾。`

/** 【父对话测试】项目里已经没有要由父对话跑的步骤了 */
export const PARENT_TEST_NONE_LETTER = '【父对话测试】项目里已经没有要由父对话跑的测试步骤了，直接收尾。'
