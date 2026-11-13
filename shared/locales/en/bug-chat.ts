/** 诊断报告跟上对话：按对话更新、对话里确认、撤回（用户 2026-11-13 定，shared/bug/chat.ts） */
export const EN_BUG_CHAT: Record<string, string> = {
  '它按你在对话里说的更新了诊断报告：第 {n} 版{phase}，等你确认':
    'It updated the diagnosis report from what you said in the chat: version {n} {phase}, waiting for your review',
  '它按你在对话里说的更新了诊断报告：第 {n} 版{phase}，你在对话里确认过':
    'It updated the diagnosis report from what you said in the chat: version {n} {phase}, which you confirmed in the chat',
  '报告之后你没有在对话里说过话，不用更新':
    'You have not said anything in the chat since this report; nothing to update',
  '你请它按对话更新第 {n} 版诊断报告': 'You asked it to update diagnosis report version {n} from the chat',
  '这一版不是按对话确认的，或者后面已经交了新的一版':
    'This version was not confirmed in the chat, or a newer version has already been submitted',
  '你撤回了在对话里对第 {n} 版的确认，等你在报告上决定':
    'You withdrew the confirmation of version {n} given in the chat; it now waits for your decision on the report',
  你在对话里确认了: 'Confirmed by you in the chat',
  '{label} · 按对话': '{label} · from chat',
  '依据你在对话里说的（{k} 句）': 'Based on what you said in the chat ({k} messages)',
  '比第 {v} 版：结论已改': 'vs. version {v}: conclusion changed',
  '比第 {v} 版：结论没变': 'vs. version {v}: conclusion unchanged',
  '它把你最后一句当成了确认；理解错了就撤回，这一版回到等你确认':
    'It took your last message as a confirmation. If that is wrong, withdraw it and this version goes back to waiting for you',
  不是这个意思: 'That is not what I meant',
  '这份报告之后你在对话里说了 {n} 句，它还改了 {k} 个报告没覆盖的文件，报告可能没跟上。':
    'You said {n} messages in the chat after this report, and it changed {k} files the report does not cover. The report may be out of date.',
  '这份报告之后你在对话里说了 {n} 句，报告可能没跟上。':
    'You said {n} messages in the chat after this report. The report may be out of date.',
  让它按对话更新报告: 'Update the report from the chat',
  对话里确认: 'Confirmed in chat',
  '你在对话里同意了根因，它在设计修复方案': 'You agreed with the root cause in the chat; it is designing the fix',
  '你在对话里确认了方案，它在修': 'You confirmed the plan in the chat; it is fixing',
  '你在对话里确认了修复，它在验证': 'You confirmed the fix in the chat; it is verifying',
  '你在对话里结束了验证，它在收尾': 'You ended verification in the chat; it is wrapping up',
}
