/** 英文词典的一部分，键是中文原文：节点确认的阶段报告（submit_report，审阅弹窗的分区、决策勾选、版本） */
export const EN_STAGE_REPORT: Record<string, string> = {
  这一版你已确认: 'You approved this version',
  '这一版你改了决策，已交给 Agent 重出': 'You changed decisions in this version; sent back to the Agent to redo',
  '这一版你提了修改意见，已退回': 'You asked for changes to this version; sent back',
  '这一版你已确认，Agent 接着问下一轮': 'You approved this version; the Agent moved on to the next round',
  '这一版没有新问题，已自动通过': 'No new questions in this version, so it passed automatically',
  '没有新问题，自动通过': 'No new questions, passed automatically',
  '第 {n} 版 · 没交报告': 'Version {n} · no report submitted',
  '改了 {n} 项决策：点「确认」交给 Agent 按你的选择重出一版':
    'Changed {n} decision(s): "Approve" sends it back to the Agent to redo with your choices',
  '确认后 Agent 按报告接着做下一轮': 'After you approve, the Agent continues with the next round',
  '都按推荐：没有要改的地方就点「确认」继续': 'All as recommended: click "Approve" if nothing needs changing',
  '有标注时「确认」会把标注、意见和改了的决策一起交给 Agent 修改；标注全删掉再点才是确认通过':
    'While there are notes, "Approve" sends your notes, comments and changed decisions to the Agent to revise; delete all notes to really approve',
  已改: 'Changed',
  'Agent 推荐': 'Recommended',
  '推荐理由：{why}': 'Why: {why}',
  偏离原话: 'Differs from your words',
  '和你的原话不一致：{why}': 'Differs from what you said: {why}',
  '{n} 项 · 改了 {k} 项': '{n} items · {k} changed',
  需要你决定: 'Your decisions',
  我按规则定的: 'Decided by the Agent',
  不同意也可以改: 'You can still change these',
  '确认后接着：': 'Next after approval: ',
  方案详情: 'Plan details',
  过程记录: 'Work log',
  '（Agent 做这一步时说的话）': '(what the Agent said while working)',
  按你改的决策重出: 'Redone with your decisions',
  按你的修改意见重出: 'Redone with your feedback',
  确认上一轮后接着问: 'Next round after approval',
  '上一版你改了：{list}': 'Last version you changed: {list}',
  // 流程图节点详情里常驻的报告入口（StageReportBar）
  等你确认: 'Waiting for you',
  已确认: 'Approved',
  '改了决策，重出中': 'Decisions changed, redoing',
  已退回修改: 'Sent back for changes',
  '已确认，接着下一轮': 'Approved, next round',
  阶段报告: 'Stage report',
  '「{title}」的阶段报告': 'Stage report of "{title}"',
  '看第 {n} 版': 'View version {n}',
  查看报告: 'View report',
  '报告已经处理过了，只能查看；切版本看每一轮':
    'This report has been handled, view only; switch versions to see each round',
  '只能查看；要确认或修改，点确认卡片上的「查看结果」':
    'View only; to approve or revise, click "View result" on the confirmation card',
  '只能查看；要确认或修改，点报告栏上的「查看结果」':
    'View only; to approve or revise, click "View result" on the report bar',
  '待你决定：Agent 想问「{q}」。提问关着没有弹给你，流程照常往下走；收不回的事它先不做，会写进报告交给你定。':
    'For you to decide: the agent wanted to ask "{q}". Questions are off, so it was not shown to you and the workflow keeps going; anything that cannot be undone is left undone and goes into the report for you to decide.',
  '上一步没有选「{label}」的项，这一步不用做。':
    'Nothing was set to "{label}" in the previous step, so this step is skipped.',
  // 需求原话对照表（web/src/components/tasks/RunNeeds.tsx）
  需求对照: 'Requirements check',
  '{by} 拆出，还没有节点标记': 'Split out by {by}, not marked by any node yet',
  未落地: 'Not done',
  已落地: 'Done',
  延期: 'Deferred',
  不做: 'Dropped',
  '{n}/{total} 已落地': '{n}/{total} done',
  '{n} 条未落地': '{n} not done',
  '{n} 条延期': '{n} deferred',
  '{n} 条不做': '{n} dropped',
}
