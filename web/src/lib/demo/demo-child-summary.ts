/**
 * 演示：子对话自己的详细总结和面板在父对话里自动画出的卡片（shared/summary/card.ts）。
 * 子对话写 `## 类型｜结论` + 一段段 `### 段名`，照普通 Markdown 显示；父对话不再自己写卡，
 * 面板按子对话的总结自动画卡片（标题是「类型｜结论」，点标题在右栏打开子对话、滚到这份总结）
 */
import { childSummaryCards } from '@shared/summary/card'
import type { TaskTodo } from '@shared/schema'

/** 子对话的最后一条回复：按 summaryDetailRules 的「修复」段落写 */
export const demoChildSummary = () =>
  [
    '侧栏时间显示的问题修好了，改动已经合回 main。',
    '',
    '## 修复｜侧栏的「x 分钟前」不再停在打开页面那一刻',
    '',
    '### 问题',
    '侧栏每个对话后面的相对时间（「3 分钟前」）只在打开页面时算一次：页面开着不动，半小时后看还是「3 分钟前」；切到别的对话再切回来才会变。',
    '',
    '### 原因',
    '- 相对时间在 `web/src/components/Sidebar.tsx:212` 渲染时用 `Date.now()` 直接算，组件只在任务列表变了时才重画。',
    '- 列表 4 秒轮询一次，但没有新消息时返回同一份数据，React 跳过重画，时间就一直是第一次算的值。',
    '',
    '### 修改方案',
    '加一个全局的「分钟时钟」：每分钟整点通知一次，只有显示相对时间的那几个小组件订阅它重画。没有改成给整个侧栏加定时器，那样每分钟会把几百行对话全部重画一遍。',
    '',
    '### 改动明细',
    '- `web/src/lib/minute-clock.ts`（新）：按整分钟对齐的时钟，页面切到后台时停，回来立刻补一次。',
    '- `web/src/components/Sidebar.tsx`：相对时间抽成 `<Ago>` 小组件，订阅分钟时钟。',
    '- `web/src/lib/minute-clock.test.ts`：对齐整分钟、后台暂停两条用例。',
    '',
    '### 影响',
    '只影响侧栏和对话列表里的相对时间显示；其他地方的时间格式不变。每分钟只重画时间文字本身，滚动和输入不受影响。',
    '',
    '### 验证',
    '- 新增的两条单测改前失败、改后通过。',
    '- 演示页开着放 3 分钟，侧栏时间按分钟走。',
    '',
    '### 遗留',
    '无',
  ].join('\n')

/** 面板在父对话里自动画的卡片：由子对话的总结解析出来，和正式后端用的同一套 */
export const demoChildCards = (childId: string) => childSummaryCards(demoChildSummary(), childId)

/** Chat 页演示的待办：Chat 模式用 CLI 自带的待办（ADR 0038），显示在输入框上方 */
export const demoChatTodos = (): TaskTodo[] => [
  { text: '列出两边的命令行参数', status: 'done', agentId: '' },
  { text: '对照提问、计划和子 Agent 能力', status: 'running', agentId: '' },
  { text: '整理成表格', status: 'pending', agentId: '' },
]
