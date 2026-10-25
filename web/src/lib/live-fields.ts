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
