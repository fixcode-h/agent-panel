import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { isProcessAlive, killTree } from './process.ts'
import { trackCliProcess, untrackCliProcess } from './orphans.ts'
import { t } from '../../shared/i18n.ts'

/**
 * 插件和面板里「不是 CLI 对话」的外部进程（UE 的 Build.bat / UBT、Lua 编译、ffmpeg……）的统一入口。
 *
 * - `spawnTracked`：起进程并登记进孤儿登记（orphans.ts）。面板被强杀后下次启动照登记清掉；
 *   这类进程的命令行没有面板痕迹（cli-run 目录、panel MCP 参数），所以登记时带一个 `tag`
 *   （默认是命令本身），清理时现在那个 pid 的命令行里还有它才算「还是我们起的那个」，pid 被复用的不碰。
 * - `stopTree`：结束整棵进程树并等它真的退出。Windows 上 .bat 经 cmd 起，真正干活的是孙进程，
 *   只杀父进程会留下还占着文件和互斥量的子进程；以前插件各自调 taskkill，报错和等待各写一份。
 *
 * 为什么不直接用 runProcess：调用方要自己接 stdout（写作业日志、判断编译阶段），也要 shell 跑 .bat，
 * runProcess 是给 CLI 对话设计的（stdin 写任务、空闲检测），套过来反而要绕
 */

export type TrackedSpawnOptions = Pick<SpawnOptions, 'cwd' | 'env' | 'shell' | 'detached' | 'stdio' | 'windowsHide'> & {
  cwd: string
  /** 哪个插件或模块起的（进程面板和日志里显示） */
  source: string
  /** 给人看的说明，例如「UE 编译 MyGame」 */
  title: string
  /** 认进程用的片段：清理遗留时命令行里还带着它才动手；默认是 command */
  tag?: string
}

/** 起一个外部进程并登记；进程退出（或起不来）时自动撤登记 */
export function spawnTracked(command: string, args: string[], o: TrackedSpawnOptions): ChildProcess {
  const { source, title, tag, ...opts } = o
  const child = spawn(command, args, { windowsHide: true, ...opts })
  const pid = child.pid
  if (pid) {
    trackCliProcess(pid, [command, ...args].join(' '), o.cwd, undefined, {
      tag: tag || command,
      source,
      title,
    })
    const forget = () => untrackCliProcess(pid)
    child.once('exit', forget)
    child.once('error', forget)
  }
  return child
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** taskkill 的输出（报错原因在 stderr，例如「拒绝访问」：进程是管理员权限起的） */
function taskkill(pid: number, timeout: number) {
  return new Promise<{ code: number; msg: string }>((resolve) => {
    execFile(
      'taskkill.exe',
      ['/PID', String(pid), '/T', '/F'],
      { windowsHide: true, timeout, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const code = err
          ? typeof (err as { code?: unknown }).code === 'number'
            ? (err as { code: number }).code
            : 1
          : 0
        resolve({ code, msg: (stderr || stdout || err?.message || '').trim() })
      },
    )
  })
}

/**
 * 结束整棵进程树，等它真的退出（最多 waitMs）再返回。已经自己退出了也算成功；
 * 结束不了（权限不够）时把系统的原话放在 error 里交给调用方显示
 */
export async function stopTree(pid: number, o: { waitMs?: number } = {}): Promise<{ ok: boolean; error?: string }> {
  const waitMs = o.waitMs ?? 20_000
  if (!isProcessAlive(pid)) return { ok: true }
  if (process.platform === 'win32') {
    const r = await taskkill(pid, 15_000)
    if (r.code !== 0 && isProcessAlive(pid)) return { ok: false, error: r.msg || `exit ${r.code}` }
  } else {
    // 自己起的（detached）是进程组组长，killTree 按组结束；别人起的（编辑器、旧编译）不是组长，组信号打不到，再单独发一次
    killTree(pid)
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // 已经退出
    }
  }
  const until = Date.now() + waitMs
  while (isProcessAlive(pid) && Date.now() < until) await sleep(300)
  return isProcessAlive(pid)
    ? { ok: false, error: t('结束后 {n} 秒还没退出', { n: Math.round(waitMs / 1000) }) }
    : { ok: true }
}
