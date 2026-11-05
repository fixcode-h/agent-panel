/**
 * 视频截帧用的 FFmpeg：找可执行文件、按需下载、跑一次命令。
 *
 * 找的顺序：环境变量 AGENT_PANEL_FFMPEG → 用户在弹窗里填的路径（数据目录 video/config.json）
 * → 面板下载的那份（数据目录 video/ffmpeg[.exe]）→ PATH 里的 ffmpeg。
 * 下载用 ffmpeg-static 发布的各平台单文件（GPL，作为独立程序调用，不打进面板的安装包），见 shared/video.ts。
 *
 * 所有调用都只读原视频：输出一律写到数据目录或从 stdout 拿，命令里不会出现把原视频当输出的参数。
 */
import { spawn } from 'node:child_process'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { chmod, mkdir, rename, rm } from 'node:fs/promises'
import { arch, platform } from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { t } from '../../shared/i18n.ts'
import { ffmpegDownloadUrl, ffmpegVersion, type FfmpegStatus } from '../../shared/video.ts'
import { downloadFile, removeDownload } from '../download.ts'
import { log } from '../log.ts'
import { DATA_DIR, readJson, writeJsonAtomic } from '../store.ts'

const isWin = process.platform === 'win32'
export const videoDir = () => path.join(DATA_DIR, 'video')
const configFile = () => path.join(videoDir(), 'config.json')
const downloaded = () => path.join(videoDir(), isWin ? 'ffmpeg.exe' : 'ffmpeg')

/** 一次 FFmpeg 的结果：stdout 原样（帧图片、灰度流），stderr 是文字（探测信息、showinfo） */
export interface FfmpegResult {
  code: number | null
  stdout: Buffer
  stderr: string
  error?: string
}

/** 跑一次 ffmpeg：超时、取消都会结束进程；stdout 太大（超过 maxOut）时也结束，免得读爆内存 */
export function runFfmpeg(
  bin: string,
  args: string[],
  o: { timeoutMs?: number; signal?: AbortSignal; maxOut?: number } = {},
): Promise<FfmpegResult> {
  return new Promise((resolve) => {
    const out: Buffer[] = []
    let outLen = 0
    let err = ''
    let done = false
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(bin, ['-hide_banner', '-nostdin', ...args], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e) {
      return resolve({ code: null, stdout: Buffer.alloc(0), stderr: '', error: (e as Error).message })
    }
    const finish = (r: Partial<FfmpegResult>) => {
      if (done) return
      done = true
      clearTimeout(timer)
      o.signal?.removeEventListener('abort', onAbort)
      resolve({ code: null, stdout: Buffer.concat(out), stderr: err, ...r })
    }
    const kill = (why: string) => {
      try {
        child.kill('SIGKILL')
      } catch {}
      finish({ error: why })
    }
    const timer = setTimeout(() => kill(t('FFmpeg 处理超时')), o.timeoutMs ?? 60_000)
    const onAbort = () => kill(t('已取消'))
    o.signal?.addEventListener('abort', onAbort)
    child.stdout?.on('data', (b: Buffer) => {
      outLen += b.length
      if (o.maxOut && outLen > o.maxOut) return kill(t('FFmpeg 输出太大'))
      out.push(b)
    })
    // stderr 只留最后 1 MB：showinfo 每帧一行，长视频会很多
    child.stderr?.on('data', (b: Buffer) => {
      err += b.toString('utf8')
      if (err.length > 1_000_000) err = err.slice(-1_000_000)
    })
    child.on('error', (e) => finish({ error: e.message }))
    child.on('close', (code) => finish({ code }))
  })
}

async function readConfig(): Promise<{ ffmpeg?: string; mirror?: boolean }> {
  const raw = await readJson(configFile())
  return raw && typeof raw === 'object' ? (raw as { ffmpeg?: string; mirror?: boolean }) : {}
}

/** 记住用户填的 ffmpeg 路径（填空清掉） */
export async function setFfmpegPath(p: string) {
  const cfg = await readConfig()
  await mkdir(videoDir(), { recursive: true })
  await writeJsonAtomic(configFile(), { ...cfg, ffmpeg: p.trim() })
  cached = undefined
}

/** 能跑起来的才算：跑一次 -version 拿版本号 */
async function tryBin(bin: string) {
  const r = await runFfmpeg(bin, ['-version'], { timeoutMs: 8000 })
  const version = r.code === 0 ? ffmpegVersion(r.stdout.toString('utf8')) : ''
  return version ? { path: bin, version } : null
}

let cached: { path: string; version: string } | null | undefined

/** 找可用的 ffmpeg；找不到返回 null。结果记在内存里，下载完、改路径后清掉重找 */
export async function findFfmpeg(): Promise<{ path: string; version: string } | null> {
  if (cached !== undefined) return cached
  const cfg = await readConfig()
  const list = [process.env.AGENT_PANEL_FFMPEG, cfg.ffmpeg, downloaded(), 'ffmpeg'].filter(
    (x): x is string => !!x?.trim(),
  )
  for (const bin of list) {
    // 绝对路径先看文件在不在，省得每个都起一次进程
    if (path.isAbsolute(bin) && !existsSync(bin)) continue
    const hit = await tryBin(bin)
    if (hit) return (cached = hit)
  }
  return (cached = null)
}

/** 要用 ffmpeg 的地方调它：没有时抛出能直接给用户看的错误 */
export async function ffmpegBin() {
  const hit = await findFfmpeg()
  if (!hit) throw new Error(t('没有找到 FFmpeg：在截帧弹窗里下载一份，或者填上本机 ffmpeg 的路径'))
  return hit.path
}

let job: (NonNullable<FfmpegStatus['job']> & { abort?: AbortController }) | undefined

export async function ffmpegStatus(): Promise<FfmpegStatus> {
  const hit = await findFfmpeg()
  return {
    path: hit?.path ?? '',
    version: hit?.version ?? '',
    downloadable: !!ffmpegDownloadUrl(platform(), arch(), false),
    job: job ? { done: job.done, total: job.total, error: job.error, running: job.running } : undefined,
  }
}

/** 下载 ffmpeg 到数据目录：后台进行，进度从 ffmpegStatus 看 */
export function downloadFfmpeg(mirror: boolean) {
  if (job?.running) return
  const url = ffmpegDownloadUrl(platform(), arch(), mirror)
  if (!url) throw new Error(t('这台电脑的系统没有现成的 FFmpeg 可以下载，请自己安装后填上路径'))
  const abort = new AbortController()
  const cur: NonNullable<typeof job> = { done: 0, total: 0, running: true, abort }
  job = cur
  const gz = `${downloaded()}.gz`
  void (async () => {
    try {
      await downloadFile(url, gz, {
        signal: abort.signal,
        onTotal: (n) => (cur.total = n),
        onBytes: (n) => (cur.done += n),
      })
      const tmp = `${downloaded()}.tmp`
      await pipeline(createReadStream(gz), createGunzip(), createWriteStream(tmp))
      if (!isWin) await chmod(tmp, 0o755)
      await rename(tmp, downloaded())
      await rm(gz, { force: true })
      cached = undefined
      if (!(await findFfmpeg())) throw new Error(t('下载的 FFmpeg 运行不起来'))
      cur.running = false
    } catch (e) {
      cur.running = false
      cur.error = (e as Error).message
      log.warn('video', '下载 FFmpeg 失败', { url, error: cur.error })
      await removeDownload(gz).catch(() => {})
    }
  })()
}

export function cancelFfmpegDownload() {
  job?.abort?.abort()
}
