/** 诊断报告的提问、补充出新一版和「对比上一份」（用户 2026-11-13 定） */
export const EN_BUG_ASK: Record<string, string> = {
  '提问 / 补充，出新一版': 'Ask / add info, get a new version',
  '不认同，推翻重查': 'Disagree, start over',
  '它认为证据不够会回到论证加日志（升一个大版本），否则逐条回答后再交':
    'If it agrees the evidence is thin it goes back to adding logs (a new major version); otherwise it answers each point and resubmits',
  '根因和修复方案一起确认，确认了它才开始改代码；有疑问或要补充先选中文字标注':
    'Approve the root cause and the fix together; it only starts changing code after that. Select text to add questions or extra info first',
  '把疑问和补充按编号交回：它逐条回应、重新评估后出新一版给你再看':
    'Sends your numbered questions and info back: it responds to each, re-evaluates, and gives you a new version to review',
  '把疑问和补充按编号交回：它逐条回应、重新评估后出新一版论证给你再看':
    'Sends your numbered questions and info back: it responds to each, re-evaluates, and gives you a new evidence version to review',
  '同意根因它就开始设计修复方案；有疑问或要补充就选中文字标注，觉得根因不对点「不认同」':
    'Agree and it starts designing the fix. Select text to add questions or extra info; click "Disagree" if the root cause looks wrong',
  '不是否定根因：它逐条回应疑问、把补充当新证据重新评估，出新一版给你再看；觉得根因不对点「不认同」':
    'This does not reject the root cause: it answers your questions, re-evaluates with your extra info as new evidence, and gives you a new version. Click "Disagree" if the root cause looks wrong',
  '方案没问题就确认，它才会开始改代码；有疑问或要补充先选中文字标注':
    'Approve if the plan looks right; it only starts changing code after that. Select text to add questions or extra info first',
  '把疑问、改方案和补充按编号交回：它逐条回应、改好后出新一版给你再看':
    'Sends your numbered questions, plan changes and info back: it responds to each and gives you a new version to review',
  看报告还是对比: 'Report or comparison',
  对比上一份: 'Compare with previous',
  '先标注哪里不认同，或写整体意见': 'Annotate what you disagree with, or write an overall comment first',
  '还有没交回的标注：确认后它就不再回应这些标注':
    'Some notes have not been sent back: approving means it will not respond to them',
  '按你的提问和补充重出，对比第 {v} 版': 'Redone from your questions and info; compared with version {v}',
  '按你的不认同重出，对比第 {v} 版': 'Redone after you disagreed; compared with version {v}',
  结论已改: 'Conclusion changed',
  结论没变: 'Conclusion unchanged',
  '第 {a} 版 → 第 {b} 版': 'Version {a} → version {b}',
  '回应了你的 {k}/{n} 条标注': 'Responded to {k}/{n} of your notes',
  '它说改了：{text}': 'It says it changed: {text}',
  未改: 'Unchanged',
  已更新: 'Updated',
  新加: 'New',
  去掉了: 'Removed',
  '（开头）': '(Intro)',
  和上一份相比没有改动: 'No changes since the previous one',
  '{n} 节未改：{names}': '{n} sections unchanged: {names}',
  已用上: 'Used',
  '你不认同第 {n} 版的{phase}，要它推翻重查':
    'You disagreed with the {phase} of version {n} and asked it to start over',
  '{k} 个问题': '{k} question(s)',
  '{k} 条补充': '{k} piece(s) of extra info',
  '你对第 {n} 版的{phase}提了{what}，要它据此出新一版':
    'You raised {what} on the {phase} of version {n} and asked for a new version',
}
