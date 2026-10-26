/** 英文词典的一部分，键是中文原文 */
export const EN_SCHEDULE: Record<string, string> = {
  // 导航和页面
  计划: 'Plans',
  新建计划: 'New plan',
  编辑计划: 'Edit plan',
  '到点自动新建一个对话去执行。面板进程在跑时才会触发；面板关着期间错过的计划不会补跑，会在列表里标出来。':
    'Starts a new conversation at the scheduled time. Plans only run while the panel process is running; anything missed while it was off is not caught up and is marked in the list.',
  '还没有计划。点右上角「新建计划」，默认已经按「今日工作」填好。':
    'No plans yet. Click "New plan" in the top right — it is prefilled with the "Today\'s work" template.',

  // 列表
  待执行: 'Scheduled',
  已执行: 'Ran',
  已跳过: 'Skipped',
  单次: 'Once',
  每天: 'Daily',
  用角色执行: 'Runs with an agent role',
  '下次执行 {time}': 'Next run {time}',
  '上次执行 {time}': 'Last run {time}',
  没有执行过: 'Never ran',
  '已停用，不会执行': 'Disabled, will not run',
  '错过 {time}（面板没开着，不补跑）': 'Missed {time} (panel was off, not caught up)',
  '上次启动失败：{error}': 'Last run failed: {error}',
  打开这次执行: 'Open that run',
  立即执行: 'Run now',
  启用这条计划: 'Enable this plan',
  '删除计划「{name}」？': 'Delete plan "{name}"?',
  '删除后不会再执行，已经启动过的对话会留着。': 'It will not run again; conversations it already started are kept.',
  计划已删除: 'Plan deleted',
  计划已保存: 'Plan saved',
  计划已创建: 'Plan created',
  '这条计划刚执行过或已被改过，请重新打开再编辑': 'This plan has just run or been changed — reopen it to edit.',
  '已启动对话「{name}」': 'Started a conversation for "{name}"',
  '在线演示里不会真的启动对话，正式版会新建一个对话开始执行。':
    'The online demo does not really start a conversation; the desktop app creates one and runs it.',
  启动失败: 'Failed to start',

  // 表单
  '已按「今日工作」填好：每天 19:00 总结当天的工作，可以直接改。':
    'Prefilled with "Today\'s work": a daily summary at 19:00. Change anything you like.',
  名称: 'Name',
  '例如：今日工作': "e.g. Today's work",
  到点后执行的对话内容: 'What the conversation should do',
  '交给 Agent 的一句话目标，例如：总结今天做的工作':
    'One-line goal handed to the agent, e.g. summarize what I did today',
  在哪个项目里执行: 'Project to run in',
  '聊天（不属于项目）': 'Chat (no project)',
  用哪个角色: 'Agent role',
  '不用角色（跟随默认 CLI）': 'No role (follow the default CLI)',
  '{name}（已停用）': '{name} (disabled)',
  重复: 'Repeat',
  只执行一次: 'Once',
  执行时间: 'Run time',
  '时间按本机时区。每天的计划每次执行完自动推到第二天，只执行一次的执行完就停下。':
    'Times use the local time zone. Daily plans move to the next day after each run; one-off plans stop after running.',

  // 校验和接口错误
  请填写计划名称: 'Enter a plan name',
  请填写到点后要执行的对话内容: 'Enter what the conversation should do when the plan runs',
  请选择执行时间: 'Pick a time to run',
  计划不存在: 'Plan not found',
}
