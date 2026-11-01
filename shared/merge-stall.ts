/**
 * 子对话停在「只剩合回、没请父对话收尾」时面板怎么推（server/tasks/children.ts 的 nudgeMerge、reportChild 读这里）。
 * 判定写成纯函数放这里，服务端只拿结论执行，测试不用搭整套任务作用域
 */
import type { Task } from './schema.ts'

/**
 * 子对话这一轮已经说完、能提醒它请父对话收尾了（server/tasks/children.ts 的 nudgeMerge 读它）：
 * CLI 不在处理这一轮，进程退出了（done），或者还挂着（running：保活等下一句、刚报完 result）。
 * 不能只认 done：Claude Code 这类保活的 CLI 一轮结束后进程还在等下一句，status 一直是 running，
 * 只认 done 时「催它 submit_merge」永远发不出去，子对话停在合回前没人推（实测报告问题 2）。
 * 失败、被停下的不算：那是出错或用户叫停，要让用户看到再决定
 */
export const turnSettled = (tk: Pick<Task, 'status' | 'working'>) =>
  !tk.working && (tk.status === 'done' || tk.status === 'running')

/**
 * 子对话只剩合回、又没请父对话收尾就停下：每停一次（按这一轮的结束时间算，同一轮只记一次）都告诉父对话，
 * 带上第几次。只按计划进度去重的话，父对话交回一次、它再停在同一处时状态和上次一模一样，
 * 这次上报被当成重复吞掉，父子两边都停在等下一句（实测报告问题 2）。
 * 最多报 MERGE_STALL_REPORTS 次：每次上报都会叫起父对话，它再交回子对话，不封顶就是两边一直互相催
 */
export const MERGE_STALL_REPORTS = 3
export interface MergeStall {
  /** 计划进度（计划 id + 已完成几步）：进度变了重新数 */
  key: string
  /** 记过的那一轮的结束时间 */
  turn: string
  n: number
}
export function nextMergeStall(prev: MergeStall | undefined, key: string, turn: string): MergeStall {
  if (!prev || prev.key !== key) return { key, turn, n: 1 }
  if (prev.turn === turn) return prev
  return { key, turn, n: prev.n + 1 }
}
