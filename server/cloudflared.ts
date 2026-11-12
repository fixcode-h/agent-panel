import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, mkdir, open, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { t } from '../shared/i18n.ts'
import { DATA_DIR } from './store.ts'
import { netFetch } from './net.ts'
import { log } from './log.ts'

/**
 * 把 cloudflared 下载到数据目录的 bin/：「授权外部工具」里给 Agent 用的 cloudflared 没装时走这里。
 * 以前和外部访问的 Cloudflare 隧道放在 remote.ts，外部访问改成密码登录 + 反向代理后隧道去掉了，下载留给授权用
 */
const execFileAsync = promisify(execFile)
const isWin = process.platform === 'win32'
const BIN = path.join(DATA_DIR, 'bin')
const BIN_FILE = path.join(BIN, isWin ? 'cloudflared.exe' : 'cloudflared')
let download: { running: boolean; percent: number; error: string } | null = null // 模块状态：会话，跟着进程或连接一起没

/** 下载 cloudflared：Windows / Linux 下直接放二进制，macOS 下载后解压 */
function asset() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
  if (isWin) return { name: `cloudflared-windows-${arch}.exe`, tgz: false }
  if (process.platform === 'linux') return { name: `cloudflared-linux-${arch}`, tgz: false }
  if (process.platform === 'darwin') return { name: `cloudflared-darwin-${arch}.tgz`, tgz: true }
  return undefined
}

async function downloadFile(from: string, to: string, onPercent: (n: number) => void, signal: AbortSignal) {
  const res = await netFetch(from, { signal })
  if (!res.ok || !res.body) throw new Error(t('下载失败（{status}）：{url}', { status: String(res.status), url: from }))
  const total = Number(res.headers.get('content-length') ?? 0)
  let got = 0
  onPercent(-1)
  const body = Readable.fromWeb(res.body as never)
  body.on('data', (c: Buffer) => {
    got += c.length
    onPercent(total ? Math.min(100, Math.round((got / total) * 100)) : -1)
  })
  const part = `${to}.part`
  await mkdir(path.dirname(to), { recursive: true })
  await pipeline(body, createWriteStream(part), { signal })
  await rename(part, to)
}

/** 小于这个大小的不可能是 cloudflared（正常 20–50 MB）：多半是被代理、门户页换成了一段 HTML */
const MIN_BINARY_BYTES = 5 * 1024 * 1024

/**
 * 文件头是不是这个系统能跑的可执行文件：Windows 是 PE（MZ），Linux 是 ELF，macOS 是 Mach-O（含通用二进制）。
 * 只看文件头，返回给用户看的原因，通过时返回空字符串
 */
export function binaryProblem(head: Buffer, size: number, platform: NodeJS.Platform): string {
  if (size < MIN_BINARY_BYTES) return t('下载的 cloudflared 只有 {n} 字节，不是完整的程序', { n: String(size) })
  const magic = head.subarray(0, 4).toString('hex')
  const ok =
    platform === 'win32'
      ? head.subarray(0, 2).toString('latin1') === 'MZ'
      : platform === 'linux'
        ? magic === '7f454c46'
        : platform === 'darwin'
          ? ['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe'].includes(magic)
          : false
  return ok ? '' : t('下载的 cloudflared 不是这个系统能运行的程序（文件头 {magic}）', { magic })
}

/**
 * 下载完的 cloudflared 先核对再用：cloudflared 的 GitHub Release 没有可以离线核对的校验文件，
 * 至少确认它是完整大小的、本系统格式的可执行文件，并把 sha256 记进日志，出了问题能对照官方发布页核对
 */
async function verifyBinary(file: string) {
  const fh = await open(file, 'r')
  let head: Buffer
  let size: number
  try {
    size = (await fh.stat()).size
    head = Buffer.alloc(4)
    await fh.read(head, 0, 4, 0)
  } finally {
    await fh.close()
  }
  const why = binaryProblem(head, size, process.platform)
  if (why) throw new Error(why)
  const h = createHash('sha256')
  await pipeline(createReadStream(file), h)
  log.info('integrations', 'cloudflared 文件核对通过', { path: file, bytes: size, sha256: h.digest('hex') })
}

/** 下载 cloudflared 到数据目录；返回错误信息，成功时为空 */
export async function installCloudflared(): Promise<string> {
  if (download?.running) return t('正在下载 cloudflared，稍后再试')
  const a = asset()
  if (!a) {
    download = { running: false, percent: -1, error: t('这个系统不支持自动下载，请手动安装 cloudflared。') }
    return download.error
  }
  download = { running: true, percent: -1, error: '' }
  // 不用解压的直接存成 cloudflared(.exe)：检测只认这个名字
  const file = a.tgz ? path.join(BIN, a.name) : BIN_FILE
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${a.name}`
  try {
    await mkdir(BIN, { recursive: true })
    log.info('integrations', '开始下载 cloudflared', { url })
    await downloadFile(
      url,
      file,
      (n) => {
        if (download) download.percent = n
      },
      AbortSignal.timeout(10 * 60_000),
    )
    if (a.tgz) {
      await execFileAsync('tar', ['-xzf', file, '-C', BIN])
      await rm(file, { force: true })
    }
    // 核对不过就删掉：留着的话下次检测会把这个坏文件当成已装好
    await verifyBinary(BIN_FILE).catch(async (e) => {
      await rm(BIN_FILE, { force: true })
      throw e
    })
    if (!isWin) await chmod(BIN_FILE, 0o755)
    log.info('integrations', 'cloudflared 已下载', { path: BIN_FILE })
  } catch (e) {
    download = { running: false, percent: -1, error: (e as Error).message }
    log.error('integrations', '下载 cloudflared 失败', e)
    return download.error
  }
  download = { running: false, percent: 100, error: '' }
  return ''
}
