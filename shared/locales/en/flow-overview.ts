/** 英文词典的一部分，键是中文原文：对话总览页的「流程」视图（FlowOverview.tsx，扩展 4） */
export const EN_FLOW_OVERVIEW: Record<string, string> = {
  // 页头
  流程: 'Flow',
  '项目里所有对话（含子对话）的流程数据：面板推了几次、评审退回、合回失败、等你多久，按角色分开看。':
    'Flow data for every project conversation (sub-conversations included): how often the panel nudged it, review rejections, failed merges and time spent waiting on you, broken down by role.',
  '还没有项目里的对话。在项目里发起对话后，面板推进、评审、合回的数字会汇总在这里。':
    'No project conversations yet. Once you start one in a project, nudges, reviews and merges are summed up here.',

  // 顶上的数字
  对话: 'Conversations',
  '顶层 {tops} · 子对话 {children}': '{tops} top-level · {children} sub',
  平均推进次数: 'Avg. nudges',
  '面板推它「接着做」的次数，一共 {n} 次': 'Times the panel told it to keep going, {n} in total',
  '一共 {n} 次': '{n} in total',
  评审退回: 'Review rejections',
  '{n} 个对话被退回过：节点验收不通过重做，或派出的评审、测试给了不通过':
    '{n} conversation(s) were sent back: a node failed acceptance and was redone, or a dispatched review or test failed',
  '{n} 个对话被退回过': '{n} conversation(s) sent back',
  一次合回: 'Merged first try',
  '合回了 {merged} 个子对话，没能合回被退回 {fails} 次':
    '{merged} sub-conversation(s) merged back; {fails} merge(s) failed and were sent back',
  '合回失败 {n} 次': '{n} failed merge(s)',
  还没有合回的子对话: 'No merged sub-conversations yet',
  平均等你: 'Avg. wait on you',
  '{n} 个对话等过你确认或回答，只按它们平均':
    '{n} conversation(s) waited for your confirmation or answer; averaged over those only',
  '{n} 个对话等过你': '{n} conversation(s) waited on you',
  '一共 {turns} 轮，交代结束：做完 {done} · 卡住 {blocked}': '{turns} turns; ended as done {done} · blocked {blocked}',
  '（卡住占 {p}）': ' ({p} blocked)',
  'Token {tokens}，平均每个对话 {avg}': 'Tokens {tokens}, {avg} per conversation',

  // 按角色
  按角色: 'By role',
  '返工（评审退回 + 合回失败）多的排在前面': 'Most rework (review rejections + failed merges) first',
  角色: 'Role',
  推进: 'Nudges',
  退回: 'Rejected',
  合回失败: 'Merge fails',
  等你: 'Waited',
  已删除的角色: 'Deleted role',
  没选角色: 'No role',

  // 返工多的对话
  '推得多、返工多的对话': 'Most nudged and reworked',
  '改角色、提示词之前先看这些对话卡在哪': 'Check where these got stuck before changing roles or prompts',
  '推了 {n} 次': 'nudged {n}×',
  '退回 {n} 次': 'rejected {n}×',
  '等你 {time}': 'waited {time}',
}
