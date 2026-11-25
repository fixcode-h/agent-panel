/** 英文词典的一部分，键是中文原文：运行区各行的「终止」按钮（后台命令、编译、子任务共用） */
export const EN_STOP_BUTTON: Record<string, string> = {
  正在终止: 'Stopping',
  终止后台命令: 'Stop background command',
  '终止这 {n} 条后台命令': 'Stop these {n} background commands',
  '已终止后台命令「{name}」，已告诉 Agent': 'Stopped background command "{name}" and told the agent',
  '已终止 {n} 条后台命令，已告诉 Agent': 'Stopped {n} background commands and told the agent',
  '终止：结束命令和它起的所有子进程，并告诉 Agent 这是你手动终止的':
    'Stop: ends the command and every process it started, and tells the agent you stopped it',
}
