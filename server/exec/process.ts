import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import spawn from 'cross-spawn'
import { t } from '../../shared/i18n.ts'
import { log } from '../log.ts'
import { descendants, processSnapshot } from './proc-stats.ts'
import {
  looksLikePanelCli,
  trackCliProcess,
  untrackCliProcess,
  clearTrackedClis,
  touchCliProcess,
  type TrackedOwner,
} from './orphans.ts'

const isWin = process.platform === 'win32'

/**
 * npm 全局安装的 CLI 是 .cmd 垫片，cross-spawn 要经过 cmd.exe 转一手；参数里的换行会把整条命令行从那里截断，
 * 后面的参数全部丢失（Pi 的 -e 桥接扩展就是这样丢的，模型只剩内建工具）。换行在 Windows 的参数里本来也没法传，
 * 统一压成空格：宁可让提示词变成一行，也不能悄悄少掉后面的参数
 */
function oneLineArgs(args: string[]) {
  let flattened = 0
  const out = args.map((a) => {
    if (!/[\r\n]/.test(a)) return a
    flattened++
    return a.replace(/\r\n|\r|\n/g, ' ')
  })
  if (flattened) log.warn('exec', '参数里的换行在 Windows 上会被 cmd 截断命令行，已换成空格', { args: flattened })
  return out
}

export interface ProcessResult {
  code: number | null
  /** 被停止、超时，或太久没有输出 */
  killed: 'stopped' | 'timeout' | 'idle' | null
  /** 启动失败（例如找不到命令） */
  spawnError?: string
  stderr: string
}

/** 还在跑的子进程：程序退出时按这上面的 pid 统一清理 */
const live = new Map<number, ReturnType<typeof spawn>>()

/** 还在跑的子进程 pid：内存采样用它统计 CLI 子进程占了多少，不要另外维护一份 */
export const activePids = () => [...live.keys()]

/**
 * 对话（含子对话、子任务、工作流；按 owner.taskId）名下还活着的 CLI 进程：pid → 任务 id。
 * 界面上的「CLI 存活」（等下一句的提示、标题流光、侧栏提示）只认这一份：进程起来时登记、
 * close / error 时去掉，不拿 status === 'running' 或 awaitingUser 去猜
 */
const owned = new Map<number, string>()

/** 这个对话现在有没有活着的 CLI 进程 */
export function taskCliAlive(taskId: string) {
  if (!taskId) return false
  for (const id of owned.values()) if (id === taskId) return true
  return false
}

/** pid 还在不在（不关心它是什么进程） */
export function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const isAlive = isProcessAlive

/** 结束整个进程树：CLI 往往会再起子进程（shell、MCP 服务等） */
export function killTree(pid: number, force = false) {
  if (isWin) {
    nodeSpawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }).on('error', () => {})
    if (force) return
    // Windows 没有进程组：taskkill 偶尔只结掉一部分（孙进程被重新挂到别处），和 POSIX 一样 3 秒后再兜一次
    setTimeout(() => {
      if (!isAlive(pid)) return
      log.info('exec', '第一次 taskkill 没结束进程树，再杀一次', { pid })
      nodeSpawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }).on('error', () => {})
    }, 3000).unref()
    return
  }
  try {
    process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM')
  } catch {}
  if (force) return
  setTimeout(() => {
    if (isAlive(pid)) log.info('exec', 'SIGTERM 没结束进程组，补 SIGKILL', { pid })
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {}
  }, 3000).unref()
}

/**
 * 停止时用：结束进程树，连「脱离了树」的孙进程一起。
 * CLI 自己跑的命令（Claude Code 的 Bash 之类）可能另起进程组（POSIX 上组信号打不到），
 * Windows 上父进程先被 taskkill 结束后，孙进程就不在 /T 能找到的树里了——用户看到的就是
 * 「强制停止了对话，命令还在跑」。所以先拍一张进程表，按 ppid 找出全部后代，主进程结束后再逐个补杀
 */
export async function killTreeDeep(pid: number) {
  if (isWin) {
    // Windows 拍快照要一两秒：先动手结束主进程树，快照回来再补（ppid 不会被改写，照样找得到）
    const snap = processSnapshot(0).catch(() => null)
    killTree(pid)
    const map = await snap
    for (const k of map ? descendants(pid, map) : []) killTree(k, true)
    return
  }
  // POSIX 上父进程一死，孙进程会被挂到 1 号进程下：先拍快照（ps 很快）再动手
  const map = await processSnapshot(0).catch(() => null)
  killTree(pid)
  const rest = map ? descendants(pid, map) : []
  for (const k of rest)
    try {
      process.kill(k, 'SIGTERM')
    } catch {}
  if (!rest.length) return
  setTimeout(() => {
    for (const k of rest)
      try {
        process.kill(k, 'SIGKILL')
      } catch {}
  }, 3000).unref()
}

/** 同步结束进程树；只在进程退出、不能等异步任务时用 */
export function killTreeSync(pid: number) {
  if (isWin) {
    try {
      nodeSpawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 })
    } catch {}
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {}
}

/**
 * 退出前清理所有还在跑的 CLI（任务、AI 创建、设计、文档、模型补全、检测命令……），
 * 连同它们起 MCP 服务、shell 之类的子进程。能在进程退出事件里同步调用。
 */
export function killAllProcesses() {
  for (const [pid, child] of live) {
    killTreeSync(pid)
    // taskkill 有时先结束了父进程；再兜底结束一次直接子进程
    try {
      child.kill('SIGKILL')
    } catch {}
  }
  live.clear()
  // 进程都停了再清登记：万一上面没杀干净，登记留着下次启动还能照着认出来
  clearTrackedClis()
}

