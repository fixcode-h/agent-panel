/**
 * p4 / svn 跑一条命令，拿原始字节（文件内容）、失败时抛错带命令自己的说明（git 走 server/exec/git.ts）。
 * 评审的二进制语义差异（review-semantic.ts）取 p4 的 have 版本用它；表格插件的版本记录、提交也用这一份（开放模块）。
 * 真正起进程的是版本管理服务的统一入口 server/vcs/run.ts（设 PWD、限流、计数），这里只是「失败就抛」的写法
 */
import { VCS_MAX_BYTES, vcsExec, vcsWhy } from '../vcs/run.ts'

export { VCS_MAX_BYTES }

export async function vcsRun(cmd: 'p4' | 'svn', args: string[], cwd: string) {
  const r = await vcsExec(cmd, args, cwd)
  if (!r.ok) throw new Error(vcsWhy(cmd, args, r))
  return r.stdout
}
