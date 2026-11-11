import type { Settings } from './schema.ts'

/**
 * 命令行环境：面板替 Agent 跑整行命令时用的 shell。
 * 只有 Windows 上能选（PowerShell、Git Bash、WSL、cmd）；其他系统一律 sh。
 * 检测在服务端（server/shells.ts），这里放前后端共用的类型和「用哪个」的判断。
 * 推荐顺序是 PowerShell > Git Bash > WSL > cmd（用户 2026-11-11 定）：PowerShell 每台 Windows 都有、不用另装，
 * 路径、编码和 Windows 工具链（UE 的 Build.bat、msbuild）都是原生的；装了 PowerShell 7（pwsh）时优先用它
 */
export type ShellKind = 'wsl' | 'gitbash' | 'powershell' | 'cmd' | 'sh'

export interface ShellInfo {
  id: ShellKind
  /** 可执行文件的路径（Git Bash、PowerShell 7 是完整路径，其余是命令名；PowerShell 5.1 是 powershell.exe） */
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

/** 推荐顺序：PowerShell > Git Bash > WSL > cmd；非 Windows 一律 sh */
const PREFERRED: ShellKind[] = ['powershell', 'gitbash', 'wsl', 'cmd']

/** 推荐的：PowerShell，没有时 Git Bash、WSL，再没有用 cmd；非 Windows 是 sh */
export function recommendedShell(r: ShellReport): ShellInfo {
  // 不直接取 shells[0]：检测结果的顺序和推荐顺序是两个概念，改一处漏一处会让默认值悄悄变回去
  for (const id of PREFERRED) {
    const hit = r.shells.find((s) => s.id === id)
    if (hit) return hit
  }
  return r.shells[0] ?? { id: r.platform === 'win32' ? 'cmd' : 'sh', path: r.platform === 'win32' ? 'cmd.exe' : 'sh' }
}

/** 按设置选：选的那个这台机器上没有（换了电脑、卸载了）时回到推荐的 */
export function pickShell(r: ShellReport, s: Settings['shell']): ShellInfo & { distro: string } {
  const chosen = (s.kind && r.shells.find((x) => x.id === s.kind)) || recommendedShell(r)
  const distro = chosen.id === 'wsl' ? (chosen.distros?.includes(s.wslDistro) ? s.wslDistro : '') : ''
  return { ...chosen, distro }
}

/**
 * 是 Windows 自带的 PowerShell 5.1（powershell.exe），不是 PowerShell 7（pwsh）：
 * 5.1 不认 `&&` / `||`，输出默认按系统代码页编码，面板替它补上（server/merge-build.ts）
 */
export const isWindowsPowerShell = (sh: Pick<ShellInfo, 'id' | 'path'>) =>
  sh.id === 'powershell' && !/pwsh(?:\.exe)?$/i.test(sh.path)

/** 下拉框里的名字：装了 PowerShell 7 时写明 7，和系统自带的 5.1 区分开 */
export const shellLabel = (sh: Pick<ShellInfo, 'id' | 'path'>) =>
  sh.id === 'powershell' && !isWindowsPowerShell(sh) ? 'PowerShell 7' : SHELL_LABEL[sh.id]

/** 给 Agent 看的一句：后台命令在哪个 shell 里跑，命令要按它的语法写 */
export function shellNote(sh: ShellInfo & { distro?: string }) {
  if (sh.id === 'sh') return ''
  const name =
    sh.id === 'wsl'
      ? `WSL${sh.distro ? `（${sh.distro}）` : ''} 的 bash`
      : sh.id === 'powershell'
        ? isWindowsPowerShell(sh)
          ? 'Windows PowerShell 5.1'
          : 'PowerShell 7'
        : SHELL_LABEL[sh.id]
  const where =
    sh.id === 'wsl'
      ? '；项目目录在 WSL 里是 /mnt/<盘符>/… 的路径'
      : '；项目目录是 Windows 路径（例如 F:/…），可以直接用'
  // 5.1 的 && / || 面板会换成等价写法，但 bash 的变量、export、反斜杠续行它不认，要写成 PowerShell 的
  const ps =
    sh.id === 'powershell' ? '；环境变量写 $env:NAME = "值"，不要用 bash 的 export、NAME=值 前缀和反斜杠续行' : ''
  return `命令在 ${name} 里执行，按它的语法写${where}${ps}。`
}

/**
 * Windows PowerShell 5.1 不认 `&&` / `||`（7 才有），Agent 和测试步骤又常写 `npm run build && npm test`，
 * 原样交给 5.1 会直接报语法错。按 bash 的语义（从左往右结合）换成等价写法：每段跑完记下 $?，
 * `&&` 只在前面成功时跑、`||` 只在前面失败时跑，最后失败就 exit 1（-Command 的退出码只看最后一条语句）。
 * 只认引号外的 && / ||；没有时原样返回
 */
export function psChain(line: string): string {
  const parts: string[] = []
  const ops: string[] = []
  let cur = ''
  let q = ''
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (q) {
      // PowerShell 的转义符是反引号；单引号里两个单引号是一个单引号，按两次切换处理结果一样
      if (ch === '`' && q === '"') {
        cur += ch + (line[i + 1] ?? '')
        i++
        continue
      }
      if (ch === q) q = ''
      cur += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      q = ch
      cur += ch
      continue
    }
    const two = line.slice(i, i + 2)
    if (two === '&&' || two === '||') {
      parts.push(cur.trim())
      ops.push(two)
      cur = ''
      i++
      continue
    }
    cur += ch
  }
  parts.push(cur.trim())
  if (!ops.length || parts.some((p) => !p)) return line
  const ok = '$__agentPanelOk'
  // 用 ; 连，不用换行：Windows 上参数里的换行会被压成空格（server/exec/process.ts）
  const out = [parts[0], `${ok} = $?`]
  ops.forEach((op, i) => out.push(`if (${op === '&&' ? '' : '-not '}${ok}) { ${parts[i + 1]}; ${ok} = $? }`))
  out.push(`if (-not ${ok}) { exit 1 }`)
  return out.join('; ')
}
