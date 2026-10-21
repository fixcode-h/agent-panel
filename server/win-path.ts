import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Windows 上用 winget、安装包装好工具后，新的 PATH 只写进注册表，已经在跑的面板进程看不到，
 * 要重启才能找到新装的命令。这里从注册表重新读一次系统和用户的 PATH，把缺的目录补进当前进程。
 * 其他系统不用：装到的位置一般已经在 PATH 里。
 */
const KEYS = ['HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', 'HKCU\\Environment']

/** 刚读过就不再读：设置页轮询时不用每次都起 reg 进程 */
const MIN_GAP = 10_000
let last = 0

/** 展开 %VAR%（REG_EXPAND_SZ 里常见 %USERPROFILE%、%SystemRoot%） */
const expand = (s: string) =>
  s.replace(/%([^%]+)%/g, (all, name: string) => {
    const key = Object.keys(process.env).find((k) => k.toLowerCase() === name.toLowerCase())
    return key ? (process.env[key] ?? all) : all
  })

async function readKey(key: string) {
  try {
    const { stdout } = await execFileAsync('reg', ['query', key, '/v', 'Path'], { windowsHide: true, timeout: 5_000 })
    return stdout.match(/^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/im)?.[1]?.trim() ?? ''
  } catch {
    return ''
  }
}

/** 把注册表里新加的 PATH 目录补进当前进程；返回补进了几个 */
export async function refreshWinPath(force = false): Promise<number> {
  if (process.platform !== 'win32') return 0
  if (!force && Date.now() - last < MIN_GAP) return 0
  last = Date.now()
  const fresh = (await Promise.all(KEYS.map(readKey)))
    .flatMap((v) => v.split(';'))
    .map((d) => expand(d.trim()))
    .filter(Boolean)
  const cur = (process.env.PATH ?? '').split(';').filter(Boolean)
  const norm = (d: string) => d.replace(/[\\/]+$/, '').toLowerCase()
  const have = new Set(cur.map(norm))
  const add = fresh.filter((d) => !have.has(norm(d)) && have.add(norm(d)))
  // 原有的顺序不动，新目录放在后面：不改变已经能找到的命令用哪一个
  if (add.length) process.env.PATH = [...cur, ...add].join(';')
  return add.length
}

/** 展开路径里的 %VAR%：工具定义里写的常见安装目录用 */
export const expandWinVars = expand
