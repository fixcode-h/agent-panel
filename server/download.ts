/**
 * 大文件下载：Range 分片并发 + 断点续传。
 *
 * 有的镜像 / CDN 对单条连接限速（实测 hf-mirror 单连接 1.3 MB/s，8 条连接能叠到 9 MB/s），
 * 所以按片并发下载；每片完成的区间记在 `.part.json` 里，中断后再点下载只补没下完的部分。
 * 服务端不支持 Range（不返回 206）时退回单连接流式写入，不能续传但至少能下。
 */
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { t } from '../shared/i18n.ts'
import { netFetch, type NetInit } from './net.ts'
import { readJson } from './store.ts'

/** 和 netFetch 一样用：下载的每处请求都经过它，测试可以替换 */
export type NetFetch = (url: string, init?: NetInit) => Promise<Response>

export interface DownloadOptions {
  /** 已下载的字节数（增量，续传时会先报一次已有的部分）；一片重下时用负数扣回重复的部分 */
  onBytes?: (n: number) => void
  /** 服务端给出的文件总大小 */
  onTotal?: (total: number) => void
  signal?: AbortSignal
  headers?: Record<string, string>
  /** 同时开几条连接，默认 8 */
  connections?: number
  /** 每片多大，默认 16 MB */
  chunkSize?: number
  /** 多久没有收到数据算卡住，默认 45 秒（单连接下载 90 秒）；每次回退到另一条路时重新计时 */
  idleMs?: number
  /** 测试或调用方替换网络请求；默认是带代理回退的 netFetch */
  fetch?: NetFetch
}

const CONNECTIONS = 8
const CHUNK = 16 * 1024 * 1024
const IDLE_MS = 45_000
/** 等响应头的上限：连不上时交给 netFetch 换代理，不用一直挂着 */
const HEAD_TIMEOUT_MS = 20_000
/** 每片最多试几次（连接被重置、读超时这类临时错误重试；4xx 不重试） */
const TRIES = 4

/** 已下载的字节区间，半开：[start, end) */
type Span = [number, number]

interface PartState {
  url: string
  size: number
  etag?: string
  modified?: string
  done: Span[]
}

/** 服务端没按 Range 返回（200）：这批分片作废，改成单连接从头下 */
class NotRanged extends Error {}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

const aborted = () => new Error(t('已取消'))
const failed = (status: number, url: string) => t('下载失败（{status}）：{url}', { status: String(status), url })

/** 把区间插进列表并合并相邻的 */
export function addSpan(list: Span[], add: Span): Span[] {
  const next = [...list, add].sort((a, b) => a[0] - b[0])
  const out: Span[] = []
  for (const [a, b] of next) {
    const last = out[out.length - 1]
    if (last && a <= last[1]) last[1] = Math.max(last[1], b)
    else out.push([a, b])
  }
  return out
}

/** 按 chunk 切开还没下载的部分 */
export function missingSpans(total: number, done: Span[], chunk: number): Span[] {
  const out: Span[] = []
  const cut = (from: number, to: number) => {
    for (let at = from; at < to; at += chunk) out.push([at, Math.min(at + chunk, to)])
  }
  let at = 0
  for (const [a, b] of done) {
    if (a > at) cut(at, a)
    at = Math.max(at, b)
  }
  if (at < total) cut(at, total)
  return out
}

/** 外部取消和「太久没收到数据」合成一个 signal；每收到一块数据调用 reset 重新计时 */
function watch(signal: AbortSignal | undefined, ms: number) {
  const ac = new AbortController()
  let timeout = false
  let timer: NodeJS.Timeout | undefined
  const onAbort = () => ac.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  const reset = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timeout = true
      ac.abort()
    }, ms)
    timer.unref?.()
  }
  reset()
  return {
    signal: ac.signal,
    reset,
    timedOut: () => timeout,
    dispose: () => {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    },
  }
}

/** 一次请求失败该不该重试：连接类错误和 5xx、429 重试，其余直接报错 */
function retryable(e: unknown) {
  if (e instanceof HttpError) return e.status === 429 || e.status >= 500
  return true
}

/** 打开（不截断）或新建 `.part`：不能用 'a'，O_APPEND 会让指定位置写入失效 */
async function openPart(part: string) {
  try {
    return await open(part, 'r+')
  } catch {
    return await open(part, 'w+')
  }
}

/**
 * 探测服务端：小请求确认是否支持 Range、文件多大、版本标识（变了说明文件被替换，旧的分片作废）
 */
