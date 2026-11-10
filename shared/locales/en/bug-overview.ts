/** 英文词典的一部分，键是中文原文：对话总览页的 Bug 视图和顶上的流程数据（shared/bug-overview.ts、BugOverview.tsx） */
export const EN_BUG_OVERVIEW: Record<string, string> = {
  // 页头
  '所有用户报的 Bug 一页看：走到五步里的哪一步、现在等谁、停了多久。点一行打开那个对话。':
    'Every reported bug on one page: which of the five steps it is at, who it is waiting on, and for how long. Click a row to open that conversation.',
  '{n} 个 Bug 等你处理': '{n} bug(s) waiting on you',

  // 分组
  '报告等你确认、等你复现或验证，它问了问题，或者观察期里又出现了':
    'A report needs your confirmation, reproduction or verification, it asked a question, or it came back while under observation',
  '它在分析或在修，偶发的修好后在这里观察几天，暂时不用你管':
    'It is analysing or fixing, or an intermittent bug is under observation for a few days after the fix; nothing for you to do yet',
  '已经修好，或者你点了不修了': 'Fixed, or you chose not to fix it',
  '没有符合的 Bug': 'No matching bugs',
  '还没有用户报的 Bug。在对话里发 /bug 描述问题，它会按流程排查，进度列在这里。':
    'No reported bugs yet. Send /bug in a conversation and describe the problem; it follows the bug process and progress shows up here.',
  '还有 {n} 个更早结束的 Bug，在各自的父对话里找':
    '{n} more bug(s) ended earlier; find them in their parent conversations',

  // 现在等谁
  它在删临时日志: 'Removing temporary logs',
  已修好: 'Fixed',

  // 一行
  '{n} 天': '{n} d',
  '等了 {time}': 'Waiting {time}',
  '这一步 {time}': '{time} on this step',
  排查级别: 'Investigation level',
  '根因等级：{label}（{hint}）': 'Root-cause tier: {label} ({hint})',
  对根因的把握: 'Confidence in the root cause',
  '五步进度：现在在{phase}': 'Five-step progress: now at {phase}',
  '五步进度：五步都走完了': 'Five-step progress: all five steps done',

  // 流程数据
  'Bug 总数': 'Bugs',
  '在查 {open} · 修好 {fixed} · 不修 {cancelled}': '{open} open · {fixed} fixed · {cancelled} dropped',
  '在查 {open} · 修好 {fixed}': '{open} open · {fixed} fixed',
  一次修好: 'Fixed first time',
  '修好的 {fixed} 个里有 {n} 个': '{n} of {fixed} fixed',
  '没被否决、验证一次过、没回到论证': 'Never rejected, verified first time, never back to evidence',
  平均确认次数: 'Avg. confirmations',
  '每个 Bug 要你经手几次': 'Times you had to act per bug',
  平均论证轮数: 'Avg. evidence rounds',
  '加日志、复现、分析算一轮': 'Add logs, reproduce, analyse = one round',
  '每个 Bug 论证几轮': 'Evidence rounds per bug',
  '每个 Bug 经手几次': 'Your actions per bug',
  还没有修好的: 'None fixed yet',
  '各步平均停留：': 'Average time per step: ',
  '从立案到结束平均 {time}': '{time} on average from filing to close',
}
