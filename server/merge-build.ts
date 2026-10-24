import type { ShellInfo } from '../shared/shells.ts'
import { runProcess } from './exec/process.ts'

/**
 * 一整行命令交给 shell 时的启动方式；shell 是设置里选的命令行环境（见 server/shells.ts），不传时 Windows 用 cmd。
 * cmd 和 Node 的 shell: true 一样：整行包一层引号、原样（verbatim）交给 cmd.exe /d /s /c。
 * 不能让 Node 按普通参数转义给 cmd：它会把行里的 " 写成 \"，cmd 不认这种转义，原样传给程序，
 * 例如 node -e "setTimeout(...)" 里的代码变成带引号的字符串字面量，0 秒就「成功」退出。
 * 其余几个（wsl.exe、Git 的 bash.exe、powershell.exe）按标准规则解析参数，交给 Node 正常转义
 */
export function shellCommand(
  line: string,
  platform: string = process.platform,
  shell?: Pick<ShellInfo, 'id' | 'path'> & { distro?: string },
) {
  if (platform !== 'win32') return { command: 'sh', args: ['-c', line], windowsVerbatimArguments: false, env: {} }
  const plain = (command: string, args: string[], env: Record<string, string> = {}) => ({
    command,
    args,
    windowsVerbatimArguments: false,
    env,
  })
  switch (shell?.id) {
    // -e 直接执行 bash，不再经过默认 shell 拼一遍命令；工作目录由 wsl.exe 按 Windows 的当前目录换成 /mnt/…
    case 'wsl':
      return plain('wsl.exe', [...(shell.distro ? ['-d', shell.distro] : []), '-e', 'bash', '-lc', line])
    // 登录 shell 才有 Git 的 PATH；CHERE_INVOKING 让它留在当前目录，不跳回 HOME
    case 'gitbash':
      return plain(shell.path, ['-lc', line], { CHERE_INVOKING: '1' })
    case 'powershell':
      return plain('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', line])
    default:
      return { command: 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], windowsVerbatimArguments: true, env: {} }
  }
}

export function runShell(
  line: string,
  cwd: string,
  o: {
    timeoutMs: number
    signal?: AbortSignal
    onLine: (l: string) => void
    /** stderr 按块回调：后台命令靠它知道命令还有动静（进度多写在 stderr） */
    onStderr?: (text: string) => void
    shell?: Parameters<typeof shellCommand>[2]
    env?: { key: string; value: string }[]
  },
) {
  const { env, ...cmd } = shellCommand(line, process.platform, o.shell)
  return runProcess({
    ...cmd,
    cwd,
    env: { ...process.env, ...env, ...Object.fromEntries((o.env ?? []).map((x) => [x.key, x.value])) },
    timeoutMs: o.timeoutMs,
    signal: o.signal,
    onLine: o.onLine,
    onStderr: o.onStderr,
  })
}
