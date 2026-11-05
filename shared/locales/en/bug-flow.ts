/** 英文词典的一部分，键是中文原文：Bug 报告按阶段走（论证、根因、修复方案、验证）的弹窗和报告小节 */
export const EN_BUG_FLOW: Record<string, string> = {
  // 弹窗状态和版本
  '你提了意见，它在接着分析': 'You raised points; it is analysing further',
  你已同意: 'You agreed',
  '你给了日志，它在分析': 'You provided logs; it is analysing them',
  '第 {n} 版 · {phase}': 'Version {n} · {phase}',
  '日志已加好，等你复现': 'Logs added; waiting for you to reproduce',
  论证: 'Evidence',
  // 按阶段的按钮和提示
  有疑问: 'Ask a question',
  '「有疑问」把标注交回，它先回答再接着论证':
    '"Ask a question" sends your notes back; it answers them before continuing',
  '交日志，继续分析': 'Submit logs, keep analysing',
  '按报告里的步骤复现，把日志贴在右下角或引入日志文件、截图，它接着分析':
    'Reproduce with the steps in the report, paste the logs at the bottom right or add log files or screenshots, and it carries on',
  '把复现得到的日志贴在这里，也可以粘贴或拖进日志文件':
    'Paste the logs from your reproduction here, or paste / drop log files',
  同意加日志: 'Allow adding logs',
  '继续分析，出下一版': 'Keep analysing, next version',
  '同意后它只在日志计划里的文件加临时日志，不改逻辑；手上已有日志可以贴在右下角直接交':
    'Once allowed it only adds temporary logs to the files in the log plan, no logic changes. Already have logs? Paste them at the bottom right and submit',
  '「继续分析」把标注按编号交回，它逐条回答后交下一版':
    '"Keep analysing" sends your numbered notes back; it answers each and submits the next version',
  '我有日志，直接分析': 'I have logs, analyse them',
  '不用它加日志：直接分析你贴的日志': 'Skip adding logs: analyse the logs you pasted',
  '整体意见（可选）；手上已有日志可以贴在这里，或粘贴、拖进日志文件':
    'Overall comment (optional); paste logs you already have here, or paste / drop log files',
  同意根因: 'Agree with root cause',
  '否决，再分析': 'Reject, analyse again',
  '同意根因它就开始设计修复方案；觉得不对就选中文字标出疑问或补充，再点「否决」':
    'Agree and it starts designing the fix; if it looks wrong, select text to add questions or facts, then click "Reject"',
  '「否决」把疑问和补充交回：它认为证据不够会回到论证加日志，否则逐条回答交新一版':
    '"Reject" sends your points back: if it agrees the evidence is thin it goes back to adding logs, otherwise it answers each point in a new version',
  '有疑问，出下一版': 'Question it, next version',
  '方案没问题就确认，它才会开始改代码；有疑问先选中文字标注':
    'Approve if the plan looks right; it only starts changing code after that. Select text to annotate questions',
  '「有疑问」把标注按编号交回，它逐条回答后交下一版':
    '"Question it" sends your numbered notes back; it answers each and submits the next version',
  '结束，跳过验证': 'Finish, skip verification',
  还有问题: 'Still broken',
  '「还有问题」把标注交回：它会回到论证或重新出方案':
    '"Still broken" sends your notes back: it goes back to evidence or proposes a new plan',
  '交日志，确认修好': 'Submit logs, confirm the fix',
  '按报告里的步骤复现，把日志贴在右下角或引入文件、截图；不想验证就点「结束」，它删掉临时日志后收尾':
    'Reproduce with the steps in the report and paste the logs at the bottom right or add files or screenshots; to skip verification click "Finish" and it removes the temporary logs and wraps up',
  '把验证时的日志贴在这里，也可以粘贴或拖进日志文件':
    'Paste the logs from verification here, or paste / drop log files',
  '你的决定已经记下，但没能交给子对话：{error}':
    "Decision saved, but couldn't deliver it to the sub-conversation: {error}",
  '不再等你确认，这一轮就此结束，计划标记为完成，之后不会再改文件。已经加进代码的 [排查-…] 临时日志不会自动删，要删就在这个对话里跟它说。':
    'Stop waiting for your confirmation: this round ends here and the plan is marked done; no more files will be changed. [排查-…] temporary logs already added to the code are not removed automatically; ask it in this conversation if you want them removed.',
  // 阶段条
  '论证 · 第 {n} 轮 · 等你复现': 'Evidence · round {n} · waiting for you to reproduce',
  '论证 · 第 {n} 轮': 'Evidence · round {n}',
  排查阶段: 'Investigation stage',
  拖动调整标注栏宽度: 'Drag to resize the notes column',
  // 引入日志文件
  日志文件: 'Log files',
  '先在整体意见里贴日志，或引入日志文件': 'Paste logs into the overall comment first, or add log files',
  '还有没处理的疑问：确认后它就不再回答这些标注':
    'Some questions are still open: approving means it will not answer those notes',
  // 对话里的工具行
  交论证: 'Submit evidence plan',
  交根因: 'Submit root cause',
  交修复方案: 'Submit fix plan',
  请你验证: 'Asks you to verify',
  请你复现: 'Asks you to reproduce',
  // 报告的结论和小节
  你取消了这次修复: 'You cancelled this fix',
  '这一版已作废，看最新一版': 'This version is superseded; see the latest',
  '你给了验证结果，它在分析': 'You provided verification results; it is analysing them',
  '你同意了，它在加日志': 'You agreed; it is adding logs',
  '你同意了根因，它在设计修复方案': 'You agreed with the root cause; it is designing the fix',
  '你确认了方案，它在修': 'You approved the plan; it is fixing',
  '你结束了验证，它在收尾': 'You finished verification; it is wrapping up',
  '日志已经加好：按下面的步骤复现，把日志贴回来':
    'Logs are in place: reproduce with the steps below and paste the logs back',
  '同意后它按日志计划加临时日志；你手上已有日志也可以直接贴':
    'Once allowed it adds temporary logs per the log plan; if you already have logs, paste them directly',
  '同意根因它就开始设计修复方案；不同意就标出疑问或补充':
    'Agree and it starts designing the fix; otherwise mark your questions or facts',
  确认方案它才开始改代码: 'It only starts changing code once you approve the plan',
  '快速级别：根因和修复方案一起确认，确认了它才开始改代码':
    'Quick level: approve the root cause and the fix together; it only starts changing code after that',
  '你同意了根因和方案，它在修': 'You agreed with the root cause and the plan; it is fixing',
  同意根因并按这个修: 'Agree and fix it this way',
  '根因和修复方案一起确认，确认了它才开始改代码；根因或方案有疑问先选中文字标注':
    'Approve the root cause and the fix together; it only starts changing code after that. Select text to annotate questions about either',
  '修复方案草案（这一版不确认，同意根因后另交一版）':
    'Draft fix (not approved in this version; it submits the plan separately after you agree with the root cause)',
  '已经修好：按下面的步骤复现验证，把日志贴回来；不想验证可以直接结束':
    'Fixed: reproduce with the steps below and paste the logs back; or finish without verifying',
  怎么复现: 'How to reproduce',
  '日志在：{where}': 'Logs are in: {where}',
  '过滤：`{filter}`': 'Filter: `{filter}`',
  看到什么算修好了: 'What counts as fixed',
  每种结果说明什么: 'What each outcome means',
  编号: 'ID',
  打什么: 'What it prints',
  区分哪个假设: 'Hypothesis it tells apart',
  加好的日志: 'Logs added',
  改前: 'Before',
  改后: 'After',
  回归测试: 'Regression tests',
  等你复现: 'Waiting for you to reproduce',
  日志计划: 'Log plan',
  修复结果: 'Fix results',
  改动的文件: 'Changed files',
  你贴的日志: 'Logs you provided',
  等你验证: 'Waiting for you to verify',
  // 对话里的记录
  '你给了第 {n} 版的验证结果，交给它分析':
    'You provided verification results for version {n}; handed over for analysis',
  '你给了第 {n} 版要的日志，交给它分析': 'You provided the logs version {n} asked for; handed over for analysis',
  '你对第 {n} 版提了 {k} 条意见，要它接着分析': 'You raised {k} points on version {n} and asked it to keep analysing',
  '你同意了第 {n} 版的日志计划': 'You allowed the log plan in version {n}',
  '你同意了第 {n} 版的根因': 'You agreed with the root cause in version {n}',
  '你确认了第 {n} 版的修复方案': 'You approved the fix plan in version {n}',
  '你结束了第 {n} 版的验证': 'You finished verification for version {n}',
  这一版不需要日志: 'This version does not need logs',
  先贴日志或引入日志文件: 'Paste logs or add log files first',
  '共 {n} 版': '{n} versions',
  你结束了验证: 'You finished verification',
  '{label}（最新）': '{label} (latest)',
  正在写: 'Writing',
  内容较长时要写一会儿: 'Long content takes a while to write',
  函数: 'Function',
  做了什么: 'What it does',
  怎么解释: 'Explanation',
  结果: 'Result',
  跑了几次: 'Runs',
  位置和调用路径: 'Location and call path',
}
