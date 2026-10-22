import path from 'node:path'
import type { TestStep } from '../shared/schema.ts'
import { stepCommand } from '../shared/test-steps.ts'
import { runProcess } from './exec/process.ts'

/** 没写超时的步骤最多跑多久：UE 全量编译也够用，卡死的不至于一直占着队列 */
const DEFAULT_TIMEOUT_MS = 90 * 60_000
/** 交回给子对话的输出只留结尾：报错几乎都在最后 */
const TAIL = 6000

/** 用系统的 shell 跑一整行命令（Windows 上 cmd，其他系统 sh） */
/**
 * 一整行命令交给系统 shell 时的启动方式。
 * Windows 上和 Node 的 shell: true 一样：整行包一层引号、原样（verbatim）交给 cmd.exe /d /s /c。
 * 不能让 Node 按普通参数转义：它会把行里的 " 写成 \"，cmd 不认这种转义，原样传给程序，
 * 例如 node -e "setTimeout(...)" 里的代码变成带引号的字符串字面量，0 秒就「成功」退出
 */
export function shellCommand(line: string, platform: string = process.platform) {
  return platform === 'win32'
    ? { command: 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], windowsVerbatimArguments: true }
    : { command: 'sh', args: ['-c', line], windowsVerbatimArguments: false }
}

export function runShell(
  line: string,
  cwd: string,
  o: { timeoutMs: number; signal?: AbortSignal; onLine: (l: string) => void },
) {
  return runProcess({
    ...shellCommand(line),
    cwd,
    env: process.env,
    timeoutMs: o.timeoutMs,
    signal: o.signal,
    onLine: o.onLine,
  })
}

export interface StepRun {
  name: string
  ok: boolean
  ms: number
  /** 失败时的输出结尾 */
  tail: string
}

/**
 * 在合并后的目录里按顺序跑「合并时编译」的步骤，遇到失败就停。
 * 命令行和测试验收角色看到的一样（stepCommand），交给系统的 shell 执行
 */
export async function runMergeSteps(
  steps: TestStep[],
  dir: string,
  opts: { platform?: string; wslDistro?: string; signal?: AbortSignal } = {},
): Promise<{ ok: boolean; runs: StepRun[] }> {
  const platform = opts.platform ?? process.platform
  const runs: StepRun[] = []
  for (const s of steps) {
    const line = stepCommand(s, platform, opts.wslDistro)
    const out: string[] = []
    const start = Date.now()
    const r = await runShell(line, s.cwd ? path.resolve(dir, s.cwd) : dir, {
      timeoutMs: s.timeoutSec ? s.timeoutSec * 1000 : DEFAULT_TIMEOUT_MS,
      signal: opts.signal,
      onLine: (l) => {
        out.push(l)
        // 只留最后一段，长时间编译的输出不会把内存撑满
        if (out.length > 400) out.splice(0, out.length - 400)
      },
    })
    const ok = r.code === 0 && !r.killed && !r.spawnError
    const text = [out.join('\n'), r.stderr, r.spawnError ?? '', r.killed === 'timeout' ? '（超时，已停止）' : '']
      .filter(Boolean)
      .join('\n')
    runs.push({ name: s.name, ok, ms: Date.now() - start, tail: ok ? '' : text.slice(-TAIL) })
    if (!ok) return { ok: false, runs }
  }
  return { ok: true, runs }
}
