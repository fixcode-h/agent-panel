import { homedir } from 'node:os'
import path from 'node:path'
import { npmCommandPath, resolveCommand } from '../cli/source.ts'
import { expandWinVars, refreshWinPath } from '../win-path.ts'

/**
 * 找本机的一个命令（插件也用，开放给插件：shared/plugins/host-modules.json）。
 *
 * 面板进程的 PATH 常常和用户终端里的不一样：托盘或服务启动、装完工具没重启面板（Windows 新 PATH 只写进注册表）、
 * npm 全局目录没加进 PATH。只按 PATH 找会报「找不到命令」，用户明明在终端里能跑（飞书插件 2026-11-24）。
 * 依次找：当前 PATH → Windows 注册表里新加的 PATH → npm 全局目录 → 常见安装目录 → 调用方给的目录。
 * exclude 里的目录跳过：插件放在 Agent PATH 前面的拦截垫片和真命令同名，不能把垫片当成真命令
 */

export type CommandFrom = 'path' | 'npm' | 'common'

export interface FoundCommand {
  /** 可执行文件的完整路径（Windows 带 .cmd / .exe） */
  path: string
  /** 在哪找到的：PATH、npm 全局目录、常见安装目录 */
  from: CommandFrom
}

export interface FindCommandOptions {
  /** 跳过这些目录（比较时不分大小写、不看末尾斜杠） */
  exclude?: string[]
  /** 额外找的目录（工具官方文档写的安装位置），可以带 %VAR%、~ */
  dirs?: string[]
}

const isWin = process.platform === 'win32'
const norm = (d: string) => {
  const s = path.resolve(d).replace(/[\\/]+$/, '')
  return isWin ? s.toLowerCase() : s
}
const home = (d: string) => (d.startsWith('~') ? path.join(homedir(), d.slice(1)) : d)

/** 各系统上命令行工具常装的目录：npm 默认全局目录、用户级 bin、Homebrew、Volta、Bun、pnpm */
function commonDirs(): string[] {
  const h = homedir()
  if (isWin)
    return [
      '%APPDATA%\\npm',
      '%LOCALAPPDATA%\\pnpm',
      '%USERPROFILE%\\.volta\\bin',
      '%USERPROFILE%\\.bun\\bin',
      '%USERPROFILE%\\.local\\bin',
      '%ProgramFiles%\\nodejs',
    ].map(expandWinVars)
  return [
    path.join(h, '.local/bin'),
    path.join(h, '.npm-global/bin'),
    path.join(h, '.volta/bin'),
    path.join(h, '.bun/bin'),
    path.join(h, 'Library/pnpm'),
    path.join(h, '.local/share/pnpm'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
  ]
}

/** 只在给定目录里找（Windows 按 PATHEXT 补后缀，和启动时一样） */
const inDirs = (name: string, dirs: string[]) =>
  dirs.length ? resolveCommand(name, { ...process.env, PATH: dirs.join(path.delimiter) }) : undefined

/** 找命令；给的是路径（带 / 或 \）时只看这个文件在不在。找不到返回 undefined */
export async function findCommand(name: string, o: FindCommandOptions = {}): Promise<FoundCommand | undefined> {
  const skip = new Set((o.exclude ?? []).map(norm))
  const keep = (dirs: string[]) => dirs.filter((d) => d && !skip.has(norm(d)))
  if (name.includes('/') || name.includes('\\')) {
    const p = resolveCommand(home(name))
    return p ? { path: p, from: 'path' } : undefined
  }
  const pathDirs = () => keep((process.env.PATH ?? process.env.Path ?? '').split(path.delimiter))
  let hit = inDirs(name, pathDirs())
  // Windows：装完工具没重启面板时，新 PATH 只在注册表里
  if (!hit && (await refreshWinPath())) hit = inDirs(name, pathDirs())
  if (hit) return { path: hit, from: 'path' }
  const npm = await npmCommandPath(name).catch(() => undefined)
  if (npm && !skip.has(norm(path.dirname(npm)))) return { path: npm, from: 'npm' }
  const extra = inDirs(name, keep([...(o.dirs ?? []).map((d) => expandWinVars(home(d))), ...commonDirs()]))
  return extra ? { path: extra, from: 'common' } : undefined
}
