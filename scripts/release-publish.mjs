#!/usr/bin/env node
/**
 * 发布 GitHub Release：创建 release、上传产物，并对瞬时失败重试。
 *
 * 为什么要重试：出包 run 40292001333（v0.28.1419）在 `gh release create` 上撞到 GitHub API 的 HTTP 504
 * （"We couldn't respond to your request in time"），一次瞬时故障就让整个出包 workflow 失败，
 * 而前面的检查、出包和更新说明都已经通过。
 *
 * 504 的语义是「服务端处理超时」，资源可能已经创建成功，所以每次重试前先 `gh release view` 确认：
 * 已存在就当作成功（并在日志里写清楚），不存在才重新创建；已存在但产物不全时用 `gh release upload --clobber` 补齐。
 *
 * 只重试瞬时错误：HTTP 5xx、请求超时、连接层错误。4xx（tag 已存在、权限不足、参数不对）重试只会拿到同样结果，
 * 直接失败并保留原始报错。
 *
 * 用法：node scripts/release-publish.mjs <版本号> --target <sha> --notes-file <路径> --asset <文件> [--asset <文件> ...]
 */
import { spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 重试等待（指数退避）：第一次失败等 5s，第二次 15s，第三次 30s；加上首次一共最多 4 次尝试 */
export const RETRY_DELAYS_MS = [5000, 15000, 30000]

/**
 * 可以重试的错误：GitHub 5xx、请求超时、连接层错误。
 * 这里不列 4xx：tag 已存在（422）、权限不对（403）、参数错（422）重试结果一样，交给调用方直接失败。
 */
const RETRYABLE_PATTERNS = [
  /\bHTTP 5\d\d\b/i,
  /couldn't respond to your request in time/i, // 504 的响应正文
  /\b(?:timeout|timed out|ETIMEDOUT)\b/i,
  /\b(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|EAI_AGAIN|ENOTFOUND|EPIPE|EHOSTUNREACH|ENETUNREACH)\b/i,
  /socket hang up|connection reset|connection refused|network is unreachable|transport is closing|unexpected EOF/i,
  // gh 是 Go 写的，网络和超时的报错是 Go 的文本，不是上面那些 Node 的 errno 名：
  // 例如 `dial tcp: lookup api.github.com: no such host`、`context deadline exceeded`
  /no such host|context deadline exceeded|i\/o timeout|TLS handshake timeout|http2: /i,
]

/** `gh release view` 找不到 release 时的报错；只有这种情况才代表「上一次没建成」 */
const NOT_FOUND = /release not found/i

export function isRetryableError(text) {
  return RETRYABLE_PATTERNS.some((re) => re.test(text ?? ''))
}

/** release 已存在时缺哪些产物：名字或字节数对不上都算缺（上传中途失败会留下不完整的同名资产） */
export function missingAssets(expected, uploaded) {
  const have = new Map(uploaded.map((a) => [a.name, a.size]))
  return expected.filter((a) => have.get(a.name) !== a.size)
}

const defaultStatSize = (file) => statSync(file).size

/** 本地要发布的产物：文件名 + 字节数，用来和 gh 返回的资产比对 */
const describeAssets = (assets, statSize) =>
  assets.map((file) => {
    try {
      return { file, name: path.basename(file), size: statSize(file) }
    } catch {
      throw new Error(`产物文件不存在或读不到：${file}`)
    }
  })

/** 版本号可能已经带 v 前缀（人手动跑时），统一成标签名 */
export function toTag(version) {
  const v = String(version ?? '').trim()
  return v.startsWith('v') ? v : `v${v}`
}

const firstLine = (text) =>
  String(text ?? '')
    .trim()
    .split('\n')[0] ?? ''

const defaultExec = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' })
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 跑一条 gh 命令；命令不存在、被信号杀掉这类情况也统一成返回值，便于按错误文本判断要不要重试 */
async function runGh(exec, args) {
  try {
    const r = await exec('gh', args)
    // 被信号杀掉（例如 CI 内存不足）时 status 是 null、signal 有值，不能当成成功
    if (r?.status === null && r?.signal) {
      return { ok: false, status: 1, stdout: '', stderr: `gh 被信号 ${r.signal} 终止` }
    }
    const status = r?.status ?? (r?.error ? 1 : 0)
    return { ok: status === 0, status, stdout: r?.stdout ?? '', stderr: r?.stderr ?? r?.error?.message ?? '' }
  } catch (e) {
    return { ok: false, status: 1, stdout: '', stderr: e?.message ?? String(e) }
  }
}

/** gh 返回 `资产名\t字节数`，用 `@tsv` 一次拿到两者 */
const ASSET_JQ = '.assets[] | [.name, .size] | @tsv'

/** release 是否已存在、已有哪些产物。查询本身失败时把错误交回调用方，不在这里猜 */
async function viewRelease(exec, tag) {
  const r = await runGh(exec, ['release', 'view', tag, '--json', 'assets', '--jq', ASSET_JQ])
  if (r.ok) {
    const assets = String(r.stdout)
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((line) => {
        const [name, size] = line.split('\t')
        return { name, size: Number(size) }
      })
    return { exists: true, assets }
  }
  if (NOT_FOUND.test(r.stderr)) return { exists: false }
  return { exists: false, error: r.stderr }
}

const createArgs = (tag, assets, { target, notesFile }) => [
  'release',
  'create',
  tag,
  ...assets,
  ...(target ? ['--target', target] : []),
  '--title',
  tag,
  ...(notesFile ? ['--notes-file', notesFile] : []),
  '--latest',
]

/**
 * 发布一个版本。返回这次做了什么，便于调用方和用例断言：
 * - created: 这次真的调了 `gh release create` 并成功
 * - existed: release 早就存在（产物齐全，或补齐了缺的那几个）
 * - uploaded: 这次补齐的产物文件名
 */
export async function publishRelease({
  version,
  assets,
  target,
  notesFile,
  exec = defaultExec,
  sleep = defaultSleep,
  log = console.log,
  statSize = defaultStatSize,
}) {
  const tag = toTag(version)
  if (!assets?.length) throw new Error('至少要给一个产物文件（--asset）')
  const expected = describeAssets(assets, statSize)

  let lastError = ''
  /** 一次「查询 → 创建 / 补齐」算一轮；失败可重试时进入下一轮 */
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      const waitMs = RETRY_DELAYS_MS[attempt - 1]
      log(
        `发布 ${tag} 失败（${firstLine(lastError)}），${waitMs / 1000} 秒后第 ${attempt} 次重试；` +
          '重试前先查一次 release 是不是其实已经建出来了',
      )
      await sleep(waitMs)
    }

    const view = await viewRelease(exec, tag)
    if (view.error) {
      lastError = view.error
      // 连查询都因为瞬时错误失败时，不能冒然 create（可能建出重复的），等下一轮再查
      if (isRetryableError(lastError) && attempt < RETRY_DELAYS_MS.length) continue
      throw new Error(`查询 release ${tag} 失败，无法确认是否已发布：\n${lastError.trim()}`)
    }

    if (view.exists) {
      // 504 之后可能其实已经建成；也可能之前就发布过。两种都按「已存在」处理，但要在日志里说清楚
      const missing = missingAssets(expected, view.assets)
      if (!missing.length) {
        log(`release ${tag} 已经存在，产物齐全（${expected.map((a) => a.name).join('、')}），不重复创建`)
        return { tag, created: false, existed: true, uploaded: [] }
      }
      const missingNames = missing.map((a) => a.name)
      log(`release ${tag} 已经存在，但缺少产物：${missingNames.join('、')}；用 gh release upload --clobber 补齐`)
      const upload = await runGh(exec, ['release', 'upload', tag, ...missing.map((a) => a.file), '--clobber'])
      if (upload.ok) {
        log(`已补齐 ${tag} 的产物：${missingNames.join('、')}`)
        return { tag, created: false, existed: true, uploaded: missingNames }
      }
      lastError = upload.stderr
      if (isRetryableError(lastError) && attempt < RETRY_DELAYS_MS.length) continue
      throw new Error(`补齐 release ${tag} 的产物失败：\n${lastError.trim()}`)
    }

    log(`release ${tag} 不存在，创建并上传 ${assets.length} 个产物`)
    const created = await runGh(exec, createArgs(tag, assets, { target, notesFile }))
    if (created.ok) {
      log(`已发布 ${tag}${created.stdout.trim() ? `：${created.stdout.trim()}` : ''}`)
      return { tag, created: true, existed: false, uploaded: [] }
    }
    lastError = created.stderr
    if (!isRetryableError(lastError)) {
      throw new Error(`发布 ${tag} 失败（不是瞬时错误，不重试）：\n${lastError.trim()}`)
    }
  }

  throw new Error(`发布 ${tag} 失败：重试 ${RETRY_DELAYS_MS.length} 次后仍然失败：\n${lastError.trim()}`)
}

export function parseArgs(argv) {
  const opts = { assets: [] }
  let i = 0
  const value = (name) => {
    const v = argv[++i]
    // 下一个是别的 flag 时说明这个参数没给值，不能把它当成值收下
    if (v === undefined || v.startsWith('--')) throw new Error(`${name} 缺少值`)
    return v
  }
  for (; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--asset') opts.assets.push(value(a))
    else if (a === '--target') opts.target = value(a)
    else if (a === '--notes-file') opts.notesFile = value(a)
    else if (!opts.version) opts.version = a
    else throw new Error(`不认识的参数：${a}`)
  }
  return opts
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  try {
    const { version, target, notesFile, assets } = parseArgs(process.argv.slice(2))
    if (!version)
      throw new Error(
        '用法：node scripts/release-publish.mjs <版本号> --target <sha> --notes-file <路径> --asset <文件>',
      )
    await publishRelease({ version, assets, target, notesFile })
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }
}
