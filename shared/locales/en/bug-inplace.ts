/** 英文词典的一部分，键是中文原文：普通对话里发 /bug（shared/bug-in-place.ts）和偶发 Bug 的观察期（shared/bug-observe.ts） */
export const EN_BUG_INPLACE: Record<string, string> = {
  '对话正在回复，等这一轮结束或先停止，再发 /bug':
    'The conversation is replying. Wait for this turn to finish or stop it, then send /bug again',
  '这个对话里的 Bug 已经结束，新的 Bug 请新开一个对话发 /bug':
    'The bug in this conversation is closed. Start a new conversation and send /bug for a new one',
  '观察期里又报了同类问题「{title}」：这个 Bug 可能没修好，已自动关联，可以重开接着查':
    'A similar problem "{title}" was reported during the observation period: this bug may not be fixed. It has been linked automatically; you can reopen it and keep investigating',
  观察中: 'Observing',
  又出现了: 'Came back',
  '观察到 {date}': 'Observing until {date}',
  '又报了 {n} 次': 'Reported again {n}×',
}
