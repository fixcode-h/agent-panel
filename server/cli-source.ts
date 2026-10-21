import { existsSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { capture, childEnv } from './exec/process.ts'
import { getCli } from '../shared/clis.ts'

const isWin = process.platform === 'win32'
// 测试时换成假的 npm
export const NPM = process.env.AGENT_PANEL_NPM || 'npm'

/**
 * CLI 是怎么装的：npm 全局包、Claude Code 官方安装脚本（原生版）、Homebrew，或者其他方式。
 * 更新和卸载要用对应的方式，否则 npm 装了新版本，PATH 里先找到的还是旧的那个。
 */
export type CliSource = 'npm' | 'native' | 'brew' | 'other'

/** 和启动 CLI 时一样按 PATH（Windows 还有 PATHEXT）找到实际会运行的文件 */
export function resolveCommand(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const isFile = (p: string) => {
    try {
      return statSync(p).isFile()
    } catch {
      return false
    }
  }
  const exts = isWin ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : ['']
  const withExt = (p: string) =>
    isWin && path.extname(p) ? [p, ...exts.map((e) => p + e)] : exts.map((e) => p + e.toLowerCase())
  if (command.includes('/') || command.includes('\\')) return withExt(command).find(isFile)
  const dirs = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)
  // Windows 先找当前目录以外的 PATH；和 cross-spawn 一样，同一个目录里按 PATHEXT 的顺序
  for (const d of dirs) {
    const hit = withExt(path.join(d.replace(/^"|"$/g, ''), command)).find(isFile)
    if (hit) return hit
  }
  return undefined
}

let npmBinCache: { at: number; dir?: string } | undefined
/** npm 全局安装的命令放在哪个目录：Windows 是 prefix 本身，其他系统是 prefix/bin */
export async function npmGlobalBin() {
  if (npmBinCache && Date.now() - npmBinCache.at < 10 * 60_000) return npmBinCache.dir
  const r = await capture(NPM, ['prefix', '-g'], homedir(), childEnv([]), 15_000)
  const prefix = r.code === 0 ? r.stdout.trim().split('\n').at(-1)?.trim() : undefined
  const dir = prefix ? (isWin ? prefix : path.join(prefix, 'bin')) : undefined
  npmBinCache = { at: Date.now(), dir }
  return dir
}

const same = (a: string, b: string) => (isWin ? a.toLowerCase() === b.toLowerCase() : a === b)
const real = (p: string) => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/** Claude Code 原生版：命令在 ~/.local/bin，版本文件在 ~/.local/share/claude */
export const claudeNative = () => ({
  bin: path.join(homedir(), '.local', 'bin', isWin ? 'claude.exe' : 'claude'),
  data: path.join(homedir(), '.local', 'share', 'claude'),
})

export async function cliSource(cliId: string, file: string | undefined): Promise<CliSource> {
  if (!file) return 'other'
  const npmBin = await npmGlobalBin()
  if (npmBin && same(path.dirname(file), npmBin)) return 'npm'
  const target = real(file)
  // 没装在 npm 的全局目录，但最后指向某个 node_modules 里的包（例如 nvm、自定义 prefix）；
  // 改名前用过的包（npmRenameFrom）也算 npm 装的，才能用 npm 的方式更新它
  const def = getCli(cliId)
  const pkgs = [def?.npmPackage, ...(def?.npmRenameFrom ?? [])].filter(Boolean) as string[]
  const normalized = target.replaceAll('\\', '/')
  if (pkgs.some((p) => normalized.includes(`/node_modules/${p}/`))) return 'npm'
  if (/[\\/](homebrew|Cellar|Caskroom|linuxbrew)[\\/]/i.test(target) || /[\\/](homebrew|linuxbrew)[\\/]/i.test(file))
    return 'brew'
  if (cliId === 'claude') {
    const n = claudeNative()
    if (same(file, n.bin) || target.startsWith(n.data)) return 'native'
  }
  return 'other'
}

/** npm 全局目录里这个包的命令（可能和 PATH 里先找到的不是同一个） */
export async function npmCommandPath(command: string) {
  const bin = await npmGlobalBin()
  if (!bin || command.includes('/') || command.includes('\\')) return undefined
  const names = isWin ? [`${command}.cmd`, `${command}.exe`] : [command]
  return names.map((n) => path.join(bin, n)).find((p) => existsSync(p))
}

/** Homebrew 里对应的包 */
export const brewName = (cliId: string) => getCli(cliId)?.brew ?? []