// 正常退出、Ctrl+C、托盘关闭都会走到这里；进程被 SIGKILL 时操作系统直接结束，来不及执行
process.on('exit', killAllProcesses)

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
  /** Windows 上参数原样拼进命令行、不加引号转义：交给 cmd.exe /c 的整行命令要用它（见 shellCommand） */
  windowsVerbatimArguments?: boolean
  /** 这个进程是哪个对话（含子对话、子任务、工作流）起的：进程面板按它归属和统计内存 */
  owner?: TrackedOwner
}): Promise<ProcessResult> {
  const args = isWin ? oneLineArgs(o.args) : o.args
  return new Promise((resolve) => {
    let killed: ProcessResult['killed'] = null
    let stderr = ''
    let settled = false
    let killerTimer: ReturnType<typeof setTimeout> | undefined
    let exitTimer: ReturnType<typeof setTimeout> | undefined
    const done = (r: Omit<ProcessResult, 'stderr' | 'killed'>) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(killerTimer)
      clearTimeout(exitTimer)
      clearInterval(idleTimer)
      o.signal?.removeEventListener('abort', onAbort)
      resolve({ ...r, killed, stderr: stderr.slice(-4000) })
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(o.command, args, {
        cwd: o.cwd,
        env: o.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: !isWin,
        windowsVerbatimArguments: o.windowsVerbatimArguments,
      })
    } catch (e) {
      return resolve({ code: null, killed: null, spawnError: (e as Error).message, stderr: '' })
    }

    const stop = (why: 'stopped' | 'timeout' | 'idle') => {
      if (killed || settled) return
      killed = why
      if (child.pid) void killTreeDeep(child.pid)
      // 进程树没杀干净时 close 永远不会来：给个上限，别把等结果的调用方（关对话、停后台命令）挂死
      killerTimer = setTimeout(() => {
        if (settled) return
        log.warn('exec', '进程树 5 秒内没退出，先结束等待', { pid: child.pid, why })
        stderr += `\n[${t('进程树未在 5 秒内退出，先结束等待')}]`
        // 只撤「这个对话的 CLI 还活着」的登记（taskCliAlive）：不撤的话杀不掉的进程会让对话永远显示 CLI 存活、
        // 接不上下一轮。live 表和遗留进程清单故意留着：进程可能真的还在跑，进程面板要能看到并手动结束它，
        // 面板退出时（killAllProcesses）和下次启动时也还会再杀一次；真的退出了 close / exit 会照常全部撤掉
        if (child.pid) owned.delete(child.pid)
        done({ code: null })
      }, 5000)
      killerTimer.unref?.()
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

    const pid = child.pid
    if (pid) live.set(pid, child)
    if (pid && o.owner?.taskId) owned.set(pid, o.owner.taskId)
    // 面板起的 CLI（带面板的桥接参数或面板临时目录）登记下来：面板被强杀后，下次启动照着它认遗留进程；
    // 短命令（git、版本检测）不带这些痕迹，不登记也不频繁写盘
    if (pid) {
      const argv = [o.command, ...args].join(' ')
      if (looksLikePanelCli(argv)) trackCliProcess(pid, argv, o.cwd, o.owner)
    }
    // 有输出就记一下「最后一次出声」：进程面板据此区分运行中和长时间没输出。
    // 一行一个事件，1 秒节流一次就够
    let touchedAt = 0
    const touch = () => {
      if (!pid) return
      const now = Date.now()
      if (now - touchedAt < 1000) return
      touchedAt = now
      touchCliProcess(pid)
    }
    const forget = () => {
      if (!pid) return
      live.delete(pid)
      owned.delete(pid)
      untrackCliProcess(pid)
    }
    child.on('error', (e: NodeJS.ErrnoException) => {
      forget()
      done({ code: null, spawnError: e.code === 'ENOENT' ? t('找不到命令「{cmd}」', { cmd: o.command }) : e.message })
    })
    child.stderr!.setEncoding('utf8')
    child.stderr!.on('data', (d: string) => {
      stderr = (stderr + d).slice(-16000)
      active()
      touch()
      o.onStderr?.(d)
    })
    const rl = createInterface({ input: child.stdout! })
    rl.on('line', (line) => {
      active()
      touch()
      try {
        o.onLine?.(line)
      } catch (e) {
        stderr += `\n[${t('解析输出出错')}] ${(e as Error).message}`
      }
    })
    child.on('close', (code) => {
      forget()
      clearTimeout(exitTimer)
      rl.close()
      done({ code })
    })
    // 进程已经退出，但输出流还被别人（孙进程继承了 stdout）握着时，close 可能永远不来：
    // 已经读不到更多输出了，等 3 秒给它收尾，别让等结果的调用方（后台命令、任务）挂死
    child.on('exit', (code) => {
      if (settled) return
      // 进程已经退出，先撤掉「还活着」的登记（taskCliAlive、live 表、遗留进程清单）：
      // 下面只是等输出流收尾，等 close 不来也会走 3 秒兜底；不在 exit 时撤的话，
      // 兜底路径上登记会一直留着，进程退出后 taskCliAlive 仍报活着
      forget()
      if (exitTimer) return
      exitTimer = setTimeout(() => {
        if (settled) return
        log.warn('exec', '进程已退出但输出流没关，先结束等待', { pid: child.pid, code })
        done({ code })
      }, 3000)
      exitTimer.unref?.()
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
