import type { Task } from '@shared/schema'

/**
 * 运行时字段（还在跑的后台命令 jobs、还在运行的子对话数 childrenWorking、CLI 存活 cliAlive / childrenCli）只有列表、详情和推送接口带
 * （服务端的 withLive，没有也写成空数组 / 0）。停止、改名、标记已看这类接口顺手返回的任务不带：
 * 直接换上去，标题栏和侧栏的转圈会先消失、等下一次推送再出现（用户 2026-10-24 反馈「点开对话圈圈闪一下」）。
 * 新的一份没带这两个字段时沿用旧的那份
 */
export function keepLiveFields(prev: Task | undefined | null, next: Task): Task {
  if (!prev || prev.id !== next.id) return next
  const jobs = next.jobs === undefined ? prev.jobs : next.jobs
  const kids = next.childrenWorking === undefined ? prev.childrenWorking : next.childrenWorking
  // CLI 存活（cliAlive / childrenCli）同理：只有带运行时字段的那几份接口给，别的沿用
  const alive = next.cliAlive === undefined ? prev.cliAlive : next.cliAlive
  const kidsCli = next.childrenCli === undefined ? prev.childrenCli : next.childrenCli
  if (jobs === next.jobs && kids === next.childrenWorking && alive === next.cliAlive && kidsCli === next.childrenCli)
    return next
  return { ...next, jobs, childrenWorking: kids, cliAlive: alive, childrenCli: kidsCli }
}

/**
 * 只取到最后一段消息的长对话（打开时服务端按 OPEN_MESSAGE_LIMIT 截断）要换成列表摘要时，用来算摘要的那份任务：
 * 这一段里不一定有第一条用户消息，也不一定有最近那条（一条要求后面跟着几百条输出时）。
 * 只用列表里那份摘要的消息重算的话，摘要只留了第一条用户消息、算出来的「最近发言时间」退回到最早那条，
 * 侧栏按它排序，这个对话会往下掉一截、等列表刷新又跳回来（用户报的「来回点击排序闪一下」）。
 * 所以带上列表里的 askedAt，再并上这一段里的用户消息（打开期间刚发的那条也算）
 */
export function windowedForSummary<T extends Task>(page: T, listed: Task | undefined): T {
  return {
    ...page,
    askedAt: listed?.askedAt,
    messages: [...(listed?.messages ?? []), ...page.messages.filter((m) => m.role === 'user')],
  }
}
