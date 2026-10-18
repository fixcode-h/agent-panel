import { spawn as nodeSpawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import spawn from 'cross-spawn'
import { t } from '../../shared/i18n.ts'

const isWin = process.platform === 'win32'

export interface ProcessResult {
  code: number | null
  /** 被停止、超时，或太久没有输出 */
  killed: 'stopped' | 'timeout' | 'idle' | null
  /** 启动失败（例如找不到命令） */
  spawnError?: string
  stderr: string
}

/** 结束整个进程树：CLI 往往会再起子进程（shell、MCP 服务等） */
export function killTree(pid: number) {
  if (isWin) {
    nodeSpawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }).on('error', () => {})
    return
  }
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {}
  setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {}
  }, 3000).unref()
}

/** 子进程的环境变量：继承当前环境，去掉会让 CLI 以为自己被嵌套调用的变量，再加上设置里的变量 */
export function childEnv(extra: { key: string; value: string }[]) {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.CLAUDECODE
  for (const { key, value } of extra) if (key) env[key] = value
  return env
}

/**
 * 启动一个 CLI：参数直接传给进程（不经过 shell 拼接），stdin 写入任务描述，
 * stdout 按行回调。Windows 上用 cross-spawn 处理 npm 生成的 .cmd 启动脚本。
 */
export function runProcess(o: {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  stdin?: string
  signal?: AbortSignal
  timeoutMs?: number
  /** 空闲检测：ms 没有任何输出先提醒（onWarn），再过 ms 还没有就停掉；busy() 为真时（例如在等用户确认）不算空闲 */
  idle?: { ms: number; onWarn?: () => void; busy?: () => boolean }
  onLine?: (line: string) => void
  /** stderr 按块回调（npm 的进度、警告都写在 stderr） */
  onStderr?: (text: string) => void
  /** 写完 stdin 后不关闭：codex app-server 这类服务一读到 EOF 就退出，要等拿到回复再停掉它 */
  keepStdinOpen?: boolean
  /** 启动后拿到写 stdin 的方法：按协议一来一回对话的 CLI（codex app-server）用它发请求 */
  onSpawn?: (io: { write: (s: string) => void; end: () => void }) => void
}): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let killed: ProcessResult['killed'] = null
    let stderr = ''
    let settled = false
    const done = (r: Omit<ProcessResult, 'stderr' | 'killed'>) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearInterval(idleTimer)
      o.signal?.removeEventListener('abort', onAbort)
      resolve({ ...r, killed, stderr: stderr.slice(-4000) })
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(o.command, o.args, {
        cwd: o.cwd,
        env: o.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: !isWin,
      })
    } catch (e) {
      return resolve({ code: null, killed: null, spawnError: (e as Error).message, stderr: '' })
    }

    const stop = (why: 'stopped' | 'timeout' | 'idle') => {
      if (killed || settled) return
      killed = why
      if (child.pid) killTree(child.pid)
    }
    const onAbort = () => stop('stopped')
    o.signal?.addEventListener('abort', onAbort)
    if (o.signal?.aborted) stop('stopped')
    const timer = setTimeout(() => stop('timeout'), o.timeoutMs || 2 ** 31 - 1)
    let lastOutput = Date.now()
    let warned = false
    const active = () => {
      lastOutput = Date.now()
      warned = false
    }
    const idleMs = o.idle?.ms ?? 0
    const idleTimer = setInterval(
      () => {
        if (o.idle?.busy?.()) return active()
        const quiet = Date.now() - lastOutput
        if (quiet >= idleMs * 2) stop('idle')
        else if (quiet >= idleMs && !warned) {
          warned = true
          o.idle?.onWarn?.()
        }
      },
      idleMs ? Math.min(30_000, Math.max(50, idleMs / 4)) : 2 ** 31 - 1,
    )

    child.on('error', (e: NodeJS.ErrnoException) =>
      done({ code: null, spawnError: e.code === 'ENOENT' ? t('找不到命令「{cmd}」', { cmd: o.command }) : e.message }),
    )
    child.stderr!.setEncoding('utf8')
    child.stderr!.on('data', (d: string) => {
      stderr = (stderr + d).slice(-16000)
      active()
      o.onStderr?.(d)
    })
    const rl = createInterface({ input: child.stdout! })
    rl.on('line', (line) => {
      active()
      try {
        o.onLine?.(line)
      } catch (e) {
        stderr += `\n[${t('解析输出出错')}] ${(e as Error).message}`
      }
    })
    child.on('close', (code) => {
      rl.close()
      done({ code })
    })

    child.stdin!.on('error', () => {})
    if (o.onSpawn) {
      const stdin = child.stdin!
      o.onSpawn({ write: (s) => void (stdin.writable && stdin.write(s)), end: () => stdin.end() })
    } else if (o.keepStdinOpen) child.stdin!.write(o.stdin ?? '')
    else child.stdin!.end(o.stdin ?? '')
  })
}

/** 跑一个短命令并拿到全部输出，用于版本检测和 git */
export async function capture(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 8000,
) {
  const lines: string[] = []
  const r = await runProcess({ command, args, cwd, env, timeoutMs, onLine: (l) => lines.push(l) })
  return { ...r, stdout: lines.join('\n') }
}
