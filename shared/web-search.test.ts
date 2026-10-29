/**
 * 联网搜索的共用逻辑：地址守卫、参数规范化、域名过滤、正文窗口和各个搜索源的响应解析。
 * 这些都在面板这一侧执行（模型只看到结果），不联网：解析用的都是固定样本。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Settings } from './schema.ts'
import {
  FETCH_WINDOW_CHARS,
  domainAllowed,
  formatPage,
  formatSearchResults,
  guardUrl,
  htmlTitle,
  htmlToText,
  isPrivateAddress,
  normalizeDomains,
  normalizeFetch,
  normalizeSearch,
  pageWindow,
  resolveSearchEndpoint,
  searchProvider,
  switchSearchProvider,
} from './web-search.ts'

test('guardUrl：正常网址原样返回，http 允许（升级在 normalizeFetch 里做）', () => {
  assert.equal(guardUrl('https://example.com/a?b=1').hostname, 'example.com')
  assert.equal(guardUrl('http://example.com').protocol, 'http:')
})

test('guardUrl：拒绝带凭据、非 http(s)、单标签主机名和本机地址', () => {
  assert.throws(() => guardUrl('https://user:pw@example.com'), /用户名和密码/)
  assert.throws(() => guardUrl('file:///etc/passwd'), /只支持 http/)
  assert.throws(() => guardUrl('https://intranet/x'), /内网主机名/)
  // 末尾带点的主机名解析结果和没有点的一样，不能因此当成域名放过去
  assert.throws(() => guardUrl('http://intranet./'), /内网主机名/)
  assert.throws(() => guardUrl('http://localhost:8080/'), /本机地址/)
  assert.throws(() => guardUrl('http://app.localhost/'), /本机地址/)
  assert.throws(() => guardUrl('http://127.0.0.1/'), /内网或本机地址/)
  assert.throws(() => guardUrl('http://10.1.2.3/'), /内网或本机地址/)
  assert.throws(() => guardUrl('http://169.254.169.254/latest/meta-data'), /内网或本机地址/)
  assert.throws(() => guardUrl('http://[::1]/'), /内网或本机地址/)
  assert.throws(() => guardUrl('http://[fe80::1]/'), /内网或本机地址/)
  // 映射 / 兼容地址的十六进制写法（URL 解析后就长这样）
  assert.throws(() => guardUrl('http://[::ffff:127.0.0.1]/'), /内网或本机地址/)
  assert.throws(() => guardUrl('https://[::ffff:7f00:1]:8443/'), /内网或本机地址/)
  assert.throws(() => guardUrl('https://[::ffff:a9fe:a9fe]/'), /内网或本机地址/)
  assert.throws(() => guardUrl('不是网址'), /不是一个有效的网址/)
})

test('isPrivateAddress：私网、回环、链路本地、保留地址都算，公网地址不算', () => {
  for (const ip of [
    '10.0.0.1',
    '172.16.5.4',
    '192.168.1.1',
    '127.0.0.1',
    '169.254.1.1',
    '0.0.0.0',
    '100.64.0.1',
    '224.0.0.1',
  ])
    assert.equal(isPrivateAddress(ip), true, ip)
  for (const ip of ['::1', 'fc00::1', 'fe80::1', 'ff02::1', '::ffff:10.0.0.1'])
    assert.equal(isPrivateAddress(ip), true, ip)
  // WHATWG URL 会把映射地址归一成十六进制（[::ffff:127.0.0.1] → [::ffff:7f00:1]），按字符串匹配点分写法会漏掉
  for (const ip of ['[::ffff:7f00:1]', '::ffff:7f00:1', '::7f00:1', '::ffff:a9fe:a9fe', '::0.0.0.0', '2002:7f00:1::1'])
    assert.equal(isPrivateAddress(ip), true, ip)
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700::1111'])
    assert.equal(isPrivateAddress(ip), false, ip)
})

test('isPrivateAddress：不是合法 IPv6 的输入当公网处理，不抛异常', () => {
  // 组数超 8 时以前会在 new Array(负数) 上抛 RangeError：接未经 URL 校验的输入时就是一个崩溃点
  for (const bad of ['1:2:3:4:5::6:7:8:9', '1:2:3:4:5:6:7:8:9', '1::2::3', '', 'zz::1'])
    assert.equal(isPrivateAddress(bad), false, bad)
})

test('normalizeSearch：默认 5 条、夹到 1–10 条，域名参数归一', () => {
  const q = normalizeSearch({ query: '  unreal engine  ' })
  assert.equal(q.query, 'unreal engine')
  assert.equal(q.numResults, 5)
  assert.deepEqual(q.allowedDomains, [])
  assert.equal(normalizeSearch({ query: 'abc', numResults: 99 }).numResults, 10)
  assert.equal(normalizeSearch({ query: 'abc', numResults: 0 }).numResults, 1)
  assert.deepEqual(
    normalizeSearch({ query: 'abc', allowed_domains: ['Example.com', '*.docs.example.com'] }).allowedDomains,
    ['example.com', 'docs.example.com'],
  )
})

test('normalizeSearch：短查询、超长查询、两种域名同时给都报错', () => {
  assert.throws(() => normalizeSearch({ query: 'a' }), /至少要有 2 个字/)
  assert.throws(() => normalizeSearch({ query: 'x'.repeat(401) }), /太长了/)
  assert.throws(
    () => normalizeSearch({ query: 'abc', allowed_domains: ['a.com'], blocked_domains: ['b.com'] }),
    /不能同时给/,
  )
})

test('normalizeDomains：只能写域名，写 URL / 带端口时明确报错', () => {
  assert.deepEqual(normalizeDomains('a.com, b.com', 'allowed_domains'), ['a.com', 'b.com'])
  assert.throws(() => normalizeDomains('https://a.com/x', 'allowed_domains'), /只能写域名/)
  assert.throws(() => normalizeDomains('a.com:8080', 'blocked_domains'), /只能写域名/)
  // 带路径时不能静默截成域名：用户以为过滤了整个站点，实际写的是错的
  assert.throws(() => normalizeDomains('a.com/path', 'allowed_domains'), /只能写域名/)
})

test('domainAllowed：allowed 只留列表里的，blocked 去掉列表里的，都含子域名', () => {
  assert.equal(domainAllowed('docs.a.com', ['a.com'], []), true)
  assert.equal(domainAllowed('b.com', ['a.com'], []), false)
  assert.equal(domainAllowed('docs.a.com', [], ['a.com']), false)
  assert.equal(domainAllowed('b.com', [], ['a.com']), true)
  assert.equal(domainAllowed('b.com', [], []), true)
})

test('normalizeFetch：http 升级 https，格式和超时按上限夹住', () => {
  const f = normalizeFetch({ url: 'http://example.com/x' })
  assert.equal(f.url, 'https://example.com/x')
  assert.equal(f.format, 'markdown')
  assert.equal(f.startIndex, 0)
  assert.equal(f.timeoutMs, 60_000)
  assert.equal(
    normalizeFetch({ url: 'https://a.com', format: 'text', startIndex: 120, timeout: 999 }).timeoutMs,
    120_000,
  )
  assert.equal(normalizeFetch({ url: 'https://a.com', format: 'pdf' }).format, 'markdown')
  // 模型把「不指定」写成 0 / 负数时按默认 60 秒，别夹成 1 秒后必然超时
  assert.equal(normalizeFetch({ url: 'https://a.com', timeout: 0 }).timeoutMs, 60_000)
  assert.equal(normalizeFetch({ url: 'https://a.com', timeout: -5 }).timeoutMs, 60_000)
  assert.throws(() => normalizeFetch({}), /url 是必填的/)
})

test('htmlToText：markdown 保留标题和链接，text 只留文字，html 原样', () => {
  const html =
    '<html><head><title>T</title><style>b{}</style></head><body><h1>标题</h1><p>正文 <a href="https://a.com">链接</a></p><script>x()</script><ul><li>一</li><li>二</li></ul></body></html>'
  const md = htmlToText(html, 'markdown')
  assert.match(md, /^# 标题/m)
  assert.match(md, /\[链接\]\(https:\/\/a\.com\)/)
  assert.match(md, /- 一/)
  assert.doesNotMatch(md, /x\(\)|b\{\}/)
  const text = htmlToText(html, 'text')
  assert.match(text, /正文 链接/)
  assert.doesNotMatch(text, /https:\/\/a\.com/)
  assert.equal(htmlToText(html, 'html'), html)
  assert.equal(htmlTitle(html), 'T')
})

test('pageWindow：一次只给一个窗口，endIndex 可以接着续读', () => {
  const body = 'x'.repeat(FETCH_WINDOW_CHARS + 10)
  const first = pageWindow(body, 0)
  assert.equal(first.text.length, FETCH_WINDOW_CHARS)
  assert.equal(first.truncated, true)
  assert.equal(first.total, FETCH_WINDOW_CHARS + 10)
  const second = pageWindow(body, first.endIndex)
  assert.equal(second.text.length, 10)
  assert.equal(second.truncated, false)
  // 越界的 startIndex 夹到末尾，不报错
  assert.equal(pageWindow(body, 999_999).text, '')
})

test('各个搜索源的响应解析：字段名对齐成 title / url / snippet，脏数据跳过', () => {
  const searx = searchProvider('searxng').parse({
    results: [{ title: 'A', url: 'https://a.com', content: 's', score: 1 }, { title: '坏', url: 'ftp://x' }, null],
  })
  assert.deepEqual(searx, [{ title: 'A', url: 'https://a.com', snippet: 's' }])
  assert.deepEqual(searchProvider('searxng').parse({ results: [{ title: 'B', url: 'https://b.com', content: 'c' }] }), [
    { title: 'B', url: 'https://b.com', snippet: 'c' },
  ])
  assert.deepEqual(
    searchProvider('brave').parse({ web: { results: [{ title: 'C', url: 'https://c.com', description: 'd' }] } }),
    [{ title: 'C', url: 'https://c.com', snippet: 'd' }],
  )
  assert.deepEqual(searchProvider('tavily').parse({ results: [{ title: 'D', url: 'https://d.com', content: 'e' }] }), [
    { title: 'D', url: 'https://d.com', snippet: 'e' },
  ])
  // DeepSeek：摘要按 snippet → summary → content 取第一个非空的
  assert.deepEqual(
    searchProvider('deepseek').parse({
      results: [
        { title: 'E', url: 'https://e.com', snippet: '', summary: 'sum', content: 'full' },
        { title: 'F', url: 'https://f.com', content: 'full' },
      ],
    }),
    [
      { title: 'E', url: 'https://e.com', snippet: 'sum' },
      { title: 'F', url: 'https://f.com', snippet: 'full' },
    ],
  )
  assert.deepEqual(searchProvider('没这个源').parse({ results: [] }), [])
})

test('搜索源的请求：参数和鉴权按各服务的写法，密钥不放地址里', () => {
  const base = { query: 'unreal engine', numResults: 3, count: 3, allowedDomains: [], blockedDomains: [] }
  const brave = searchProvider('brave').build({
    ...base,
    key: 'k',
    endpoint: 'https://api.search.brave.com/res/v1/web/search',
  })
  assert.match(brave.url, /q=unreal%20engine&count=3/)
  assert.equal((brave.init.headers as Record<string, string>)['x-subscription-token'], 'k')
  const tavily = searchProvider('tavily').build({ ...base, key: 'k2', endpoint: 'https://api.tavily.com/search' })
  assert.equal((tavily.init.headers as Record<string, string>).authorization, 'Bearer k2')
  assert.doesNotMatch(String(tavily.init.body), /k2/)
})

test('结果文本：没有结果时告诉模型换关键词，有结果时带地址和摘要', () => {
  assert.match(formatSearchResults('abc', 'searxng', []), /没有找到结果/)
  const text = formatSearchResults('abc', 'searxng', [{ title: 'A', url: 'https://a.com', snippet: 's' }])
  assert.match(text, /searxng/)
  assert.match(text, /https:\/\/a\.com/)
})

test('抓取文本：截断时告诉模型下一段从哪个 startIndex 续读', () => {
  const window = pageWindow('y'.repeat(FETCH_WINDOW_CHARS + 5), 0)
  const text = formatPage({
    url: 'https://a.com',
    finalUrl: 'https://a.com/',
    status: 200,
    format: 'markdown',
    title: 'T',
    window,
    redirects: ['https://a.com → https://a.com/'],
  })
  assert.match(text, /标题：T/)
  assert.match(text, new RegExp(`startIndex=${window.endIndex}`))
  assert.match(text, /跳转：/)
})

test('抓取文本：startIndex 已经到末尾时说清楚读完了，不说「正文为空」', () => {
  const body = 'z'.repeat(10)
  const text = formatPage({
    url: 'https://a.com',
    finalUrl: 'https://a.com',
    status: 200,
    format: 'markdown',
    title: '',
    window: pageWindow(body, 99),
    redirects: [],
  })
  assert.match(text, /已经读到正文末尾，共 10 字/)
  const empty = formatPage({
    url: 'https://a.com',
    finalUrl: 'https://a.com',
    status: 200,
    format: 'markdown',
    title: '',
    window: pageWindow('', 0),
    redirects: [],
  })
  assert.match(empty, /正文为空/)
})

test('设置里的联网搜索：没写过用默认源，源名写错回退默认，密钥去掉首尾空白', () => {
  // 默认源是 DeepSeek 官方搜索；旧设置里存过的选择原样保留，已经去掉的 degoog 回退到 DeepSeek
  assert.equal(Settings.parse({}).webSearch.provider, 'deepseek')
  assert.equal(Settings.parse({ webSearch: { provider: '不存在的源' } }).webSearch.provider, 'deepseek')
  assert.equal(Settings.parse({ webSearch: { provider: 'degoog' } }).webSearch.provider, 'deepseek')
  assert.equal(Settings.parse({ webSearch: { provider: 'tavily' } }).webSearch.provider, 'tavily')
  const brave = Settings.parse({ webSearch: { provider: 'brave', key: '  sk-xxxx  ' } })
  assert.equal(brave.webSearch.provider, 'brave')
  assert.equal(brave.webSearch.key, 'sk-xxxx')
})

const searxValue = {
  provider: 'searxng',
  key: '',
  endpoint: 'https://searx.example.com',
  endpointProvider: 'searxng',
}

test('换搜索源：清掉上一源留下的地址，同一源内手填的地址保留', () => {
  const moved = switchSearchProvider(searxValue, 'deepseek')
  assert.equal(moved.provider, 'deepseek')
  // 地址是所有源共用的一个字段：留着它就会被当成新源的基址，请求打到旧主机
  assert.equal(moved.endpoint, '')
  assert.equal(moved.endpointProvider, 'deepseek')
  // 选回当前已选中的源（下拉框重渲染）不能把手填的地址清掉
  assert.equal(switchSearchProvider(searxValue, 'searxng').endpoint, 'https://searx.example.com')
  // 认不出的源按默认源处理，地址同样不能沿用
  assert.equal(switchSearchProvider(searxValue, '不存在的源').endpoint, '')
})

test('地址归属和当前源不一致时忽略它，改用当前源的默认地址', () => {
  const leftover = {
    provider: 'deepseek',
    key: 'sk-xxxx',
    endpoint: 'https://searx.example.com',
    endpointProvider: 'searxng',
  }
  assert.equal(resolveSearchEndpoint(leftover), searchProvider('deepseek').endpoint)
  // 旧设置里没有归属（升级前存的）：地址可能是用户手填的代理，照旧采信
  assert.equal(resolveSearchEndpoint({ ...leftover, endpointProvider: '' }), 'https://searx.example.com')
  // 归属对得上：用户在当前源里填的地址照旧生效
  assert.equal(resolveSearchEndpoint({ ...leftover, endpointProvider: 'deepseek' }), 'https://searx.example.com')
  // 必须自填地址的源：归属不对时不借别人的地址，留空交给「需要填写地址」的报错
  assert.equal(
    resolveSearchEndpoint({
      provider: 'searxng',
      key: '',
      endpoint: 'https://api.search.brave.com/res/v1/web/search',
      endpointProvider: 'brave',
    }),
    '',
  )
})
