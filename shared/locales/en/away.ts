/** 英文词典的一部分，键是中文原文：「我不在」模式（shared/away.ts）和首页的等你处理、最近、示例任务 */
export const EN_AWAY: Record<string, string> = {
  我不在: "I'm away",
  '{time} 起开着': 'On since {time}',
  '开着时，能反悔的选择题按 Agent 推荐的选项自动选，对话里留一行、回来能改；不可逆的操作、诊断报告确认、要你去操作的事照旧等你。':
    "While on, reversible multiple-choice questions get the Agent's recommended option, with a note in the conversation you can revisit; irreversible operations, diagnosis report sign-off, and things you must do yourself still wait for you.",
  '自动选过的 {n} 项': 'Picked for you: {n}',
  全部知道了: 'Dismiss all',
  去改: 'Change',
  知道了: 'Dismiss',
  '你不在，面板按 Agent 推荐的选项替你选了「{picked}」。回来想改，直接在这里告诉它。':
    'You were away, so the panel picked the Agent\'s recommendation: "{picked}". To change it, just say so here.',
  '我不在时你问的「{question}」，面板替我选了「{picked}」。我改成：':
    'While I was away you asked "{question}" and the panel picked "{picked}" for me. I\'d like instead: ',
  '「我不在」开着': '"I\'m away" is on',
  '「我不在」开着 · 替你选了 {n} 项': '"I\'m away" is on · {n} picked for you',
  '等你处理 {n} 件': '{n} waiting on you',
  试试这些: 'Try one of these',
  了解这个项目: 'Get to know this project',
  '通读这个项目，讲清楚它是做什么的、目录怎么分、主要模块之间怎么调用，最后列出你觉得最需要注意的三个地方。':
    'Read through this project and explain what it does, how the folders are organized and how the main modules call each other, then list the three things you think need the most attention.',
  补上缺的测试: 'Fill in missing tests',
  '找出最重要、却还没有测试覆盖的几个函数，给它们补上单元测试并跑通。':
    'Find the most important functions that have no test coverage yet, add unit tests for them and make them pass.',
  照着文档跑一遍: 'Follow the docs end to end',
  '按 README 的快速开始从头跑一遍，哪一步跑不通或和文档对不上，就修好代码或改正文档。':
    "Run through the README's quick start from scratch; wherever a step fails or doesn't match the docs, fix the code or correct the docs.",
}
