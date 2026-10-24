import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setLang, t } from '../shared/i18n.ts'

// 设置模块会读数据目录，用临时的别碰本机
process.env.AGENT_PANEL_DATA = await mkdtemp(path.join(tmpdir(), 'agent-panel-download-data-'))
const { addSpan, downloadFile, missingSpans, removeDownload } = await import('./download.ts')
const { netFetch } = await import('./net.ts')
setLang('zh')

/** 可重复的内容，方便逐字节比对 */
function content(size: number) {
  const b = Buffer.alloc(size)
  for (let i = 0; i < size; i++) b[i] = (i * 37 + 11) % 256
  return b
}

interface ServeOptions {
  /** 是否支持 Range，默认支持 */
  range?: boolean
  /** 每块数据之间的延迟，模拟慢速连接 */
  delay?: number
  /** 只延迟起点大于 0 的分片：第一片先下完，便于测取消后续传 */
  slowAfterFirst?: boolean
  /** 第一次带 Range 的请求发一半就断开，模拟网络抖动 */
  dropFirst?: boolean
}

async function serve(body: Buffer, o: ServeOptions = {}) {
  const ranges: (string | undefined)[] = []
  let dropped = false
  const server = createServer(async (req, res) => {
    ranges.push(req.headers.range)
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
    if (o.range === false || !m) {
      res.writeHead(200, { 'Content-Length': body.length })
      res.end(body)
      return
    }
    const start = Number(m[1])
    const end = m[2] ? Number(m[2]) : body.length - 1
    const slice = body.subarray(start, end + 1)
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${body.length}`, 'Content-Length': slice.length })
    if (o.dropFirst && !dropped && req.headers.range !== 'bytes=0-0') {
      dropped = true
      res.write(slice.subarray(0, Math.max(1, slice.length >> 1)))
      setTimeout(() => res.destroy(), 10)
      return
    }
    const delay = o.slowAfterFirst && start > 0 ? 5 : (o.delay ?? 0)
    if (!delay) {
      res.end(slice)
      return
    }
    // 一次发 4 KB，中间停一下，让取消能落在传输过程中
    for (let at = 0; at < slice.length; at += 4096) {
      if (res.destroyed) return
      res.write(slice.subarray(at, at + 4096))
      await new Promise((r) => setTimeout(r, delay))
    }
    res.end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  return {
    url: `http://127.0.0.1:${port}/file.bin`,
    ranges,
    close: () => {
      server.closeAllConnections()
      return new Promise<void>((r) => server.close(() => r()))
    },
  }
}

const dir = await mkdtemp(path.join(tmpdir(), 'agent-panel-download-'))
const out = (name: string) => path.join(dir, name)

test('分片并发下载：拼出来的文件和服务端一致，进度是完整大小', async () => {
  const body = content(512 * 1024)
  const s = await serve(body)
  try {
    const to = out('a.bin')
    let got = 0
    let total = 0
    await downloadFile(s.url, to, {
      chunkSize: 64 * 1024,
      connections: 3,
      onBytes: (n) => (got += n),
      onTotal: (n) => (total = n),
    })
    assert.ok((await readFile(to)).equals(body))
    assert.equal(got, body.length)
    assert.equal(total, body.length)
    // 探测 1 个 + 8 个分片
    assert.equal(s.ranges.filter((r) => r !== 'bytes=0-0').length, 8)
    assert.ok(!existsSync(`${to}.part`) && !existsSync(`${to}.part.json`))
  } finally {
    await s.close()
  }
})

test('旧版连续 .part 接着下，不从头重来', async () => {
  const body = content(512 * 1024)
  const s = await serve(body)
  try {
    const to = out('b.bin')
    const have = 200 * 1024
    await writeFile(`${to}.part`, body.subarray(0, have))
    let got = 0
    await downloadFile(s.url, to, { chunkSize: 64 * 1024, connections: 2, onBytes: (n) => (got += n) })
    assert.ok((await readFile(to)).equals(body))
    assert.equal(got, body.length)
    assert.ok(!s.ranges.some((r) => r?.startsWith('bytes=0-') && r !== 'bytes=0-0'), '不从 0 重新下')
    assert.ok(
      s.ranges.some((r) => r?.startsWith(`bytes=${have}-`)),
      '从旧 .part 的末尾接着下',
    )
  } finally {
    await s.close()
  }
})

test('服务端不支持 Range 时退回单连接，文件同样完整', async () => {
  const body = content(300 * 1024)
  const s = await serve(body, { range: false })
  try {
    const to = out('c.bin')
    let got = 0
    const timeouts: number[] = []
    await downloadFile(s.url, to, {
      onBytes: (n) => (got += n),
      fetch: (url, init) => {
        timeouts.push(init?.timeoutMs ?? 0)
        // 探测没有空闲计时，不需要 onAttempt；真正下载的请求必须带
        const headers = init?.headers as Record<string, string> | undefined
        if (headers?.Range !== 'bytes=0-0')
          assert.equal(typeof init?.onAttempt, 'function', '下载请求要能通知下载层重置空闲计时')
        return netFetch(url, init)
      },
    })
    assert.ok((await readFile(to)).equals(body))
    assert.equal(got, body.length)
    assert.ok(!existsSync(`${to}.part.json`), '不支持 Range 时不留分片状态')
    // 探测 + 单连接下载：stream 也要经过统一入口并带响应头超时，少一处直连超时就不会换代理
    assert.equal(timeouts.length, 2)
    assert.deepEqual(new Set(timeouts), new Set([20_000]))
  } finally {
    await s.close()
  }
})

test('下载中断后可以续传：只补没下完的分片', async () => {
  const body = content(512 * 1024)
  const s = await serve(body, { slowAfterFirst: true })
  try {
    const to = out('d.bin')
    const ac = new AbortController()
    let got = 0
    await assert.rejects(
      downloadFile(s.url, to, {
        chunkSize: 64 * 1024,
        connections: 1,
        onBytes: (n) => {
          got += n
          // 第一片下完、第二片传到一半再取消：这样可以验证第一片被留下来
          if (got >= 100 * 1024) ac.abort()
        },
        signal: ac.signal,
      }),
      (e: Error) => e.message === t('已取消'),
    )
    assert.ok(existsSync(`${to}.part.json`), '中断时留下了续传状态')
    const state = JSON.parse(await readFile(`${to}.part.json`, 'utf8'))
    assert.deepEqual(state.done, [[0, 64 * 1024]])

    const before = s.ranges.length
    await downloadFile(s.url, to, { chunkSize: 64 * 1024, connections: 2 })
    assert.ok((await readFile(to)).equals(body))
    const resumed = s.ranges.slice(before)
    assert.ok(!resumed.includes('bytes=0-65535'), '已经下完的第一片不再下')
    assert.ok(
      resumed.some((r) => r?.startsWith('bytes=65536-')),
      '从第二片接着下',
    )
  } finally {
    await s.close()
  }
})

test('分片连接被断开时重试，文件没有缺口', async () => {
  const body = content(512 * 1024)
  const s = await serve(body, { dropFirst: true })
  try {
    const to = out('e.bin')
    await downloadFile(s.url, to, { chunkSize: 64 * 1024, connections: 1 })
    assert.ok((await readFile(to)).equals(body))
  } finally {
    await s.close()
  }
})

test('下载的每处请求都经过统一入口，并带响应头超时', async () => {
  const body = content(256 * 1024)
  const s = await serve(body)
  try {
    const to = out('g.bin')
    const timeouts: number[] = []
    await downloadFile(s.url, to, {
      chunkSize: 64 * 1024,
      connections: 2,
      fetch: (url, init) => {
        timeouts.push(init?.timeoutMs ?? 0)
        // 探测没有空闲计时，不需要 onAttempt；真正下载的请求必须带
        const headers = init?.headers as Record<string, string> | undefined
        if (headers?.Range !== 'bytes=0-0')
          assert.equal(typeof init?.onAttempt, 'function', '下载请求要能通知下载层重置空闲计时')
        return netFetch(url, init)
      },
    })
    assert.ok((await readFile(to)).equals(body))
    // 1 次探测 + 4 个 64K 分片；每处都交给 netFetch 并带响应头超时，
    // 少传一处，直连超时时就不会自动换代理
    assert.equal(timeouts.length, 5)
    assert.deepEqual(new Set(timeouts), new Set([20_000]))
  } finally {
    await s.close()
  }
})

test('分片区间合并与缺口计算', () => {
  assert.deepEqual(addSpan([[0, 10]], [10, 20]), [[0, 20]])
  assert.deepEqual(
    addSpan(
      [
        [0, 10],
        [20, 30],
      ],
      [15, 25],
    ),
    [
      [0, 10],
      [15, 30],
    ],
  )
  assert.deepEqual(addSpan([], [5, 6]), [[5, 6]])
  assert.deepEqual(missingSpans(25, [[5, 10]], 5), [
    [0, 5],
    [10, 15],
    [15, 20],
    [20, 25],
  ])
  assert.deepEqual(missingSpans(10, [[0, 10]], 5), [])
})

test('删除下载中的临时文件', async () => {
  const to = out('f.bin')
  await writeFile(`${to}.part`, 'x')
  await writeFile(`${to}.part.json`, '{}')
  await removeDownload(to)
  assert.ok(!existsSync(`${to}.part`) && !existsSync(`${to}.part.json`))
})

test('收尾：删掉测试目录', async () => {
  await rm(dir, { recursive: true, force: true })
})
