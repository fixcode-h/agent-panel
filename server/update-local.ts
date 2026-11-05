/**
 * 用本地安装包升级：用户在「版本更新」里选一个已经下载好的包（离线、GitHub 连不上时用），
 * 这里负责收下文件、解压、确认它是 Agent 面板的包并且适用于这台电脑。
 * 替换程序文件、等任务结束、重启和在线更新走同一套流程（见 update.ts 的 replaceWith）。
 */
import { createWriteStream, existsSync, readFileSync } from 'node:fs'
import { mkdir, open, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { parseVersion } from '../shared/version.ts'
import { capture } from './exec/process.ts'
import { t } from '../shared/i18n.ts'

/** 安装包对应的系统：和 scripts/package.mjs 的 platforms 一致 */
export type PackageOs = 'win' | 'mac' | 'linux'

export const osOf = (platform: string): PackageOs =>
  platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : 'linux'

const OS_NAME: Record<PackageOs, string> = { win: 'Windows', mac: 'macOS', linux: 'Linux' }

/** 这个系统该下哪个包：报「平台不对」时直接告诉用户该换哪个 */
const WANT: Record<PackageOs, string> = {
  win: 'agent-panel-<版本>.zip',
  mac: 'agent-panel-<版本>-mac.tar.gz',
  linux: 'agent-panel-<版本>-linux.tar.gz',
}

/** 看文件头判断压缩格式，不信扩展名：zip 是 PK\x03\x04，tar.gz 是 gzip 的 1f 8b */
export async function archiveKind(file: string): Promise<'zip' | 'tar.gz' | undefined> {
  const fh = await open(file, 'r')
  try {
    const head = Buffer.alloc(4)
    const { bytesRead } = await fh.read(head, 0, 4, 0)
    if (bytesRead >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return 'zip'
    if (bytesRead >= 2 && head[0] === 0x1f && head[1] === 0x8b) return 'tar.gz'
    return undefined
  } finally {
    await fh.close()
  }
}

/**
 * 包是给哪个系统的（scripts/package.mjs 出的三种包）：
 * 顶层目录名带 -mac / -linux 后缀；macOS 包里有 .app；Windows 包里有托盘程序、没有 install-service.sh。
 * 都对不上时返回 undefined：早期不分平台的通用包，三个系统都能用
 */
export function packageOs(top: string, names: string[]): PackageOs | undefined {
  const suffix = /-(mac|linux|win)$/.exec(top)?.[1] as PackageOs | undefined
  if (suffix) return suffix
  if (names.some((n) => n.endsWith('.app'))) return 'mac'
  if (names.includes('AgentPanel.exe') && !names.includes('install-service.sh')) return 'win'
  return undefined
}

/**
 * 解压安装包并确认里面是能装的程序文件，返回程序文件所在的目录。
 * 发布的包里只有一个顶层目录（agent-panel-<版本>[-平台]），程序文件在它下面
 */
export async function extractPackage(file: string, stage: string): Promise<{ src: string; top: string }> {
  await mkdir(stage, { recursive: true })
  // Windows 10 起自带 tar，也能解 zip（bsdtar）；macOS / Linux 都有 tar。两种 tar 都会去掉 ../ 和绝对路径
  const cwd = path.dirname(file)
  const r = await capture('tar', ['-xf', file, '-C', stage], cwd, process.env, 120_000)
  if (r.spawnError || r.code !== 0) {
    // Linux 上的 GNU tar 解不了 zip（用户选了 zip 包时会碰到），换 unzip 再试；unzip 不会写到目标目录外面
    const u =
      (await archiveKind(file)) === 'zip'
        ? await capture('unzip', ['-q', '-o', file, '-d', stage], cwd, process.env, 120_000)
        : undefined
    if (!u || u.spawnError || u.code !== 0)
      throw new Error(t('解压失败：{error}', { error: r.spawnError ?? r.stderr.trim() }))
  }
  // macOS 的「压缩」会多出 __MACOSX，不算顶层目录
  const entries = (await readdir(stage, { withFileTypes: true })).filter((e) => e.name !== '__MACOSX')
  const top = entries.length === 1 && entries[0].isDirectory() ? entries[0].name : ''
  const src = top ? path.join(stage, top) : stage
  if (!existsSync(path.join(src, 'server.mjs')) || !existsSync(path.join(src, 'dist', 'index.html')))
    throw new Error(t('包里缺少 server.mjs 或 dist，可能下载不完整'))
  return { src, top }
}

/** 一个检查过、可以装的本地安装包 */
export interface LocalPackage {
  /** 程序文件所在的目录 */
  src: string
  version: string
  /** 包对应的系统；早期的通用包为空 */
  os?: PackageOs
}

/**
 * 检查用户选的本地安装包：格式、是不是 Agent 面板的包、版本号、是不是这个系统的包。
 * 任何一项不对都报错，不替换任何程序文件
 */
export async function inspectPackage(
  file: string,
  stage: string,
  platform: string = process.platform,
): Promise<LocalPackage> {
  if (!(await archiveKind(file))) throw new Error(t('这不是 Agent 面板的安装包：只支持发布页上的 .zip 和 .tar.gz 包'))
  const { src, top } = await extractPackage(file, stage)
  let pkg: { name?: unknown; version?: unknown }
  try {
    pkg = JSON.parse(readFileSync(path.join(src, 'package.json'), 'utf8'))
  } catch {
    throw new Error(t('包里没有可读的 package.json，不是 Agent 面板的安装包'))
  }
  if (pkg.name !== 'agent-panel')
    throw new Error(t('这不是 Agent 面板的安装包（包名是 {name}）', { name: String(pkg.name ?? '') }))
  const version = typeof pkg.version === 'string' ? pkg.version : ''
  if (!parseVersion(version)) throw new Error(t('安装包里的版本号不对：{version}', { version }))
  const os = packageOs(top, await readdir(src))
  const want = osOf(platform)
  if (os && os !== want)
    throw new Error(
      t('这是 {pkg} 的安装包，当前系统是 {os}，请改选 {name}', {
        pkg: OS_NAME[os],
        os: OS_NAME[want],
        name: WANT[want].replace('<版本>', version),
      }),
    )
  return { src, version, os }
}

/** 把请求体写进文件：安装包可能有几十 MB，边收边写，不整个读进内存 */
export async function saveBody(body: ReadableStream<Uint8Array> | null, file: string) {
  if (!body) throw new Error(t('没有收到安装包'))
  await pipeline(
    Readable.fromWeb(body as import('node:stream/web').ReadableStream<Uint8Array>),
    createWriteStream(file),
  )
}

/** 删掉上次收下但没装的包 */
export const dropStaged = (dir: string | undefined) =>
  dir ? rm(dir, { recursive: true, force: true }).catch(() => {}) : Promise.resolve()
