/**
 * 联网搜索的代理端点：令牌校验、参数错误、密钥缺失、上游错误原文、域名过滤、重定向与正文窗口。
 * 网络、DNS 都换成桩，不连外网；设置写进临时的数据目录。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { t } from '../shared/i18n.ts'
import { mcpExtras } from '../shared/cli-spec.ts'
import { getCli } from '../shared/clis.ts'
import { SEARCH_MIN_QUERY_CHARS } from '../shared/web-search.ts'

// 设置模块读数据目录，用临时的别碰本机
process.env.AGENT_PANEL_DATA = mkdtempSync(path.join(tmpdir(), 'agent-panel-web-search-'))

const { openAskBridge } = await import('./ask-mcp.ts')
const { getSettings, saveSettings } = await import('./settings.ts')
const { assertPublicHost, webSearchApi } = await import('./web-search.ts')
// 搜索源的 label 是 i18n 默认语言下算好的模块常量，改语言也改不到它；
// 请求时的句子则按运行时语言算（设置读出来会按系统语言重置，CI 是英文）。
// 所以断言取 t() 现算或中英双匹配，不依赖界面语言。

/** 这一轮 CLI 的随机地址：路由和扩展用的是同一个 */
function session() {
  const bridge = openAskBridge({})
  return { token: bridge.url.split('/').pop()!, close: bridge.close }
}

async function withProvider(webSearch: { provider: string; key: string; endpoint: string }) {
  const s = await getSettings()
  await saveSettings({ ...s, webSearch })
}

/** 只记下请求、按脚本返回响应的桩 */
function stubFetch(reply: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return reply(url, init)
  }
  return { fetch, calls }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } })

const publicDns = async () => [{ address: '93.184.216.34' }]

test('令牌不对或这一轮已经结束：404，不花搜索的密钥额度', async () => {
  const stub = stubFetch(() => json({ results: [] }))
  const api = webSearchApi({ fetch: stub.fetch, lookup: publicDns })
  const res = await api.request('/nope/search', { method: 'POST', body: JSON.stringify({ query: 'abc' }) })
  assert.equal(res.status, 404)
  assert.equal(stub.calls.length, 0)
})

test('搜索参数不对：400，错误原文交给模型', async () => {
  const s = session()
  const stub = stubFetch(() => json({ results: [] }))
  const api = webSearchApi({ fetch: stub.fetch, lookup: publicDns })
  const res = await api.request(`/${s.token}/search`, { method: 'POST', body: JSON.stringify({ query: 'a' }) })
  assert.equal(res.status, 400)
  assert.match(
    ((await res.json()) as { error: string }).error,
    new RegExp(t('query 至少要有 {n} 个字', { n: SEARCH_MIN_QUERY_CHARS })),
  )
  assert.equal(stub.calls.length, 0)
  s.close()
})

test('默认源搜索：解析结果、按 numResults 截断、过滤域名、摘要带上来源', async () => {
  const s = session()
  await withProvider({ provider: 'degoog', key: '', endpoint: '' })
  const stub = stubFetch(() =>
    json({
      results: [
        { title: 'A', url: 'https://a.com/1', snippet: 'sa' },
        { title: 'B', url: 'https://b.com/2', snippet: 'sb' },
        { title: 'C', url: 'https://docs.a.com/3', snippet: 'sc' },
      ],
    }),
  )
  const api = webSearchApi({ fetch: stub.fetch, lookup: publicDns })
  const res = await api.request(`/${s.token}/search`, {
    method: 'POST',
    body: JSON.stringify({ query: 'unreal engine', numResults: 2, allowed_domains: ['a.com'] }),
  })
  assert.equal(res.status, 200)
  const body = (await res.json()) as { text: string; results: { url: string }[]; provider: string }
  assert.equal(body.provider, 'degoog')
  assert.deepEqual(
    body.results.map((r) => r.url),
    ['https://a.com/1', 'https://docs.a.com/3'],
  )
  assert.match(body.text, /Degoog/)
  // degoog 的地址里带 query，不带密钥
  assert.match(stub.calls[0]!.url, /q=unreal%20engine/)
  assert.equal(stub.calls[0]!.init.method, 'GET')
  s.close()
})

test('需要密钥的源没填密钥：400 明确提示，不发请求', async () => {
  const s = session()
  await withProvider({ provider: 'brave', key: '', endpoint: '' })
  const stub = stubFetch(() => json({ web: { results: [] } }))
  const api = webSearchApi({ fetch: stub.fetch, lookup: publicDns })
  const res = await api.request(`/${s.token}/search`, { method: 'POST', body: JSON.stringify({ query: 'abc' }) })
  assert.equal(res.status, 400)
  // label 是模块加载时按当时语言算的，句子是请求时按运行时语言算的，两半可能不同语言，只断句子
  assert.match(((await res.json()) as { error: string }).error, /needs a key|需要密钥/)
  assert.equal(stub.calls.length, 0)
  s.close()
})

