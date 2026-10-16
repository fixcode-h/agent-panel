import { getCli, type BuildOptions } from '../../shared/clis.ts'
import { codexAppSession } from './codex-app.ts'
import { parserFor, type CliEvent } from './parsers.ts'
import { runProcess, type ProcessResult } from './process.ts'

/**
 * 调用一次 CLI，把输出统一成 CliEvent。Claude Code、Command Code 是「stdin 写任务描述 + stdout 一行一个事件」，
 * Codex 走 app-server 协议（流式输出只有它有）。任务执行和 AI 创建共用这里。
 */
export async function invokeCli(o: {
  cliId: string
  command: string
  build: BuildOptions
  cwd: string
  env: NodeJS.ProcessEnv
  input: string
  signal?: AbortSignal
  timeoutMs: number
  onEvent: (ev: CliEvent) => void
}): Promise<ProcessResult> {
  const def = getCli(o.cliId)!
  const args = def.buildArgs(o.build)
  const toJson = (line: string) => {
    const t = line.trim()
    if (!t.startsWith('{')) return undefined
    try {
      return JSON.parse(t)
    } catch {
      return undefined
    }
  }

  if (o.cliId === 'codex') {
    const session = codexAppSession({ ...o.build, cwd: o.cwd, input: o.input })
    const r = await runProcess({
      command: o.command,
      args,
      cwd: o.cwd,
      env: o.env,
      signal: o.signal,
      timeoutMs: o.timeoutMs,
      onSpawn: (io) => session.start(io),
      onLine: (line) => {
        const obj = toJson(line)
        if (obj) for (const ev of session.handle(obj)) o.onEvent(ev)
      },
    })
    // 没等到 turn/completed 就退出了（崩溃、配置错误），算失败
    if (!session.finished && !r.killed && !r.spawnError)
      o.onEvent({ type: 'result', ok: false, error: 'Codex 没有完成这一轮就退出了' })
    return r
  }

  const parse = parserFor(o.cliId, o.cwd)
  return runProcess({
    command: o.command,
    args,
    cwd: o.cwd,
    env: o.env,
    stdin: o.input,
    signal: o.signal,
    timeoutMs: o.timeoutMs,
    onLine: (line) => {
      const obj = toJson(line)
      if (obj) for (const ev of parse(obj)) o.onEvent(ev)
    },
  })
}
