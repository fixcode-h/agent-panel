/** 英文词典的一部分，键是中文原文：改动卡片的「这一轮 / 整个对话」和本轮产出里的可浏览地址（Bug模式子对话体验 第 3、4 节） */
export const EN_TURN_SCOPE: Record<string, string> = {
  '这一轮改了 {n} 个文件': 'This turn changed {n} files',
  撤销这一轮: 'Undo this turn',
  '这一轮 = 你 {time} 说「{text}」之后到它停下；切到「整个对话」看全部 {n} 个文件':
    'This turn = from your "{text}" at {time} until it stopped; switch to "Whole chat" for all {n} files',
  改动卡片: 'Changes card',
  默认显示: 'Show by default',
  先列几个文件: 'Files shown at first',
  整个对话: 'Whole chat',
  已撤销这一轮的改动: 'Undid this turn’s changes',
  这一轮的改动已撤销: 'This turn’s changes were undone',
  这一轮没有改文件: 'No files changed this turn',
  撤销这一轮改的所有文件: 'Undo every file changed this turn',
  '撤销这一轮的改动？': 'Undo this turn’s changes?',
  '{n} 个文件会恢复成这一轮改之前的样子，这一轮新建的文件会被删除；更早几轮的改动、你或其他对话之后在这些文件里的改动会保留。改到同一处时不会撤销，会列出冲突。':
    '{n} files go back to how they were before this turn, and files created this turn are deleted. Changes from earlier turns, and later edits by you or other chats, are kept. Where the same spot was changed again, nothing is undone and the conflicts are listed.',
  '{n} 个可浏览的地址': '{n} browsable addresses',
  改动的范围: 'Range of changes',
  '这一轮 {n}': 'This turn {n}',
  '整个对话 {n}': 'Whole chat {n}',
  在右栏打开: 'Open in side panel',
  '你不是在本机打开的面板：这个地址指向跑面板的那台电脑，这里可能打不开':
    'You opened the panel from another machine: this address points to the computer running the panel and may not open here',
  这条命令还在跑: 'This command is still running',
  已重新运行: 'Started again',
  这一轮没有要撤销的改动: 'Nothing to undo this turn',
}
