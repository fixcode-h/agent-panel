/** Bug 流程的确认收放（分析稿 B2）、面板复核回归测试（B9）、直接修的简版报告 */
export const EN_BUG_AUTO: Record<string, string> = {
  自动通过: 'Auto-approved',
  '面板自动通过（没有要注意的）': 'Auto-approved by the panel (nothing to watch out for)',
  '确认修复，验证也算通过': 'Approve fix (counts as verified)',
  '面板自己跑过回归测试：改前失败、改后通过。确认后它跑完影响面验证就收尾，不再单独请你验证':
    'The panel ran the regression tests itself: failed before, passed after. Once you approve, it checks the impact areas and wraps up without asking you to verify separately',
  后面几步没有要注意的就自动通过: 'Auto-approve later steps with nothing to watch out for',
  '之后交上来的根因、修复方案、修复，决策卡上没有「要注意」的由面板直接通过，报告随时能打开回看；有「要注意」的、要你复现验证的照常停下等你':
    'Later root causes, fix plans and fixes with no "Watch out" items on the decision card are approved by the panel; you can open the report any time. Steps with "Watch out" items, or that need you to reproduce and verify, still wait for you',
  '结论是不用改代码，要你看一眼': 'The conclusion is "no code change needed"; please take a look',
  这一版推翻了之前的结论: 'This version overturns an earlier conclusion',
  面板复核回归测试没通过: "The panel's regression test recheck failed",
  面板没能复核全部回归测试: 'The panel could not recheck all regression tests',
  '有要注意的：{text}': 'Has items to watch out for: {text}',
  修复和验证: 'fix and verification',
  '第 {n} 版的{what}没有要注意的，按你的设置面板自动通过了':
    'Version {n} ({what}) had nothing to watch out for, so the panel auto-approved it per your setting',
  '面板复核过回归测试，验证和修复一起通过了，它在收尾':
    'The panel rechecked the regression tests; fix and verification passed together. Wrapping up',
  '面板复核过回归测试（改前失败、改后通过）：看下面改了哪些代码、为什么这么改，没问题就确认，验证一起算通过；对哪几行有疑问就选中标注':
    'The panel rechecked the regression tests (failed before, passed after). Review the changed code and the reasons below; approving also counts as verified. Select lines to annotate any doubts',
  面板自动通过: 'Auto-approved',
  '第 {n} 版没有自动通过：{why}': 'Version {n} was not auto-approved: {why}',
  '你确认了第 {n} 版的修复，面板复核过回归测试，验证一起通过':
    'You approved the fix in version {n}; the panel rechecked the regression tests, so verification passed too',
  '修复简报：{cause}': 'Fix brief: {cause}',
  改了什么: 'What changed',
  改了的文件: 'Changed files',
  怎么验证的: 'How it was verified',
  '直接修的 Bug 不用你确认，这份简报只留作回看。':
    "Direct fixes don't need your approval; this brief is kept for review.",
  面板复核通过: 'Panel recheck passed',
  面板复核没通过: 'Panel recheck failed',
  面板复核中: 'Panel rechecking',
  面板只复核了一部分: 'Panel rechecked only partly',
  面板没有复核: 'Not rechecked by the panel',
  '{s} 还没跑完，面板停了它': 'Still running after {s}; the panel stopped it',
  没有退出码: 'no exit code',
  '退出码 {n}': 'exit code {n}',
  面板复核回归测试: 'Panel recheck of regression tests',
  '面板没有复核：档案里没写能直接跑的回归测试命令（result.commands），上面的测试结果是它自己说的。':
    'Not rechecked by the panel: the case file has no runnable regression test command (result.commands); the test results above are self-reported.',
  '这一轮结束后面板会跑：{cmds}': 'The panel will run these when this turn ends: {cmds}',
  '面板没有复核：这一版交上来时没有跑。':
    'Not rechecked by the panel: nothing was run when this version was submitted.',
  '面板正在改前和现在的代码上各跑一次：{cmds}':
    'The panel is running these once on the code before the fix and once on the current code: {cmds}',
  '面板自己跑过：每条都是改前失败、改后通过。': 'The panel ran them itself: each one failed before and passes after.',
  '面板跑出来和「改前失败、改后通过」对不上，看下面的输出。':
    'What the panel ran does not match "failed before, passed after". See the output below.',
  '有的命令面板没能复核，下面照实写了原因。': 'Some commands could not be rechecked; the reasons are listed below.',
  '第 {n} 条': 'Command {n}',
  改前的输出: 'Output before the fix',
  改后的输出: 'Output after the fix',
  '改前（应当失败）': 'Before (should fail)',
  '改后（应当通过）': 'After (should pass)',
  '改前是对话开始时的代码加上现在的测试文件，改后是现在的代码；只看退出码。':
    '"Before" is the code from when the conversation started plus the current test files; "after" is the current code. Only exit codes count.',
  '命令没跑起来：{e}': 'The command did not start: {e}',
  '对话开始时没有记下提交（不是 Git 仓库？），取不到改前的代码':
    'No commit was recorded when the conversation started (not a Git repository?), so the code before the fix is unavailable',
  '找不到对话开始时的提交 {ref}，取不到改前的代码':
    'Commit {ref} from when the conversation started was not found, so the code before the fix is unavailable',
  '开改前的临时工作区失败：{e}': 'Failed to create the temporary workspace for the code before the fix: {e}',
  '这条命令没在对话里跑过，面板不替它跑':
    'This command was never run in the conversation, so the panel will not run it',
  找不到对话的工作目录: "Can't find the conversation's working directory",
  '复核出错：{e}': 'Recheck error: {e}',
}
