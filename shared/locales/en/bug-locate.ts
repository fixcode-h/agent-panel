/** 英文词典的一部分，键是中文原文：诊断报告取消修复后删临时日志、报告里的原文定位（代码 / 日志原文、高亮） */
export const EN_BUG_LOCATE: Record<string, string> = {
  // 取消修复：确认框
  '正在查代码里的临时日志…': 'Looking for temporary logs in the code…',
  '这份诊断报告不再等你确认。代码里还有 {k} 处 [排查-…] 临时日志，确认后它会一处一处删掉（连加日志时带进来的空行），面板核对干净后才关闭报告；之后不会再改别的文件。真要修就在父对话里重新报这个 Bug。':
    'This diagnosis report will stop waiting for your confirmation. The code still has {k} [排查-…] temporary log line(s); after you confirm, it removes them one by one (including blank lines added with them), and the report closes once the panel verifies the code is clean. No other files will be changed. To fix it later, report the bug again from the parent conversation.',
  '这份诊断报告就此关闭：代码里没有临时日志，计划标记为完成，之后不会再改文件，这个对话也不能再交新的报告（真要修就在父对话里重新报这个 Bug）。':
    'This diagnosis report will be closed: there are no temporary logs in the code, the plan is marked done, no more files will be changed, and this conversation cannot submit a new report (to fix it later, report the bug again from the parent conversation).',
  要删的临时日志: 'Temporary logs to remove',
  '这些日志加在它的独立分支里。你照复现步骤在自己的工作区里加过同样几行的话，记得自己删掉。':
    'These logs were added in its own isolated branch. If you added the same lines in your own workspace while reproducing, remember to remove them yourself.',
  '为排查新建的文件（默认保留，勾上一起删）':
    'Files created for the investigation (kept by default; check to delete them too)',
  修复也撤掉: 'Undo the fix too',
  '改动就在你的工作区里：勾上后它把方案里的改动也改回去，文件回到加日志之前的样子':
    'The changes are in your workspace: when checked, it also reverts the plan changes so files match how they were before the logs were added',
  // 取消修复：进度
  '正在删 {k} 处临时日志，删完面板核对干净后关闭报告':
    'Removing {k} temporary log line(s); the report closes once the panel verifies the code is clean',
  '临时日志已删干净（{k} 处），报告已关闭': 'Temporary logs removed ({k}); report closed',
  '临时日志没删干净：{text}': 'Temporary logs not fully removed: {text}',
  '你选了不让它再删，报告已关闭': 'You chose not to let it retry; report closed',
  '我自己处理，关闭报告': "I'll handle it; close the report",
  让它再删一次: 'Let it try again',
  '已取消，在删临时日志': 'Cancelled, removing temporary logs',
  '已取消，日志没删干净': 'Cancelled, logs not fully removed',
  '你取消了这次修复：它在删临时日志，删干净后关闭报告':
    'You cancelled this fix: it is removing the temporary logs; the report closes once they are gone',
  '你取消了这次修复，临时日志没删干净：选让它再删一次，或者自己处理':
    'You cancelled this fix, but the temporary logs were not fully removed: let it try again, or handle it yourself',
  在删临时日志: 'Removing temporary logs',
  日志没删干净: 'Logs not fully removed',
  '你取消了诊断报告第 {n} 版，这次不修了：它先删掉 {k} 处临时日志，面板核对干净后关闭报告':
    'You cancelled diagnosis report version {n} and won’t fix it this time: it first removes {k} temporary log line(s), and the report closes once the panel verifies the code is clean',
  '临时日志已删干净（{k} 处），诊断报告第 {n} 版已关闭':
    'Temporary logs removed ({k}); diagnosis report version {n} closed',
  '你选了不让它再删，诊断报告第 {n} 版已关闭': 'You chose not to let it retry; diagnosis report version {n} closed',
  '还剩 {k} 处临时日志': '{k} temporary log line(s) left',
  '多了 {k} 个空行': '{k} extra blank line(s)',
  '多了 {k} 行别的改动': '{k} other extra line(s)',
  '删多了 {k} 行': '{k} line(s) removed too many',
  '要删的文件还在：{files}': 'Files to delete still exist: {files}',
  '用户取消了修复，临时日志已删干净，诊断报告已关闭（没有改代码）':
    'The user cancelled the fix; temporary logs were removed and the diagnosis report is closed (no code changed)',
  '用户取消了修复，诊断报告已关闭（没有改代码）':
    'The user cancelled the fix; the diagnosis report is closed (no code changed)',
  现在没有要处理的临时日志: 'There are no temporary logs to handle now',
  '它正在回复，等这一轮结束再处理': 'It is replying; wait for this turn to finish',
  // 原文定位：报告里的小节和表
  日志计划命中: 'Log plan hits',
  原文: 'Sources',
  期望和实际: 'Expected vs actual',
  出错点修前修后: 'Fault code before and after the fix',
  触发条件: 'Trigger condition',
  调用方: 'Caller',
  对照的正确写法: 'Correct version for comparison',
  临时日志: 'Temporary log',
  '描述（不是原文）': 'Description (not the original text)',
  '你贴的日志（报告 #{n}）第 {a}~{b} 行': 'Your logs (report #{n}), lines {a}–{b}',
  '日志 {file} 第 {a}~{b} 行': 'Log {file}, lines {a}–{b}',
  命令输出: 'Command output',
  '{n} 次': '{n} time(s)',
  '0 次': '0 times',
  '第 {n} 行': 'line {n}',
  出现: 'Seen',
  第一次: 'First seen',
  这次: 'This run',
  对上了: 'Matched',
  没对上: 'Not matched',
  '这次的日志一项都没对上：结果在预料之外，看看路标停在哪一步':
    'None of the outcomes matched these logs: the result is unexpected; check where the waypoint logs stop',
  什么: 'What',
  应该是: 'Expected',
  实际: 'Actual',
  '**推演**：这次复现用的是它构造的数据，只能说明「这样也能出现」，不能当作排除别的假设的证据':
    '**Inference**: this reproduction used data it constructed, which only shows that the result can happen this way; it cannot rule out other hypotheses',
  复现方式: 'Reproduced with',
  '用你的数据 / 环境': 'Your data / environment',
  测试用例: 'Test case',
  引入的那段改动: 'The change that introduced it',
}