async function probe(url: string, headers: Record<string, string>, signal: AbortSignal | undefined, fetcher: NetFetch) {
  const res = await fetcher(url, {
    headers: { ...headers, Range: 'bytes=0-0' },
    signal,
    timeoutMs: HEAD_TIMEOUT_MS,
  })
  if (!res.ok) throw new HttpError(res.status, failed(res.status, url))
  const contentRange = res.headers.get('content-range') ?? ''
  const total = Number(/\/\s*(\d+)\s*$/.exec(contentRange)?.[1] ?? res.headers.get('content-length')) || 0
  const out = {
    ranged: res.status === 206 && /\/\d+\s*$/.test(contentRange),
    total,
    etag: res.headers.get('etag') ?? undefined,
    modified: res.headers.get('last-modified') ?? undefined,
  }
  await res.body?.cancel().catch(() => {})
  return out
}

async function readState(file: string) {
  // 读不到、坏了、内容不对都当作没下过；坏文件由 readJson 归档到 cache/broken，下次从头下
  const s = (await readJson(file).catch(() => undefined)) as PartState | undefined
  return s && typeof s.size === 'number' && Array.isArray(s.done) ? s : undefined
}

async function writeState(file: string, state: PartState) {
  await writeFile(`${file}.tmp`, JSON.stringify(state))
  await rename(`${file}.tmp`, file)
}

/** 单连接流式下载：服务端不支持 Range 时用，从 0 覆盖写 */
async function stream(
  url: string,
  part: string,
  headers: Record<string, string>,
  o: DownloadOptions,
  fetcher: NetFetch,
) {
  const idle = watch(o.signal, o.idleMs ?? IDLE_MS * 2)
  try {
    const res = await fetcher(url, {
      headers,
      signal: idle.signal,
      timeoutMs: HEAD_TIMEOUT_MS,
      // 回退到另一条路时重新计时，空闲预算只管这一条路上多久没数据
      onAttempt: () => idle.reset(),
    })
    if (!res.ok || !res.body) throw new HttpError(res.status, failed(res.status, url))
    const total = Number(res.headers.get('content-length')) || 0
    if (total) o.onTotal?.(total)
    const body = Readable.fromWeb(res.body as never)
    body.on('data', (c: Buffer) => {
      idle.reset()
      o.onBytes?.(c.length)
    })
    await pipeline(body, createWriteStream(part, { flags: 'w' }), { signal: idle.signal })
  } catch (e) {
    if (o.signal?.aborted) throw aborted()
    if (idle.timedOut()) throw new Error(t('下载速度太慢，连接超时了，请重试'))
    throw e
  } finally {
    idle.dispose()
  }
}

/** 下载一片；失败时把这一片已经报过的进度扣回去（重试会整片重下） */
async function fetchSpan(
  url: string,
  fh: Awaited<ReturnType<typeof openPart>>,
  [start, end]: Span,
  headers: Record<string, string>,
  ac: AbortController,
  idleMs: number,
  onBytes: (n: number) => void,
  fetcher: NetFetch,
) {
  const want = end - start
  const idle = watch(ac.signal, idleMs)
  let written = 0
  try {
    const res = await fetcher(url, {
      headers: { ...headers, Range: `bytes=${start}-${end - 1}` },
      signal: idle.signal,
      timeoutMs: HEAD_TIMEOUT_MS,
      onAttempt: () => idle.reset(),
    })
    if (res.status === 200) throw new NotRanged('服务端忽略了 Range')
    if (res.status !== 206) throw new HttpError(res.status, failed(res.status, url))
    if (!res.body || !(res.headers.get('content-range') ?? '').startsWith(`bytes ${start}-`))
      throw new Error(t('下载没有返回分段数据：{url}', { url }))
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      idle.reset()
      if (written + chunk.length > want) throw new Error(t('下载的数据比要求的多：{url}', { url }))
      const { bytesWritten } = await fh.write(chunk, 0, chunk.length, start + written)
      if (bytesWritten !== chunk.length) throw new Error(t('写入文件失败（{url}）', { url }))
      written += bytesWritten
      onBytes(bytesWritten)
    }
    if (written !== want)
      throw new Error(t('下载不完整（{got}/{want} 字节）：{url}', { got: String(written), want: String(want), url }))
  } catch (e) {
    if (written) onBytes(-written)
    throw e
  } finally {
    idle.dispose()
  }
}

/**
 * 下载 url 到 to：先写 `${to}.part`，完成后改名。
 * 中断后再次调用会接着下（`.part` 或 `.part.json` 在就可以续）；服务端不支持 Range 时从头单连接下。
 */
