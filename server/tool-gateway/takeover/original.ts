/**
 * 代答时面板照原样跑一遍原命令（ADR 0084 第二期）：结果要是「面板 + 原命令」的并集，原命令那份由面板自己跑出来，一字不改放进代答。
 * 只跑 shared/tool-gateway/search-args.ts 认得的那几种（参数一个个拆好、不经 shell，cmdlet 交给 PowerShell 跑原文），
 * 进程走面板的统一入口（server/exec/tracked.ts，登记进孤儿清理）。
 *
 * 跑不出来就返回 undefined，网关照原样放行：找不到程序、退出码不是 0 / 1（1 是「没找到」）、超时、输出太长、是二进制
 */
import type { SearchSpec } from '../../../shared/tool-gateway/search-args.ts'
import { ORIGINAL_MAX } from '../../../shared/tool-gateway/takeover.ts'
import { findCommand } from '../../exec/find-command.ts'
import { spawnTracked, stopTree } from '../../exec/tracked.ts'

/** 只收这么多字节：超了说明结果很多，代答塞不下，交给 CLI 自己跑 */
const MAX_BYTES = 256 * 1024

export async function runOriginal(
  run: NonNullable<SearchSpec['run']>,
  cwd: string,
  timeoutMs: number,
): Promise<string | undefined> {
  const how =
    'argv' in run
      ? { name: run.argv[0], args: run.argv.slice(1) }
      : {
          name: process.platform === 'win32' ? 'powershell' : 'pwsh',
          args: ['-NoProfile', '-NonInteractive', '-Command', run.powershell],
        }
  const found = await findCommand(how.name)
  // .cmd / .bat 要经 cmd 才起得来，参数就又要按 cmd 的规则转义一遍：拿不准，不跑
  if (!found || /\.(cmd|bat)$/i.test(found.path)) return undefined
  return new Promise((resolve) => {
    const child = spawnTracked(found.path, how.args, {
      cwd,
      source: 'tool-gateway',
      title: '查找接管：照原样跑原命令',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    const finish = (out: string | undefined) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (child.pid && child.exitCode === null) void stopTree(child.pid, { waitMs: 2000 })
      resolve(out)
    }
    const timer = setTimeout(() => finish(undefined), timeoutMs)
    child.stdout?.on('data', (b: Buffer) => {
      size += b.length
      if (size > MAX_BYTES) return finish(undefined)
      chunks.push(b)
    })
    child.once('error', () => finish(undefined))
    child.once('close', (code) => {
      const buf = Buffer.concat(chunks)
      if ((code !== 0 && code !== 1) || buf.includes(0)) return finish(undefined)
      const text = buf.toString('utf8')
      finish(text.length > ORIGINAL_MAX ? undefined : text)
    })
  })
}
