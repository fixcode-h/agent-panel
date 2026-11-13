/** 英文词典的一部分，键是中文原文：诊断报告的取证（排查补丁放到工作区 / 还原、面板自己取日志、自动采集的环境） */
export const EN_BUG_EVIDENCE: Record<string, string> = {
  // 排查补丁放到你的工作区
  '修复已经临时放到你的工作区（{k} 个文件）。试完点还原，面板把这几个文件写回放之前的样子并核对。':
    'The fix is temporarily in your workspace ({k} file(s)). When you are done trying it, restore: the panel writes these files back to how they were and verifies them.',
  '临时日志已经放到你的工作区（{k} 个文件）。复现完点还原，面板把这几个文件写回放之前的样子并核对。':
    'The temporary logs are in your workspace ({k} file(s)). After reproducing, restore: the panel writes these files back to how they were and verifies them.',
  '修复在它的独立分支里，你的工作区里还没有：可以先临时放过去试一下，试完还原。':
    'The fix is in its isolated branch, not in your workspace yet: you can put it there temporarily to try it, then restore.',
  '临时日志加在它的独立分支里，你的工作区里没有：放过去再复现，复现完还原。':
    'The temporary logs were added in its isolated branch, not in your workspace: put them there, reproduce, then restore.',
  从我的工作区还原: 'Restore my workspace',
  把修复临时放到工作区试一下: 'Try the fix in my workspace',
  放到我的工作区: 'Put in my workspace',
  '已还原：{k} 个文件和放之前一样。': 'Restored: {k} file(s) match how they were before.',
  '我自己改回去，不用再提醒': "I'll revert them myself, stop reminding me",
  '修复还临时放在你的工作区里（{k} 个文件）：先关掉这个确认框，点「从我的工作区还原」，再取消。':
    'The fix is still in your workspace ({k} file(s)): close this dialog, click "Restore my workspace", then cancel.',
  '临时日志还放在你的工作区里（{k} 个文件）：先关掉这个确认框，点「从我的工作区还原」，再取消。':
    'The temporary logs are still in your workspace ({k} file(s)): close this dialog, click "Restore my workspace", then cancel.',
  '补丁已经在你的工作区里了：先还原，再重新放':
    'The patch is already in your workspace: restore it first, then put it again',
  报告里没有写要放哪些文件: 'The report does not list which files to put',
  '找不到这个对话分支的起点，没法算出它改了什么':
    "Can't find where this conversation's branch started, so its changes can't be computed",
  '没能从独立分支取出改动：{error}': 'Could not get the changes from the isolated branch: {error}',
  '独立分支里这几个文件没有改动，没有可放的': 'These files have no changes in the isolated branch; nothing to put',
  '和你工作区里这几个文件现在的内容对不上，什么都没动。git 的说明：':
    "The patch doesn't match these files in your workspace, so nothing was changed. Git says:",
  '补丁没能放上去：': 'The patch could not be applied:',
  你的工作区里没有面板放的补丁: 'There is no panel patch in your workspace',
  '放了之后你又改过这些文件，面板不覆盖你的改动，什么都没动。把你的改动另存或撤掉后再点还原，或者自己删掉那几行 [排查-…] 日志：':
    'You changed these files after the patch was put in, so the panel did not overwrite your changes and nothing was changed. Save or undo your changes and restore again, or remove the [排查-…] log lines yourself:',
  '放之前的快照找不到了，没法自动还原：请自己把这些文件改回去':
    "The snapshot from before is missing, so it can't be restored automatically: please revert these files yourself",
  '这些文件写回后和快照不一致，请手工检查：':
    "These files don't match the snapshot after writing them back; please check:",
  找不到项目目录: "Can't find the project folder",
  '只有 Git 项目里开了独立分支的对话才能把改动放到你的工作区':
    'Only conversations with an isolated branch in a Git project can put changes in your workspace',
  '现在不是等你复现或验证的时候，没有要放的改动':
    'The report is not waiting for you to reproduce or verify, so there are no changes to put',
  '它正在回复，等这一轮结束再放': 'It is replying; wait until this turn ends',
  // 面板自己取日志
  重新开始复现: 'Restart reproducing',
  开始复现: 'Start reproducing',
  '先点「开始复现」，面板记下日志文件现在到哪了':
    'Click "Start reproducing" first so the panel records where the log file is now',
  '复现完了，取日志': 'Done, fetch the log',
  '这个文件现在还不存在：复现时生成的整个文件都算新增。复现完回来点「复现完了，取日志」。':
    'This file does not exist yet: the whole file created while reproducing counts as new. Come back and click "Done, fetch the log".',
  '已记下日志文件现在到哪了。按报告里的步骤复现，完了回来点「复现完了，取日志」。':
    'Recorded where the log file is now. Reproduce following the report, then come back and click "Done, fetch the log".',
  '从开始复现到现在，这个文件没有新增内容。': 'Nothing was added to this file since you started reproducing.',
  '日志文件比开始复现时还小（被清空或换了新文件），从第 1 行看。':
    'The log file is smaller than when you started (cleared or rotated), so read it from line 1.',
  '第 {from}–{to} 行': 'lines {from}–{to}',
  '第 {from} 行': 'line {from}',
  '{file} 从第 {from} 行往后看：这是复现期间新增的日志（{span}）。':
    '{file} read from line {from} on: this is the log added while reproducing ({span}). ',
  '其中带 {prefix}…] 的有 {n} 行。': '{n} of those line(s) contain {prefix}…].',
  '确认，读这个文件': 'Confirm, read this file',
  '报告里没有写日志文件的位置，请自己把日志贴进来':
    'The report does not say where the log file is; please paste the log yourself',
  '{path} 不在项目目录里，面板不读': '{path} is not inside the project folder; the panel will not read it',
  '{path} 指向项目目录外面的文件，面板不读':
    '{path} points to a file outside the project folder; the panel will not read it',
  '{path} 在项目目录和对话目录外面：这是报告里写的日志位置，你确认后面板才读它':
    '{path} is outside the project and conversation folders: it is the log location written in the report, and the panel reads it only after you confirm',
  '{path} 不是文件': '{path} is not a file',
  '还没有点「开始复现」：面板不知道从哪里开始算新增的日志':
    'You haven\'t clicked "Start reproducing", so the panel doesn\'t know where the new log starts',
  '日志文件的位置和开始复现时不一样了，请重新点「开始复现」':
    'The log file location changed since you started; click "Start reproducing" again',
  '找不到日志文件 {path}：确认复现时确实写了日志，或者自己把日志贴进来':
    "Can't find the log file {path}: make sure reproducing wrote the log, or paste the log yourself",
  日志文件: 'Log file',
  // 环境（面板自动采集）
  '环境（面板自动采集）': 'Environment (collected by the panel)',
  操作系统: 'Operating system',
  'CLI 和模型': 'CLI and model',
  依赖锁文件: 'Dependency lock file',
  '{file} 最近一次改动：{hash}《{title}》{date}': '{file} last changed in {hash} "{title}"{date}',
  提交号: 'Commit',
  作者: 'Author',
  '…还有 {n} 个文件': '…and {n} more file(s)',
  项: 'Item',
  '最近 {n} 次提交': 'Last {n} commit(s)',
  '交报告时没提交的改动（{n} 个文件）': 'Uncommitted changes when the report was submitted ({n} file(s))',
  '取自你的项目目录（不是它的独立分支），交第一份报告时采集。':
    'Taken from your project folder (not its isolated branch) when the first report was submitted.',
}