export async function downloadFile(url: string, to: string, o: DownloadOptions = {}) {
  await mkdir(path.dirname(to), { recursive: true })
  const part = `${to}.part`
  const meta = `${part}.json`
  const headers = o.headers ?? {}
  const connections = Math.max(1, o.connections ?? CONNECTIONS)
  const chunk = Math.max(64 * 1024, o.chunkSize ?? CHUNK)
  const idleMs = o.idleMs ?? IDLE_MS
  const fetcher = o.fetch ?? netFetch
  /** 这个文件已经报给调用方的净进度；退回单连接时要扣回去 */
  let reported = 0
  const report = (n: number) => {
    reported += n
    if (n) o.onBytes?.(n)
  }

  const info = await probe(url, headers, o.signal, fetcher)
  if (o.signal?.aborted) throw aborted()
  if (info.total) o.onTotal?.(info.total)
  if (!info.ranged || !info.total) {
    await rm(meta, { force: true })
    await stream(url, part, headers, { ...o, onBytes: report }, fetcher)
    await rename(part, to)
    return
  }

  const total = info.total
  const hasPart = existsSync(part)
  const state = await readState(meta)
  let done: Span[] = []
  if (state && hasPart && state.url === url && state.size === total) {
    // 文件被换过（etag / 修改时间变了）就重下，不然拼出来是新旧混杂的文件
    const same =
      (!state.etag || !info.etag || state.etag === info.etag) &&
      (!state.modified || !info.modified || state.modified === info.modified)
    if (same) done = state.done.filter(([a, b]) => a >= 0 && b <= total && a < b).reduce(addSpan, [])
  }
  // 没有状态文件时按旧版连续 .part 处理：它的长度就是已经下好的前缀
  if (!done.length && hasPart) {
    const have = (await stat(part)).size
    if (have >= total) {
      // 旧版下完没来得及改名，或者分片已经全下完：大小够了就当完成
      await rm(meta, { force: true })
      await rename(part, to)
      return
    }
    if (have > 0) {
      done = [[0, have]]
      report(have)
    }
  }

  const jobs = missingSpans(total, done, chunk)
  if (!jobs.length) {
    await rm(meta, { force: true })
    await rename(part, to)
    return
  }

  const ac = new AbortController()
  const onAbort = () => ac.abort()
  o.signal?.addEventListener('abort', onAbort, { once: true })
  const fh = await openPart(part)
  let failure: unknown
  let lastWrite = Date.now()
  const save = async () => {
    await writeState(meta, { url, size: total, etag: info.etag, modified: info.modified, done: [...done] }).catch(
      () => {},
    )
    lastWrite = Date.now()
  }
  let next = 0
  const worker = async () => {
    while (!failure) {
      const i = next++
      if (i >= jobs.length) return
      const span = jobs[i]
      for (let attempt = 1; ; attempt++) {
        if (failure || ac.signal.aborted) return
        try {
          await fetchSpan(url, fh, span, headers, ac, idleMs, report, fetcher)
          done = addSpan(done, span)
          // 每片都写状态，进程被杀只丢正在下的几片；但不用每片都落盘
          if (i === jobs.length - 1 || Date.now() - lastWrite > 1000) await save()
          break
        } catch (e) {
          if (e instanceof NotRanged) {
            failure = e
            ac.abort()
            return
          }
          if (o.signal?.aborted) {
            failure = aborted()
            ac.abort()
            return
          }
          // 别的分片已经失败：这一片不用再试，保留那个错误
          if (failure) return
          if (attempt >= TRIES || !retryable(e)) {
            failure = e
            ac.abort()
            return
          }
          await new Promise((r) => setTimeout(r, Math.min(500 * 2 ** (attempt - 1), 4000)))
        }
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(connections, jobs.length) }, worker))
  } finally {
    o.signal?.removeEventListener('abort', onAbort)
    await fh.close().catch(() => {})
  }

  if (failure instanceof NotRanged) {
    // 中途有分片没按 Range 返回：整份文件从头单连接下，已经报过的进度扣回去
    report(-reported)
    await rm(meta, { force: true })
    await stream(url, part, headers, { ...o, onBytes: report }, fetcher)
    await rename(part, to)
    return
  }
  if (failure) {
    await save()
    if (o.signal?.aborted) throw aborted()
    throw failure
  }
  await save()
  // 分片写入不预先占位，最后按总大小截断（旧文件更大时多余的部分也去掉）
  const out = await openPart(part)
  await out.truncate(total)
  await out.close()
  await rename(part, to)
  await rm(meta, { force: true })
}

/** 删掉下载中的临时文件（删除模型、清理时用） */
export async function removeDownload(to: string) {
  await rm(`${to}.part`, { force: true })
  await rm(`${to}.part.json`, { force: true })
  await rm(`${to}.part.json.tmp`, { force: true })
}
