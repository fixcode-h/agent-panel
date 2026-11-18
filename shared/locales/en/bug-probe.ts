/** 英文词典的一部分，键是中文原文：Bug 的补排查、临时排查改动清单、补排查记录、Bug 对话的动作条 */
export const EN_BUG_PROBE: Record<string, string> = {
  // 设置
  'Bug 对话的动作条': 'Bug conversation action bar',
  '输入框上方放补排查、查看报告、放到工作区': 'Add probe, view report and put-in-workspace above the input box',
  '用户报的 Bug 交了诊断报告以后，子对话的输入框上方多一行常用动作：补排查（随时加日志、调试绘制）、查看报告、把临时代码放到你的工作区或还原。关掉后这些只在报告里点。':
    'Once a user-reported bug has a diagnosis report, the sub-conversation shows a row of common actions above the input box: add probe (logs or debug drawing at any time), view report, and put the temporary code in your workspace or restore it. When off, these are only in the report.',
  // 动作条
  补排查: 'Add probe',
  把修复放到工作区: 'Put the fix in my workspace',
  '查看报告 · 临时改动 {n} 处': 'View report · {n} temporary change(s)',
  // 表单
  '已经记下，但没能交给子对话：{error}': 'Recorded, but could not hand it to the sub-conversation: {error}',
  '报告不重出，马上加；记进「临时排查改动」':
    'No new report; added right away and listed under "Temporary debug changes"',
  '报告停在原来的阶段不动；加的每一行都要带 [排查-P…] 标记，面板这一轮结束逐行核对':
    'The report stays at its current stage; every added line must carry a [排查-P…] marker, and the panel checks line by line when this turn ends',
  马上加: 'Add now',
  补排查的类型: 'Probe type',
  想看什么: 'What to look at',
  '想看什么：例如把角标的位置画个框，数量写在框上':
    'What to look at: e.g. draw a box where the badge is and write the count on it',
  '临时改什么：例如跳过缓存、把超时改成 1 秒（原有的行不改，新增带标记的行）':
    'What to change temporarily: e.g. skip the cache, set the timeout to 1s (existing lines stay; add marked lines)',
  '想看什么：例如点删除之后，打出删之前和删之后的数量':
    'What to look at: e.g. after clicking delete, print the count before and after',
  '加在：': 'Add at:',
  '（从调用栈挑，不挑由它定）': '(pick from the call stack, or let it decide)',
  '加好后放到我的工作区（独立分支里改的，我在自己目录里复现）':
    'Put in my workspace when done (it edits an isolated branch; I reproduce in my own folder)',
  '要重新编译 / 热重载时提醒我': 'Remind me when a rebuild / hot reload is needed',
  补日志: 'Add logs',
  调试绘制: 'Debug drawing',
  其他临时代码: 'Other temporary code',
  // 清单
  打出来了: 'Printed',
  该打没打: 'Not printed',
  在你的工作区: 'In your workspace',
  临时排查改动: 'Temporary debug changes',
  '{n} 处 · {f} 个文件 · +{k} 行': '{n} spot(s) · {f} file(s) · +{k} line(s)',
  '撤掉补排查加的全部临时代码；论证时的日志在修完收尾或不修了时一起删':
    'Remove all temporary code added by probes; logs added during investigation are removed at wrap-up or when you stop fixing',
  全部撤掉: 'Remove all',
  '打开 {file}': 'Open {file}',
  '论证第 {v} 版 · {text}': 'Investigation v{v} · {text}',
  '补排查 · {text}': 'Probe · {text}',
  让它改: 'Ask it to fix',
  撤掉: 'Remove',
  '这一轮没有加任何带标记的代码（或者没用改文件工具改，面板没拍到快照）':
    'Nothing marked was added this turn (or it was not edited with the file tools, so the panel took no snapshot)',
  '改了要编译的代码或脚本：重新编译 / 热重载后再复现。':
    'Code or scripts that need building were changed: rebuild / hot reload before reproducing.',
  '加之前拍了快照：不修了、修完收尾或点「撤掉」时由 Agent 一处一处删，面板按快照逐行核对，删不干净不关报告。':
    'Snapshots were taken before adding: when you stop fixing, at wrap-up, or on "Remove", the Agent deletes them one by one and the panel checks line by line against the snapshot; the report stays open until they are fully removed.',
  在加: 'Adding',
  刚加好: 'Just added',
  没按规则加: 'Not added by the rules',
  在撤: 'Removing',
  已撤掉: 'Removed',
  没撤干净: 'Not fully removed',
  // 记录
  补排查记录: 'Probe history',
  '复现：第 {a}–{b} 行': 'Repro: lines {a}–{b}',
  一处都没打出来: 'Nothing printed',
  '复现一次，把日志交给它：报告上有「复现完了，取日志」就点它，没有就把日志贴进来':
    'Reproduce once and hand over the log: click "Done reproducing, fetch log" in the report if it is there, otherwise paste the log',
  '补排查加的 {ids} 一起删：Agent 一处一处删，面板按加之前的快照逐行核对，有残留、多删、多出空行都退回给它。':
    'Probes {ids} are removed too: the Agent deletes them one by one, the panel checks line by line against the snapshot, and anything left over, over-deleted or extra blank lines go back to it.',
  // 服务端
  '只有走诊断报告的 Bug 才能补排查': 'Only bugs going through a diagnosis report can take probes',
  '它还没交诊断报告：等报告出来再补排查': 'No diagnosis report yet: add probes once the report is in',
  '这份报告已经关了（不修了），不能再补排查': 'This report is closed (not fixing), probes can no longer be added',
  '它正在回复，等这一轮结束再补排查': 'It is replying; add the probe after this turn ends',
  '上一次补排查还没结束，等它这一轮做完': 'The previous probe is still in progress; wait for this turn to finish',
  这一条现在不用改: 'This one does not need fixing now',
  没有能撤的临时代码: 'No temporary code to remove',
  找不到对话的工作目录: "Can't find the conversation's working folder",
}
