/** 英文词典的一部分，键是中文原文 */
export const EN_SCHEDULE: Record<string, string> = {
  // 导航和页面
  计划: 'Plans',
  新建计划: 'New plan',
  编辑计划: 'Edit plan',
  '到点自动新建一个对话去执行。面板进程在跑时才会触发；面板关着期间错过的计划不会补跑，会在列表里标出来。':
    'Starts a new conversation at the scheduled time. Plans only run while the panel process is running; anything missed while it was off is not caught up and is grouped under "Needs attention".',
  '还没有计划。新建一条「今日工作」，每天 {time} 自动总结当天的工作。':
    'No plans yet. Create a "Today\'s work" plan to summarize the day automatically at {time} every day.',
  新建今日工作: "New today's work plan",

  // 分组和卡片
  即将执行: 'Upcoming',
  出过问题: 'Needs attention',
  不会再执行: 'Finished',
  单次: 'Once',
  每天: 'Daily',
  下次执行: 'Next run',
  不会再次执行: 'Will not run again',
  '跟随默认 CLI': 'Follow the default CLI',
  立即执行: 'Run now',
  打开这次执行: 'Open that run',

  // 下次执行时间的文案（shared/schedule.ts）
  今晚: 'tonight',
  今天: 'today',
  明天: 'tomorrow',
  后天: 'the day after tomorrow',
  昨天: 'yesterday',
  '{day} {time}': '{day} at {time}',
  已到点: 'due now',
  '不到 1 分钟后': 'in under a minute',
  '{n} 分钟后': 'in {n} min',
  '{n} 小时后': 'in {n} h',
  '{n} 天后': 'in {n} days',
  '{when}（{rel}）': '{when} ({rel})',

  // 最近一次结果
  启动失败: 'Failed to start',
  错过: 'Missed',
  已启动: 'Started',
  还没执行: 'Not run yet',
  '错过 {time}（面板当时没在跑，不补跑）': 'Missed {time} (the panel was not running; not caught up)',
  '成功启动于 {time}': 'Started at {time}',
  '上次启动失败：{error}': 'Last run failed: {error}',
  还没有执行过: 'Has not run yet',
  展开全文: 'Show all',

  // 删除与提示
  '删除计划「{name}」？': 'Delete plan "{name}"?',
  '删除后不会再执行，已经启动过的对话会留着。': 'It will not run again; conversations it already started are kept.',
  计划已删除: 'Plan deleted',
  计划已保存: 'Plan saved',
  计划已创建: 'Plan created',
  '这条计划刚执行过或已被改过，请重新打开再编辑': 'This plan has just run or been changed — reopen it to edit.',
  '已启动对话「{name}」': 'Started a conversation for "{name}"',
  '在线演示里不会真的启动对话，正式版会新建一个对话开始执行。':
    'The online demo does not really start a conversation; the desktop app creates one and runs it.',

  // 表单
  '已按「今日工作」填好：每天 {time} 总结当天的工作，可以直接改。':
    'Prefilled with "Today\'s work": a daily summary at {time}. Change anything you like.',
  '改完保存，计划按新的设置执行。': 'Save to apply the new settings from the next run.',
  '填入「今日工作」模板': 'Fill in the "Today\'s work" template',
  名称: 'Name',
  '例如：今日工作': "e.g. Today's work",
  执行时间: 'Run time',
  重复: 'Repeat',
  工作日: 'Workdays',
  每周哪几天: 'Which days of the week',
  用哪个角色: 'Agent role',
  '不用角色（跟随默认 CLI）': 'No role (follow the default CLI)',
  '{name}（已停用）': '{name} (disabled)',
  在哪个项目里执行: 'Project to run in',
  '聊天（不属于项目）': 'Chat (no project)',
  到点后执行的对话内容: 'What the conversation should do',
  '交给 Agent 的一句话目标，例如：总结今天做的工作':
    'One-line goal handed to the agent, e.g. summarize what I did today',
  '时间按本机时区。每天 / 每周 / 工作日的计划每次执行完自动推到下一次，只执行一次的执行完就停下。':
    'Times use the local time zone. Daily, weekly, and weekday plans move to their next run after each run; one-off plans stop after running.',

  // 校验和接口错误
  请填写计划名称: 'Enter a plan name',
  请填写到点后要执行的对话内容: 'Enter what the conversation should do when the plan runs',
  请选择执行时间: 'Pick a time to run',
  计划不存在: 'Plan not found',
}
