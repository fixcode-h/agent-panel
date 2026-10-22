import { existsSync } from 'node:fs'
import path from 'node:path'
import { pickShell, type ShellInfo, type ShellReport } from '../shared/shells.ts'
import { capture } from './exec/process.ts'

/**
 * 检测本机能用的命令行环境（只在 Windows 上有意义），结果缓存；设置页可以要求重新检测。
 * 顺序就是推荐顺序：WSL > Git Bash > PowerShell > cmd
 */
let cache: Promise<ShellReport> | null = null
/** 最近一次按设置选出的 shell：工具说明是同步拼的，用它告诉 Agent 命令在哪执行 */
let last: (ShellInfo & { distro: string }) | null = null

export function detectShells(fresh = false) {
  if (!cache || fresh) cache = detect().catch(() => ({ platform: process.platform, shells: [] }))
  return cache
}

async function detect(): Promise<ShellReport> {
  if (process.platform !== 'win32') return { platform: process.platform, shells: [{ id: 'sh', path: 'sh' }] }
  const shells: ShellInfo[] = []
  const distros = await wslDistros()
  if (distros.length) shells.push({ id: 'wsl', path: 'wsl.exe', distros })
  const bash = await gitBash()
  if (bash) shells.push({ id: 'gitbash', path: bash })
  shells.push({ id: 'powershell', path: 'powershell.exe' }, { id: 'cmd', path: 'cmd.exe' })
  return { platform: process.platform, shells }
}

/** wsl -l -q 的输出是 UTF-16：按 UTF-8 读进来每个字符后面跟一个 \0，去掉；Docker Desktop 自带的发行版不算 */
async function wslDistros() {
  const r = await capture('wsl.exe', ['-l', '-q'], process.cwd(), process.env, 10_000).catch(() => null)
  if (!r || r.code !== 0) return []
  return r.stdout
    .replace(/\0/g, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^docker-desktop/i.test(l))
}

/**
 * Git Bash：从 git 的位置推（Git\cmd\git.exe → Git\bin\bash.exe），再看常见安装目录。
 * 不用 PATH 里的 bash.exe：System32 下的那个其实是 WSL 的入口
 */
async function gitBash() {
  const where = await capture('where.exe', ['git'], process.cwd(), process.env, 5000).catch(() => null)
  const fromGit = (where?.code === 0 ? where.stdout.split(/\r?\n/) : [])
    .map((l) => l.trim())
    .filter(Boolean)
    .map((g) => path.join(path.dirname(path.dirname(g)), 'bin', 'bash.exe'))
  const env = process.env
  const common = [
    env.ProgramFiles,
    env['ProgramFiles(x86)'],
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs'),
  ]
    .filter((d): d is string => !!d)
    .map((d) => path.join(d, 'Git', 'bin', 'bash.exe'))
  return [...fromGit, ...common].find((p) => existsSync(p)) ?? ''
}

/** 按设置选出这次用的 shell；设置按需加载，免得只想读 lastShell 的模块（编排工具）连带加载设置和语言 */
export async function currentShell() {
  const { getSettings } = await import('./settings.ts')
  last = pickShell(await detectShells(), (await getSettings()).shell)
  return last
}

/** 同步拿最近一次选出的（还没选过时为空）；服务启动和保存设置时会选一次 */
export const lastShell = () => last
