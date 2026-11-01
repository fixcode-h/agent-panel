import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { log } from './log.ts'

/**
 * 没人开着设计页时，AI 的 screenshot 也要能出图：用本机已经装好的 Edge / Chrome 无头模式
 * 打开一个只挂截图组件的页面（`#/capture/<设计 id>`，见 web/src/components/design/CaptureHost.tsx）。
 * 这个页面和设计页一样走 /capture/wait 长轮询领截图请求，画图用的是同一个画布组件，
 * 所以出来的图和用户看到的画布一致。不打包浏览器：找不到就返回 false，调用方照旧报「页面没打开」。
 *
 * 一个设计一个浏览器进程，空闲一段时间（默认 2 分钟没有截图请求）自动关掉；面板退出时一起结束。
 */

/** 本机 Chromium 系浏览器的常见安装位置；AGENT_PANEL_BROWSER 可以指定 */
export function findBrowser(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string | undefined {
  if (env.AGENT_PANEL_BROWSER) return existsSync(env.AGENT_PANEL_BROWSER) ? env.AGENT_PANEL_BROWSER : undefined
  const list: string[] = []
  if (platform === 'win32') {
    const pf = [env['PROGRAMFILES(X86)'], env.PROGRAMFILES, env.LOCALAPPDATA].filter(Boolean) as string[]
    for (const base of pf)
      list.push(
        path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      )
  } else if (platform === 'darwin') {
    list.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    )
  } else {
    const dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean)
    for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'])
      for (const d of dirs) list.push(path.join(d, name))
  }
  return list.find((p) => existsSync(p))
}

/** 无头浏览器的启动参数：独立的临时用户目录，不碰用户自己的浏览器配置和登录 */
export function headlessArgs(url: string, profile: string, root = process.getuid?.() === 0) {
  return [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--mute-audio',
    // 后台节流会让长轮询和截图变慢；无头页面本来就没人看
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--window-size=1280,800',
    `--user-data-dir=${profile}`,
    // Linux 上以 root 运行时 Chrome 拒绝开沙箱
    ...(root ? ['--no-sandbox'] : []),
    url,
  ]
}

interface Running {
  proc: ChildProcess
  idle: ReturnType<typeof setTimeout>
}

export class HeadlessPages {
  private running = new Map<string, Running>()
  private idleMs: number
  private browser: () => string | undefined
  private url: (designId: string) => string

  constructor(o: { url: (designId: string) => string; idleMs?: number; browser?: () => string | undefined }) {
    this.url = o.url
    this.idleMs = o.idleMs ?? 120_000
    this.browser = o.browser ?? (() => findBrowser())
    process.on('exit', () => this.closeAll())
  }

  /**
   * 给这个设计开一个看不见的截图页（已经开着就续期）。
   * 返回 false 表示本机找不到可用的浏览器或者被关掉了，调用方按「页面没打开」处理
   */
  ensure(designId: string): boolean {
    if (process.env.AGENT_PANEL_HEADLESS === '0') return false
    const cur = this.running.get(designId)
    if (cur && cur.proc.exitCode === null && !cur.proc.killed) {
      this.touch(designId, cur)
      return true
    }
    const exe = this.browser()
    if (!exe) return false
    const profile = path.join(tmpdir(), 'agent-panel-headless', designId.replace(/[^\w-]/g, '_'))
    let proc: ChildProcess
    try {
      proc = spawn(exe, headlessArgs(this.url(designId), profile), { stdio: 'ignore', windowsHide: true })
    } catch (e) {
      log.warn('headless', '启动无头浏览器失败', { error: (e as Error).message, exe })
      return false
    }
    const r: Running = { proc, idle: setTimeout(() => {}, 0) }
    proc.on('error', (e) => {
      log.warn('headless', '无头浏览器出错', { error: e.message, exe })
      this.forget(designId, r)
    })
    proc.on('exit', () => this.forget(designId, r))
    this.running.set(designId, r)
    this.touch(designId, r)
    log.info('headless', '设计页没有打开，用无头浏览器截图', { designId, exe })
    return true
  }

  close(designId: string) {
    const r = this.running.get(designId)
    if (!r) return
    this.forget(designId, r)
    try {
      r.proc.kill()
    } catch {}
  }

  closeAll() {
    for (const id of [...this.running.keys()]) this.close(id)
  }

  private touch(designId: string, r: Running) {
    clearTimeout(r.idle)
    r.idle = setTimeout(() => this.close(designId), this.idleMs)
    r.idle.unref?.()
  }

  private forget(designId: string, r: Running) {
    clearTimeout(r.idle)
    if (this.running.get(designId) === r) this.running.delete(designId)
  }
}
