import { spawn } from 'node:child_process'

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
