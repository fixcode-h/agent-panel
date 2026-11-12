import { isWindows, stepCommand, wslDistroOf } from '../shared/test-steps.ts'
import type { ShellInfo } from '../shared/shells.ts'
import type { TestStep } from '../shared/schema.ts'
import { detectShells } from './shells.ts'

/**
 * 面板自己跑项目测试步骤（request_build 的编译、合回后的父对话测试）时，命令行和用哪个 shell 起进程。
 *
 * 以前一律先用 stepCommand 包成一整行字符串（`cmd.exe /d /c "\"…\""`），再交给设置里选的命令行环境去跑，
 * 等于套了两层 shell，转义规则对不上：Git Bash 里 MSYS 把 /d /c 改写成路径，cmd 只打印版本横幅就以退出码 0 退出
 * （「编译成功，310ms」其实什么都没编）；PowerShell 不认 `\"`，cmd 收到 `\"D:/…` 报 `'\' is not recognized`。
 * Agent 看正路走不通，只好在前台硬跑 UE 编译，整份日志进了上下文（用户 2026-11-12 报）。
 *
 * 现在步骤标了哪个环境就直接起那个环境的进程，命令原文交给它，只经过一层 shell：
 * cmd 按 Node 的 shell: true 同一种写法（cmd.exe /d /s /c "原文"，verbatim），PowerShell、WSL、Git Bash 按各自的参数传。
 * 不是 Windows、或者是「自动」的步骤，照旧交给设置里的 shell
 */
export async function stepRun(
  step: Pick<TestStep, 'command' | 'env'>,
  platform: string,
  wslDistro = '',
): Promise<{ command: string; shell?: ShellInfo & { distro?: string } }> {
  const cmd = step.command.trim()
  if (!isWindows(platform)) return { command: stepCommand(step, platform, wslDistro) }
  if (step.env === 'cmd') return { command: cmd, shell: { id: 'cmd', path: 'cmd.exe' } }
  if (step.env === 'wsl') return { command: cmd, shell: { id: 'wsl', path: 'wsl.exe', distro: wslDistroOf(wslDistro) } }
  if (step.env === 'powershell' || step.env === 'bash') {
    const found = (await detectShells()).shells.find((s) => s.id === (step.env === 'bash' ? 'gitbash' : 'powershell'))
    if (found) return { command: cmd, shell: found }
    if (step.env === 'powershell') return { command: cmd, shell: { id: 'powershell', path: 'powershell.exe' } }
  }
  return { command: stepCommand(step, platform, wslDistro) }
}
