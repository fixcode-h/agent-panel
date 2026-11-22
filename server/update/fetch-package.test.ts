import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type ServerResponse } from 'node:http'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setLang } from '../../shared/i18n.ts'

process.env.AGENT_PANEL_DATA = await mkdtemp(path.join(tmpdir(), 'agent-panel-fetchpkg-data-'))
const { fetchPackage, packageSources } = await import('./fetch-package.ts')
setLang('zh')

const body = Buffer.alloc(256 * 1024, 7)

/** /stall 连上后只给响应头不给数据；/api 302 到 /ok；/ok 正常按 Range 返回 */
async function serve() {
  const hits: string[] = []
  const server = createServer((req, res: ServerResponse) => {
    hits.push(req.url ?? '')
    if (req.url === '/api') {
      res.writeHead(302, { Location: '/ok' })
      return res.end()
    }
    if (req.url === '/stall') {
      res.writeHead(206, { 'Content-Range': `bytes 0-0/${body.length}`, 'Content-Length': '1' })
      return // 永远不发数据
    }
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
    if (!m) {
      res.writeHead(200, { 'Content-Length': body.length })
      return res.end(body)
    }
    const start = Number(m[1])
    const end = m[2] ? Number(m[2]) : body.length - 1
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${body.length}`, 'Content-Length': end - start + 1 })
    res.end(body.subarray(start, end + 1))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return {
    base,
    hits,
    close: () => {
      server.closeAllConnections()
      return new Promise<void>((r) => server.close(() => r()))
    },
  }
}

test('来源顺序：GitHub API 在最前，其次原地址，再是打开的镜像；同一个地址不重复', () => {
  const list = packageSources({
    apiUrl: 'https://api.github.com/repos/o/r/releases/assets/1',
    url: 'https://github.com/o/r/releases/download/v1/a.zip',
    sources: [
      { id: 'mirror', enabled: true, prefix: 'https://m.example.com' },
      { id: 'mirror', enabled: false, prefix: 'https://off.example.com' },
    ],
  })
  assert.deepEqual(
    list.map((s) => s.label),
    ['GitHub API', '原地址', '镜像 m.example.com', 'gh-proxy 加速（IPv6）'],
  )
  assert.equal(list[2].url, 'https://m.example.com/https://github.com/o/r/releases/download/v1/a.zip')
})

test('一个来源卡住不给数据：到时限就换下一个，记下原因，最终文件完整', async () => {
  const s = await serve()
  try {
    const to = path.join(await mkdtemp(path.join(tmpdir(), 'agent-panel-fetchpkg-')), 'pkg.zip')
    const seen: string[] = []
    const fails: string[] = []
    let received = 0
    const used = await fetchPackage(
      [
        { label: 'A', url: `${s.base}/stall` },
        { label: 'API', url: `${s.base}/api`, api: true },
      ],
      to,
      'v1/pkg.zip',
      {
        fetch: (url, init) => fetch(url, init),
        stallMs: 300,
        onSource: (l) => {
          seen.push(l)
          received = 0
        },
        onFail: (l, e) => fails.push(`${l}:${e}`),
        onBytes: (n) => (received += n),
        onTotal: () => {},
      },
    )
    assert.equal(used, 'API')
    assert.deepEqual(seen, ['A', 'API'])
    assert.equal(fails.length, 1)
    assert.match(fails[0], /^A:0 秒没有收到数据$|^A:\d+ 秒没有收到数据$/)
    assert.ok((await readFile(to)).equals(body))
    assert.equal(received, body.length, '进度是真实收到的字节数')
    // API 地址只请求一次拿跳转地址，分片都打到跳转后的地址
    assert.equal(s.hits.filter((h) => h === '/api').length, 1)
  } finally {
    await s.close()
  }
})
