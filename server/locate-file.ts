/**
 * 找回浏览器拿不到的原路径：粘贴、拖进输入框的大文件（超过设置里的大小，默认 10 MB）不上传，只引用它在本机的位置。
 *
 * 浏览器只给文件名、大小和修改时间。面板和浏览器在同一台电脑上，所以：
 * 1. 粘贴：先读系统剪贴板里复制的文件列表（Windows 资源管理器、macOS 访达、Linux 文件管理器复制的文件都在里面）；
 * 2. 拖进来或剪贴板里没有：在常用的位置（桌面、下载、文档…和各个项目目录）里按名字、大小、修改时间找。
 * 两样都找不到才交回给页面，由页面让用户自己选。
 */
import { spawn } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

export interface Wanted {
  name: string
  size: number
  /** 浏览器给的修改时间（毫秒） */
  mtime?: number
}

const MARK = '@@agent-panel-clip@@'

/** 跑一个读剪贴板的小命令，收集输出；没装、出错、超时都当作没有 */
function output(command: string, args: string[], timeoutMs = 5000): Promise<string> {
  return new Promise((resolve) => {
    let out = ''
    let done = false
    const finish = (s: string) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(s)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, { windowsHide: true })
    } catch {
      return resolve('')
    }
    const timer = setTimeout(() => {
      child.kill()
      finish('')
    }, timeoutMs)
    child.stdout?.on('data', (b) => (out += String(b)))
    child.stderr?.on('data', () => {})
    child.on('error', () => finish(''))
    child.on('close', (code) => finish(code === 0 ? out : ''))
  })
}

/** file:// 地址换成本机路径 */
function fromUri(uri: string) {
  try {
    const u = new URL(uri.trim())
    if (u.protocol !== 'file:') return ''
    const p = decodeURIComponent(u.pathname)
    return process.platform === 'win32' ? p.replace(/^\/([A-Za-z]:)/, '$1').replace(/\//g, '\\') : p
  } catch {
    return ''
  }
}

/** 系统剪贴板里复制的文件（绝对路径） */
export async function clipboardFiles(): Promise<string[]> {
  if (process.platform === 'win32') {
    const out = await output('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Get-Clipboard -Format FileDropList | ForEach-Object { Write-Output ("${MARK}" + $_.FullName) }`,
    ])
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith(MARK))
      .map((l) => l.slice(MARK.length))
  }
  if (process.platform === 'darwin') {
    const out = await output('osascript', ['-e', 'POSIX path of (the clipboard as «class furl»)'])
    return out.trim() ? [out.trim()] : []
  }
  // Linux：X11 用 xclip，Wayland 用 wl-paste；复制的文件是一行一个 file:// 地址
  const list =
    (await output('xclip', ['-selection', 'clipboard', '-t', 'text/uri-list', '-o'])) ||
    (await output('wl-paste', ['--no-newline', '--type', 'text/uri-list']))
  return list
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('#'))
    .map(fromUri)
    .filter(Boolean)
}

/** 平时放文件的地方（中英文系统的文件夹名都试；OneDrive 会把桌面、文档挪进去） */
function commonDirs() {
  const home = homedir()
  const names = [
    'Desktop',
    'Downloads',
    'Documents',
    'Pictures',
    'Videos',
    'Music',
    '桌面',
    '下载',
    '文档',
    '图片',
    '视频',
    '音乐',
  ]
  const bases = [home, path.join(home, 'OneDrive'), path.join(home, 'OneDrive - Personal')]
  return [...bases.flatMap((b) => names.map((n) => path.join(b, n))), home]
}

const SKIP = new Set(['node_modules', '.git', 'Library', 'AppData', 'Intermediate', 'DerivedDataCache', 'Saved'])

/** 修改时间差多少以内算同一个文件：有的文件系统只记到秒 */
const SAME_TIME_MS = 2000

/**
 * 在这些目录里按名字和大小找文件；有修改时间时挑时间最接近的。
 * 按层往下找（最多 depth 层），看过的条目和用时都有上限，找不到就算了，不让粘贴卡住
 */
export async function searchFiles(wanted: Wanted[], dirs: string[], depth = 4, budgetMs = 4000) {
  const found = new Map<Wanted, { path: string; diff: number }>()
  const deadline = Date.now() + budgetMs
  const seen = new Set<string>()
  let entries = 0
  let level = [...new Set(dirs.map((d) => path.resolve(d)))].map((d) => ({ dir: d, at: 0 }))
  while (level.length && Date.now() < deadline && entries < 200_000) {
    const next: typeof level = []
    for (const { dir, at } of level) {
      if (seen.has(dir) || Date.now() > deadline) continue
      seen.add(dir)
      const items = await readdir(dir, { withFileTypes: true }).catch(() => [])
      entries += items.length
      for (const it of items) {
        const full = path.join(dir, it.name)
        if (it.isDirectory()) {
          // 家目录本身只看第一层：下面的常用文件夹已经单独找过，别的多半是程序的数据
          if (at + 1 < depth && !it.name.startsWith('.') && !SKIP.has(it.name) && dir !== homedir())
            next.push({ dir: full, at: at + 1 })
          continue
        }
        if (!it.isFile()) continue
        for (const w of wanted) {
          if (w.name !== it.name) continue
          const s = await stat(full).catch(() => null)
          if (!s || s.size !== w.size) continue
          const diff = w.mtime ? Math.abs(s.mtimeMs - w.mtime) : 0
          const had = found.get(w)
          if (!had || diff < had.diff) found.set(w, { path: full, diff })
        }
      }
    }
    // 每个文件都找到了时间也对得上的，就不用再往下翻
    if (wanted.every((w) => (found.get(w)?.diff ?? Infinity) <= SAME_TIME_MS)) break
    level = next
  }
  return found
}

/** 按名字和大小（有时间时再看时间）找回每个文件的路径；找不到的不在结果里 */
export async function locateFiles(wanted: Wanted[], extraDirs: string[] = [], clipboard = true) {
  const out = new Map<Wanted, string>()
  if (clipboard) {
    const clip = await clipboardFiles()
    for (const file of clip) {
      const s = await stat(file).catch(() => null)
      if (!s?.isFile()) continue
      const w = wanted.find((x) => !out.has(x) && x.name === path.basename(file) && x.size === s.size)
      if (w) out.set(w, file)
    }
  }
  const rest = wanted.filter((w) => !out.has(w))
  if (rest.length) {
    const found = await searchFiles(rest, [...extraDirs.filter(Boolean), ...commonDirs()])
    for (const [w, hit] of found) out.set(w, hit.path)
  }
  return out
}
