/**
 * 生产模式下托管 `dist/`：文本资源 gzip、带哈希的 `assets/*` 长缓存、入口页 no-cache、304。
 * 这几条是「首屏 2.5MB 未压缩、每次打开都整份重传」的修复点，回退一处用户就能感觉到。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const { acceptsGzip, serveDist, serveIndex } = await import('./static.ts')
const { Hono } = await import('hono')

const dist = mkdtempSync(path.join(tmpdir(), 'agent-panel-dist-'))
const put = (rel: string, body: string | Buffer) => {
  const file = path.join(dist, rel)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, body)
  return file
}

// 够大、够重复，压缩后体积明显变小
const script = `const answer = 42\n${'console.log("面板", answer)\n'.repeat(200)}`
put('index.html', '<!doctype html><html><body><div id="root"></div></body></html>')
put('assets/js/index-abc12345.js', script)
put('assets/css/index-abc12345.css', `.a{color:red}\n${'.b{color:blue}\n'.repeat(100)}`)
put('assets/fonts/inter-abc12345.woff2', Buffer.alloc(2048, 7))
put('favicon.ico', Buffer.from([0, 0, 1, 0]))

const app = new Hono()
app.use('/*', serveDist(dist))
app.get('*', serveIndex(dist))

const js = '/assets/js/index-abc12345.js'
const get = (url: string, headers: Record<string, string> = {}) => app.request(url, { headers })

test('文本资源带 gzip：体积明显变小，带哈希的 assets 用长缓存', async () => {
  const res = await get(js, { 'accept-encoding': 'gzip, deflate' })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-encoding'), 'gzip')
  assert.equal(res.headers.get('content-type'), 'text/javascript; charset=utf-8')
  const size = Number(res.headers.get('content-length'))
  assert.ok(size > 0 && size < Buffer.byteLength(script) / 3, `压缩后 ${size} 字节，原始 ${Buffer.byteLength(script)}`)
  assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable')
  assert.equal(res.headers.get('vary'), 'accept-encoding')
})

test('不要 gzip 的客户端拿到原文，缓存头一样', async () => {
  const res = await get(js)
  assert.equal(res.headers.get('content-encoding'), null)
  assert.equal(Number(res.headers.get('content-length')), Buffer.byteLength(script))
  assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable')
})

test('字体这类已经压缩过的不再 gzip', async () => {
  const res = await get('/assets/fonts/inter-abc12345.woff2', { 'accept-encoding': 'gzip' })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-encoding'), null)
  assert.equal(res.headers.get('content-type'), 'font/woff2')
  assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable')
})

test('入口页和前端路由都用 no-cache：发版后能立刻拿到新版本', async () => {
  for (const url of ['/', '/index.html', '/projects/abc/chat']) {
    const res = await get(url)
    assert.equal(res.status, 200, url)
    assert.equal(res.headers.get('cache-control'), 'no-cache', url)
    assert.match(await res.text(), /<div id="root">/, url)
  }
})

test('内容没变回 304，压缩和未压缩的 ETag 分开', async () => {
  const first = await get(js, { 'accept-encoding': 'gzip' })
  const etag = first.headers.get('etag')!
  assert.ok(etag)
  const again = await get(js, { 'accept-encoding': 'gzip', 'if-none-match': etag })
  assert.equal(again.status, 304)
  // 同一份资源、不同的编码不能共用 ETag：否则缓存会把 gzip 的那份回给不要 gzip 的请求
  assert.notEqual((await get(js)).headers.get('etag'), etag)
})

test('越界路径不会被读出去，交给 SPA 兜底', async () => {
  const res = await get('/../package.json')
  assert.equal(res.status, 200)
  assert.match(await res.text(), /<div id="root">/, '回的是入口页，不是仓库里的文件')
})

test('acceptsGzip：q=0 明确拒绝的不算', () => {
  assert.equal(acceptsGzip('gzip'), true)
  assert.equal(acceptsGzip('br, gzip;q=0.5'), true)
  assert.equal(acceptsGzip('deflate, *'), true)
  assert.equal(acceptsGzip('gzip;q=0'), false)
  assert.equal(acceptsGzip('br'), false)
  assert.equal(acceptsGzip(undefined), false)
})