test('搜到自己搭的 searxng：没填地址时明确报错，填了就用那个地址', async () => {
  const s = session()
  await withProvider({ provider: 'searxng', key: '', endpoint: '' })
  const stub = stubFetch(() => json({ results: [] }))
  const api = webSearchApi({ fetch: stub.fetch, lookup: publicDns })
  const missing = await api.request(`/${s.token}/search`, { method: 'POST', body: JSON.stringify({ query: 'abc' }) })
  assert.equal(missing.status, 400)
  assert.match(((await missing.json()) as { error: string }).error, /needs an address|需要填写地址/)

  await withProvider({ provider: 'searxng', key: '', endpoint: 'https://searx.example.com/' })
  const ok = await api.request(`/${s.token}/search`, { method: 'POST', body: JSON.stringify({ query: 'abc' }) })
  assert.equal(ok.status, 200)
  assert.match(stub.calls.at(-1)!.url, /^https:\/\/searx\.example\.com\/search\?q=abc/)
  s.close()
})

test('上游报错：状态码和响应原文都交给模型，不吞成一句「搜索失败」', async () => {
  const s = session()
  await withProvider({ provider: 'degoog', key: '', endpoint: '' })
  const stub = stubFetch(() => new Response('rate limited by upstream', { status: 429 }))
  const api = webSearchApi({ fetch: stub.fetch, lookup: publicDns })
  const res = await api.request(`/${s.token}/search`, { method: 'POST', body: JSON.stringify({ query: 'abc' }) })
  assert.equal(res.status, 502)
  const body = (await res.json()) as { error: string }
  assert.match(body.error, /429/)
  assert.match(body.error, /rate limited by upstream/)
  s.close()
})

test('抓取：HTML 按 markdown 返回，带标题和状态', async () => {
  const s = session()
  const stub = stubFetch(() =>
    html('<html><head><title>页面标题</title></head><body><h1>大标题</h1><p>正文</p></body></html>'),
  )
  const api = webSearchApi({ fetch: stub.fetch, lookup: publicDns })
  const res = await api.request(`/${s.token}/fetch`, {
    method: 'POST',
    body: JSON.stringify({ url: 'https://a.com/doc' }),
  })
  assert.equal(res.status, 200)
  const body = (await res.json()) as { text: string; title: string; status: number; url: string; redirects: string[] }
  assert.equal(body.title, '页面标题')
  assert.match(body.text, /# 大标题/)
  assert.deepEqual(body.redirects, [])
  // 请求带超时（默认 60 秒）并且不自动跟随重定向：每一跳都要过地址守卫
  assert.ok(stub.calls[0]!.init.signal)
  assert.equal(stub.calls[0]!.init.redirect, 'manual')
  s.close()
})

test('抓取：域名解析到内网地址时拒绝，连请求都不发', async () => {
  const s = session()
  const stub = stubFetch(() => html('<html></html>'))
  const api = webSearchApi({ fetch: stub.fetch, lookup: async () => [{ address: '127.0.0.1' }] })
  const res = await api.request(`/${s.token}/fetch`, {
    method: 'POST',
    body: JSON.stringify({ url: 'https://innocent.example.com/' }),
  })
  assert.equal(res.status, 403)
  assert.match(((await res.json()) as { error: string }).error, /private address|内网地址/)
  assert.equal(stub.calls.length, 0)
  s.close()
})

test('地址守卫的第二道：IP 字面量不经过 normalizeFetch 也拦得住', async () => {
  // 直接调服务端这一层：guardUrl 之后还有一道，漏改一处也不会打通内网
  await assert.rejects(
    () =>
      assertPublicHost(new URL('https://[::ffff:7f00:1]/'), {
        fetch: stubFetch(() => html('')).fetch,
        lookup: publicDns,
      }),
    /private or local address|内网或本机地址/,
  )
  await assert.rejects(
    () =>
      assertPublicHost(new URL('https://[::ffff:a9fe:a9fe]/'), {
        fetch: stubFetch(() => html('')).fetch,
        lookup: publicDns,
      }),
    /private or local address|内网或本机地址/,
  )
  // 公网字面量和域名照常放行
  await assertPublicHost(new URL('https://93.184.216.34/'), {
    fetch: stubFetch(() => html('')).fetch,
    lookup: publicDns,
  })
  await assertPublicHost(new URL('https://example.com/'), { fetch: stubFetch(() => html('')).fetch, lookup: publicDns })
})

test('抓取：重定向跟着走并报告，跳到内网时停下', async () => {
  const s = session()
  let hop = 0
  const stub = stubFetch(() => {
    hop++
    if (hop === 1) return new Response(null, { status: 302, headers: { location: 'https://b.com/next' } })
    return html('<html><title>B</title><body>ok</body></html>')
  })
  const api = webSearchApi({ fetch: stub.fetch, lookup: publicDns })
  const res = await api.request(`/${s.token}/fetch`, {
    method: 'POST',
    body: JSON.stringify({ url: 'https://a.com/start' }),
  })
  assert.equal(res.status, 200)
  const body = (await res.json()) as { finalUrl: string; redirects: string[] }
  assert.equal(body.finalUrl, 'https://b.com/next')
  assert.match(body.redirects[0]!, /a\.com\/start.*b\.com\/next/)

  const blocked = stubFetch(() => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } }))
  const api2 = webSearchApi({ fetch: blocked.fetch, lookup: publicDns })
  const res2 = await api2.request(`/${s.token}/fetch`, {
    method: 'POST',
    body: JSON.stringify({ url: 'https://c.com/x' }),
  })
  assert.equal(res2.status, 400)
  assert.match(((await res2.json()) as { error: string }).error, /private or local address|内网或本机地址/)
  s.close()
})

