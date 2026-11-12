/** 英文词典的一部分，键是中文原文：对话状态的短词（shared/tasks/word.ts）和「状态」窗口最上面那一句（shared/life-next.ts） */
export const EN_STATE_WORD: Record<string, string> = {
  等你回答: 'Waiting for your answer',
  '{word}：{doing}': '{word}: {doing}',
  '{n} 个子对话等你回答': '{n} sub-chats waiting for your answer',
  '「{title}」{word}': '"{title}": {word}',
  去回答: 'Answer',
  去确认: 'Review',
  去对话: 'Open conversation',
  去回复: 'Reply',
  '已等 {d}': '{d} so far',
  '{d}前': '{d} ago',
  '在等工具跑完：{tool}': 'Waiting for a tool to finish: {tool}',
  '在等模型回复 · 已等 {d}': 'Waiting for the model · {d} so far',
  '在等子对话「{title}」': 'Waiting on sub-conversation "{title}"',
  在等父对话收尾: 'Waiting for the parent to wrap up',
  '计划还没做完，在等你说下一步': 'Plan not finished; waiting for your next instruction',
}
