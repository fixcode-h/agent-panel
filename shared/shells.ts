import type { Settings } from './schema.ts'

/**
 * 命令行环境：面板替 Agent 跑整行命令时用的 shell。
 * 只有 Windows 上能选（WSL、Git Bash、PowerShell、cmd）；其他系统一律 sh。
 * 检测在服务端（server/shells.ts），这里放前后端共用的类型和「用哪个」的判断
 */
export type ShellKind = 'wsl' | 'gitbash' | 'powershell' | 'cmd' | 'sh'

export interface ShellInfo {
  id: ShellKind
  /** 可执行文件的路径（Git Bash 要用它，其余是命令名） */
  path: string
  /** WSL 的发行版，第一个是默认发行版 */
  distros?: string[]
}

export interface ShellReport {
  platform: string
  /** 这台机器上能用的，按推荐顺序 */
  shells: ShellInfo[]
}

export const SHELL_LABEL: Record<ShellKind, string> = {
  wsl: 'WSL',
  gitbash: 'Git Bash',
  powershell: 'PowerShell',
  cmd: 'cmd',
  sh: 'sh',
}

/** 推荐的：有 WSL 用 WSL，否则 Git Bash，再没有用 cmd；非 Windows 是 sh */
export function recommendedShell(r: ShellReport): ShellInfo {
  return r.shells[0] ?? { id: r.platform === 'win32' ? 'cmd' : 'sh', path: r.platform === 'win32' ? 'cmd.exe' : 'sh' }
}

/** 按设置选：选的那个这台机器上没有（换了电脑、卸载了）时回到推荐的 */
export function pickShell(r: ShellReport, s: Settings['shell']): ShellInfo & { distro: string } {
  const chosen = (s.kind && r.shells.find((x) => x.id === s.kind)) || recommendedShell(r)
  const distro = chosen.id === 'wsl' ? (chosen.distros?.includes(s.wslDistro) ? s.wslDistro : '') : ''
  return { ...chosen, distro }
}

/** 给 Agent 看的一句：后台命令在哪个 shell 里跑，命令要按它的语法写 */
export function shellNote(sh: ShellInfo & { distro?: string }) {
  if (sh.id === 'sh') return ''
  const name = sh.id === 'wsl' ? `WSL${sh.distro ? `（${sh.distro}）` : ''} 的 bash` : SHELL_LABEL[sh.id]
  return `命令在 ${name} 里执行，按它的语法写${sh.id === 'wsl' ? '；项目目录在 WSL 里是 /mnt/<盘符>/… 的路径' : ''}。`
}