test('抓取：长正文按窗口返回，startIndex 续读后面的部分', async () => {
  const s = session()
  const long = `<html><body>${'字'.repeat(100_010)}</body></html>`
  const stub = stubFetch(() => html(long))
  const api = webSearchApi({ fetch: stub.fetch, lookup: publicDns })
  const url = 'https://long.example.com/page'
  const first = (await (
    await api.request(`/${s.token}/fetch`, { method: 'POST', body: JSON.stringify({ url }) })
  ).json()) as { text: string; endIndex: number; total: number; truncated: boolean }
  assert.equal(first.total, 100_010)
  assert.equal(first.truncated, true)
  assert.match(first.text, new RegExp(`startIndex=${first.endIndex}`))

  // 同一地址 15 分钟内用缓存，不再发第二次请求
  const before = stub.calls.length
  const second = (await (
    await api.request(`/${s.token}/fetch`, {
      method: 'POST',
      body: JSON.stringify({ url, startIndex: first.endIndex }),
    })
  ).json()) as { text: string; truncated: boolean }
  assert.equal(stub.calls.length, before)
  assert.equal(second.truncated, false)
  s.close()
})

test('Pi 扩展：注册 web_search / web_fetch，参数交给面板校验，错误原文回到模型', async () => {
  const s = session()
  await withProvider({ provider: 'degoog', key: '', endpoint: '' })
  const stub = stubFetch(() => json({ results: [{ title: 'A', url: 'https://a.com/1', snippet: 'sa' }] }))
  const api = webSearchApi({ fetch: stub.fetch, lookup: publicDns })
  // 和 server/index.ts 一样：扩展请求 /api/web-search/...，路由本身挂在 /api/web-search 下
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const out = await api.fetch(
      new Request(`http://127.0.0.1${req.url!.replace(/^\/api\/web-search/, '')}`, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body: chunks.length ? Buffer.concat(chunks) : undefined,
      }),
    )
    res.writeHead(out.status, { 'content-type': out.headers.get('content-type') ?? 'application/json' })
    res.end(Buffer.from(await out.arrayBuffer()))
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()))
  const port = (server.address() as AddressInfo).port
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-websearch-'))
  try {
    const bridge = `http://127.0.0.1:${port}/api/mcp/ask/${s.token}`
    // 关着开关时不写文件、不加参数：Pi 里根本不会注册这两个工具
    assert.deepEqual(mcpExtras(getCli('pi')!.mcp!, 'panel', bridge, dir, {}), { args: [], files: [] })
    const extras = mcpExtras(getCli('pi')!.mcp!, 'panel', bridge, dir, { webSearch: true })
    const file = extras.files.find((f) => f.path.endsWith('/agent-panel-panel-websearch.ts'))
    assert.ok(file, '定义里有联网搜索扩展')
    assert.deepEqual(extras.args, ['-e', file.path])
    writeFileSync(file.path, String(file.content))
    const mod = await import(pathToFileURL(file.path).href)
    const tools = new Map<string, any>()
    await mod.default({ registerTool: (tool: { name: string }) => tools.set(tool.name, tool) })
    assert.deepEqual([...tools.keys()].sort(), ['web_fetch', 'web_search'])

    const found = await tools.get('web_search')!.execute('1', { query: 'unreal engine' })
    assert.match(found.content[0]!.text, /https:\/\/a\.com\/1/)
    // 参数错误由面板判：错误原文（带字段名）要交给模型，不换成「搜索失败」
    await assert.rejects(
      () => tools.get('web_search')!.execute('2', { query: 'a' }),
      new RegExp(t('query 至少要有 {n} 个字', { n: SEARCH_MIN_QUERY_CHARS })),
    )
  } finally {
    server.closeAllConnections?.()
    server.close()
    rmSync(dir, { recursive: true, force: true })
    s.close()
  }
})

