/** 英文词典的一部分，键是中文原文：完成依据、对话自己的用量上限、用量速率提醒（分析稿 A3、A6） */
export const EN_DONE_GUARD: Record<string, string> = {
  // 完成依据卡片（web/src/components/tasks/DoneEvidenceCard.tsx）
  完成依据: 'Completion evidence',
  '改了 {f} 个文件 · 跑了 {c} 条验证命令': '{f} files changed · {c} verification commands run',
  '改了代码，但这一轮没跑过任何测试、类型检查或编译命令；它说做完了，面板没看到验证过':
    'Code was changed, but no test, type check or build command ran this turn; it says it is done, but the panel saw no verification',
  '退出码 0': 'Exit code 0',
  未报退出码: 'No exit code reported',
  '另有 {n} 个文件没列出': '{n} more files not listed',
  查看全部: 'View all',
  // 项目设置 · 测试步骤
  改了代码要跑过测试步骤才能结束: 'Require test steps after code changes before finishing',
  '对话用 end_turn 说做完了时，面板看这一轮的工具调用：改了代码却没跑过这里的测试步骤（没配步骤时看有没有跑测试、类型检查或编译），就不让它结束，并告诉它去跑。关着时不拦，只在「完成依据」卡片上标出来。':
    'When a conversation says it is done with end_turn, the panel checks this turn\'s tool calls: if code changed but none of these test steps ran (with no steps configured, any test, type check or build), it is not allowed to finish and is told to run them. When off, nothing is blocked; it is only flagged on the "Completion evidence" card.',
  // 新建对话的用量上限（web/src/components/tasks/ConvBudgetChip.tsx）
  这个对话的用量上限: 'Usage limit for this conversation',
  '这个对话的用量上限：{v}（连同名下子对话）':
    'Usage limit for this conversation: {v} (including its sub-conversations)',
  '给这个对话单独设用量上限（连同名下子对话）':
    'Set a usage limit just for this conversation (including its sub-conversations)',
  '{n}M token': '{n}M tokens',
  '连同名下子对话合起来算。设了就用这里的，不用项目设的（{v}）。80% 时提醒一次，用满时停下。':
    'Counts this conversation and its sub-conversations together. When set, it replaces the project limit ({v}). Warns once at 80% and stops when reached.',
  '连同名下子对话合起来算。80% 时提醒一次，用满时停下。留空表示不限。':
    'Counts this conversation and its sub-conversations together. Warns once at 80% and stops when reached. Leave empty for no limit.',
  '这个模型算不了费用，只有 token 上限生效': 'Cost cannot be calculated for this model; only the token limit applies',
  '（在「设置 · Agent」的模型里填了单价才按 token 折算）':
    '(fill in its price under Settings · Agent to convert tokens into cost)',
  // 用量提醒（shared/budget.ts、shared/budget-rate.ts）
  '【用量提醒】这个对话和名下子对话合起来已经用到这个对话设的上限的 {pct}%（{spent}）。到上限时面板会停下整个对话。':
    '[Usage warning] This conversation and its sub-conversations have used {pct}% of the limit set on this conversation ({spent}). The panel will stop the whole conversation when it is reached.',
  '【用量上限】这个对话和名下子对话合起来已经用到这个对话设的上限（{spent}），面板停下了整个对话。你再发消息时会接着跑一轮，跑完又会停下。':
    '[Usage limit] This conversation and its sub-conversations reached the limit set on this conversation ({spent}), so the panel stopped the whole conversation. Sending another message runs one more turn, then it stops again.',
  '【用量提醒】最近 {min} 分钟这个对话和名下子对话用了 {tokens} token，速率是它平均的 {x} 倍。面板没有停下它；看一下是不是在反复做同一件事，要限住可以停下它，或调低用量上限。':
    '[Usage warning] In the last {min} minutes this conversation and its sub-conversations used {tokens} tokens, {x}× its average rate. The panel has not stopped it; check whether it is repeating the same thing. To cap it, stop it or lower the usage limit.',
}
