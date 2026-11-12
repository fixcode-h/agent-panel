/**
 * p4 / svn 跑一条命令，拿原始字节（文件内容）、失败时抛错带命令自己的说明（git 走 server/exec/git.ts）。
 * 评审的二进制语义差异（review-semantic.ts）取 p4 的 have 版本用它；表格插件的版本记录、提交也用这一份（开放模块）
 */
import { execFile } from 'node:child_process'
import { childEnv } from './process.ts'

/** 旧版本的文件最大读这么多（和表格打开文件的上限一致） */
export const VCS_MAX_BYTES = 64 * 1024 * 1024

export function vcsRun(cmd: 'p4' | 'svn', args: string[], cwd: string) {
  return new Promise<Buffer>((resolve, reject) =>
    execFile(
      cmd,
      args,
      {
        cwd,
        env: { ...childEnv([]), PWD: cwd },
        encoding: 'buffer',
        maxBuffer: VCS_MAX_BYTES,
        timeout: 60_000,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err) {
          const why =
            Buffer.from(stderr ?? '')
              .toString('utf8')
              .trim() || err.message
          return reject(new Error(`${cmd} ${args[0]}：${why}`))
        }
        resolve(stdout)
      },
    ),
  )
}