// ── DeepSeek 官方搜索 ──────────────────────────────────────
// 面板显式调官方搜索端点（不是模型侧联网）：断请求形状、结果映射、缺密钥报错和地址覆盖。

test('deepseek：POST 到 /v1/tools/search，带 Bearer 和 count', async () => {
  const s = session()
  await withProvider({ provider: 'deepseek', key: 'sk-test-deepseek', endpoint: '' })
  const stub = stubFetch(() => json({ results: [] }))
  const api = webSearchApi({ fetch: stub.fetch, lookup: publicDns })
  const res = await api.request(`/${s.token}/search`, {
    method: 'POST',
    body: JSON.stringify({ query: 'deepseek search', numResults: 3 }),
  })
  assert.equal(res.status, 200)
  assert.equal(((await res.json()) as { provider: string }).provider, 'deepseek')
  // 默认地址 + 官方固定路径，查询串里不带别的参数
  assert.equal(stub.calls[0]!.url, 'https://api.deepseek.com/v1/tools/search')
  assert.equal(stub.calls[0]!.init.method, 'POST')
  assert.equal((stub.calls[0]!.init.headers as Record<string, string>).authorization, 'Bearer sk-test-deepseek')
  // 字段名按官方文档；numResults=3 时要 6 条，供域名过滤之后还能剩够数
  assert.deepEqual(JSON.parse(String(stub.calls[0]!.init.body)), { query: 'deepseek search', count: 6 })
  s.close()
})

test('deepseek：结果按 title / url / snippet 映射，摘要文本带上来源', async () => {
  const s = session()
  await withProvider({ provider: 'deepseek', key: 'sk-test-deepseek', endpoint: '' })
  const stub = stubFetch(() =>
    json({
      results: [
        { title: '官方文档', url: 'https://api-docs.deepseek.com/guides/search', snippet: '搜索接口说明' },
        { title: '第二条', url: 'https://example.com/b', snippet: 'sb' },
      ],
    }),
  )
  const api = webSearchApi({ fetch: stub.fetch, lookup: publicDns })
  const res = await api.request(`/${s.token}/search`, { method: 'POST', body: JSON.stringify({ query: 'deepseek' }) })
  assert.equal(res.status, 200)
  const body = (await res.json()) as {
    results: { title: string; url: string; snippet: string }[]
    text: string
  }
  assert.deepEqual(body.results, [
    { title: '官方文档', url: 'https://api-docs.deepseek.com/guides/search', snippet: '搜索接口说明' },
    { title: '第二条', url: 'https://example.com/b', snippet: 'sb' },
  ])
  assert.match(body.text, /https:\/\/api-docs\.deepseek\.com\/guides\/search/)
  assert.match(body.text, /搜索接口说明/)
  s.close()
})

test('deepseek：没填密钥时 400 明确报错，不发请求也不回退到默认源', async () => {
  const s = session()
  await withProvider({ provider: 'deepseek', key: '   ', endpoint: '' })
  const stub = stubFetch(() => json({ results: [] }))
  const api = webSearchApi({ fetch: stub.fetch, lookup: publicDns })
  const res = await api.request(`/${s.token}/search`, { method: 'POST', body: JSON.stringify({ query: 'abc' }) })
  assert.equal(res.status, 400)
  assert.match(((await res.json()) as { error: string }).error, /needs a key|需要密钥/)
  assert.equal(stub.calls.length, 0)
  s.close()
})

test('deepseek：地址可覆盖，请求打到自定义地址下的 /v1/tools/search', async () => {
  const s = session()
  await withProvider({
    provider: 'deepseek',
    key: 'sk-test-deepseek',
    endpoint: 'https://search-proxy.example.com/deepseek/',
  })
  const stub = stubFetch(() => json({ results: [] }))
  const api = webSearchApi({ fetch: stub.fetch, lookup: publicDns })
  const res = await api.request(`/${s.token}/search`, { method: 'POST', body: JSON.stringify({ query: 'abc' }) })
  assert.equal(res.status, 200)
  assert.equal(stub.calls[0]!.url, 'https://search-proxy.example.com/deepseek/v1/tools/search')
  s.close()
})
