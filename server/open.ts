import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { t } from '../shared/i18n.ts'

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

/**
 * 起一个系统程序，等进程真的创建出来才算成功。
 * spawn 的 error 事件（找不到程序、没权限）以前被空回调吞掉，界面上就成了「点了没反应」，
 * 所以这里把它变成带原因的 reject。参数直接传给程序、不经过 shell，中文路径不用转编码。
 */
export function launch(cmd: string, args: string[], verbatim = false): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawn(cmd, args, {
        stdio: 'ignore',
        detached: true,
        windowsHide: true,
        windowsVerbatimArguments: verbatim,
      })
    } catch (e) {
      reject(e as Error)
      return
    }
    // explorer.exe 把窗口交给已经跑着的实例后自己马上退出，不能等 exit；spawn 事件就说明进程起来了
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
    child.once('error', (e) => reject(e))
  })
}

/** 交给系统的文件管理器：目录就是打开它，文件是交给它关联的程序（参数直接传给程序，不经过 shell） */
async function shellOpen(target: string): Promise<void> {
  const cmd = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  await launch(cmd, [target])
}

/** 用系统的文件管理器打开目录；打不开时带着原因抛出，界面要显示出来 */
export async function revealDir(dir: string): Promise<void> {
  try {
    await shellOpen(dir)
  } catch (e) {
    throw new Error(t('没能打开文件夹 {dir}：{error}', { dir, error: (e as Error).message }))
  }
}

/** 可执行的文件不直接打开：点一下附件卡片不该跑起一个程序 */
const RUNNABLE =
  /\.(exe|com|bat|cmd|msi|msc|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|scr|pif|lnk|reg|jar|app|command|sh|run|appimage|desktop)$/i

/** 用系统默认的程序打开文件（参数直接传给程序，不经过 shell）；可执行文件返回 false，不打开 */
export async function openWithSystem(file: string): Promise<boolean> {
  if (RUNNABLE.test(file)) return false
  try {
    await shellOpen(file)
  } catch (e) {
    throw new Error(t('没能用系统默认程序打开 {file}：{error}', { file, error: (e as Error).message }))
  }
  return true
}

/**
 * 打开所在的目录并选中它：装扩展时用户把选中的文件夹直接拖到浏览器的扩展页面上就装好了，
 * 不用在「加载已解压的扩展程序」的窗口里找路径。Linux 的文件管理器没有统一的「选中」参数，只打开上一级
 */
export async function revealItem(dir: string): Promise<void> {
  const [cmd, args] =
    process.platform === 'win32'
      ? // 路径带空格时 explorer 要的是 /select,"路径"，Node 默认会把整个参数加引号，所以原样传
        ['explorer.exe', [`/select,"${dir}"`]]
      : process.platform === 'darwin'
        ? ['open', ['-R', dir]]
        : ['xdg-open', [path.dirname(dir)]]
  try {
    await launch(cmd, args, process.platform === 'win32')
  } catch (e) {
    throw new Error(t('没能在文件夹中显示 {dir}：{error}', { dir, error: (e as Error).message }))
  }
}
