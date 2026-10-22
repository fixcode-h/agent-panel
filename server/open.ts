import { spawn } from 'node:child_process'
import path from 'node:path'

/** 用系统默认浏览器打开网址；打不开（例如没有图形界面的服务器）就只在终端里提示 */
export function openBrowser(url: string) {
  const [cmd, args] =
    process.platform === 'win32'
      ? // start 的第一个带引号的参数是窗口标题，所以先给一个空标题
        ['cmd', ['/c', 'start', '""', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]]
  try {
    const child = spawn(cmd, args as string[], {
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
      // 原样传给 cmd，否则 Node 会把空标题的引号转义掉
      windowsVerbatimArguments: process.platform === 'win32',
    })
    child.on('error', () => console.log(`没能自动打开浏览器，请手动访问 ${url}`))
    child.unref()
  } catch {
    console.log(`没能自动打开浏览器，请手动访问 ${url}`)
  }
}

/** 用系统的文件管理器打开目录（参数直接传给程序，不经过 shell） */
export function revealDir(dir: string) {
  const cmd = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  try {
    const child = spawn(cmd, [dir], { stdio: 'ignore', detached: true, windowsHide: true })
    child.on('error', () => {})
    child.unref()
  } catch {}
}

/** 可执行的文件不直接打开：点一下附件卡片不该跑起一个程序 */
const RUNNABLE =
  /\.(exe|com|bat|cmd|msi|msc|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|scr|pif|lnk|reg|jar|app|command|sh|run|appimage|desktop)$/i

/** 用系统默认的程序打开文件（参数直接传给程序，不经过 shell）；可执行文件返回 false，不打开 */
export function openWithSystem(file: string) {
  if (RUNNABLE.test(file)) return false
  revealDir(file)
  return true
}

/**
 * 打开所在的目录并选中它：装扩展时用户把选中的文件夹直接拖到浏览器的扩展页面上就装好了，
 * 不用在「加载已解压的扩展程序」的窗口里找路径。Linux 的文件管理器没有统一的「选中」参数，只打开上一级
 */
export function revealItem(dir: string) {
  const [cmd, args] =
    process.platform === 'win32'
      ? // 路径带空格时 explorer 要的是 /select,"路径"，Node 默认会把整个参数加引号，所以原样传
        ['explorer.exe', [`/select,"${dir}"`]]
      : process.platform === 'darwin'
        ? ['open', ['-R', dir]]
        : ['xdg-open', [path.dirname(dir)]]
  try {
    const child = spawn(cmd, args, {
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
      windowsVerbatimArguments: true,
    })
    child.on('error', () => {})
    child.unref()
  } catch {}
}
