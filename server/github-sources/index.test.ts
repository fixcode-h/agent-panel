import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setLang } from '../../shared/i18n.ts'
import type { GithubSourceSetting } from '../../shared/github-sources/registry.ts'
import { fetchViaSources, resetPreferred, testSources, type SourcesDeps } from './index.ts'

setLang('zh')
const CATALOG = 'https://raw.githubusercontent.com/fixcode-h/UEKit/main/catalog.json'
const reset = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } })

/** 按地址前缀决定结果：Error 抛出，数字回对应状态码，字符串回 200 正文 */
function deps(routes: [string, Error | number | string][], sources: GithubSourceSetting[] = []) {
  const calls: { url: string; headers: Headers }[] = []
  const d: SourcesDeps = {
    fetch: async (url, init) => {
      calls.push({ url, headers: new Headers(init.headers) })
      const hit = routes.find(([p]) => url.startsWith(p))
      if (!hit) throw new Error(`没有安排的地址 ${url}`)
      const r = hit[1]
      if (r instanceof Error) throw r
      return typeof r === 'number' ? new Response('x', { status: r }) : new Response(r)
    },
    sources: async () => sources,
    reason: (e) => `原因:${((e as Error).cause as { code?: string })?.code ?? (e as Error).message}`,
  }
  return { d, calls }
}

test('不是 GitHub 的地址照原样取', async () => {
  resetPreferred()
  const { d, calls } = deps([['https://hf-mirror.com/', 'ok']])
  assert.equal(await (await fetchViaSources(d, 'https://hf-mirror.com/a')).text(), 'ok')
  assert.equal(calls.length, 1)
})

test('raw 被重置时换 API 取到，带上要原文的 Accept；之后先走 API', async () => {
  resetPreferred()
  const { d, calls } = deps([
    ['https://raw.githubusercontent.com/', reset],
    ['https://api.github.com/', '{"plugins":[]}'],
  ])
  assert.equal(await (await fetchViaSources(d, CATALOG)).text(), '{"plugins":[]}')
  assert.equal(calls[1].headers.get('accept'), 'application/vnd.github.raw')
  calls.length = 0
  await fetchViaSources(d, CATALOG)
  assert.equal(calls.length, 1, '记住了能用的来源，不再先等原地址失败')
  assert.ok(calls[0].url.startsWith('https://api.github.com/'))
})

test('API 被限流时换网页，从网页里取出文件内容', async () => {
  resetPreferred()
  const page = `<script type="application/json" data-target="react-app.embeddedData">{"payload":{"blob":{"rawLines":["{}"]}}}</script>`
  const { d } = deps([
    ['https://raw.githubusercontent.com/', reset],
    ['https://api.github.com/', 403],
    ['https://github.com/', page],
  ])
  const res = await fetchViaSources(d, CATALOG)
  assert.equal(res.status, 200)
  assert.equal(await res.text(), '{}\n')
})

test('404 不换来源：文件确实不存在', async () => {
  resetPreferred()
  const { d, calls } = deps([['https://raw.githubusercontent.com/', 404]])
  assert.equal((await fetchViaSources(d, CATALOG)).status, 404)
  assert.equal(calls.length, 1)
})

test('全都失败：一条错误里列出每个来源的原因', async () => {
  resetPreferred()
  const origin = new Error('原地址的完整说明（尝试过的路径：直连）', { cause: reset })
  const { d } = deps([
    ['https://raw.githubusercontent.com/', origin],
    ['https://api.github.com/', reset],
    ['https://github.com/', reset],
    ['https://cdn.jsdelivr.net/', reset],
  ])
  await assert.rejects(fetchViaSources(d, CATALOG), (e: Error) => {
    assert.match(e.message, /GitHub 的各个下载来源都没成功/)
    assert.match(e.message, /原地址：原地址的完整说明（尝试过的路径：直连）/)
    assert.match(e.message, /GitHub API：原因:ECONNRESET/)
    assert.match(e.message, /GitHub 网页：原因:ECONNRESET/)
    assert.match(e.message, /jsDelivr：原因:ECONNRESET/)
    return true
  })
})

test('Release 附件：没有镜像时只试原地址、错误原样；加了镜像就换镜像', async () => {
  resetPreferred()
  const url = 'https://github.com/o/r/releases/download/v1/a.zip'
  // 预置的 gh-proxy 也是镜像：关掉它才是「没有镜像」
  const only = deps(
    [['https://github.com/', reset]],
    [{ id: 'mirror', enabled: false, prefix: 'https://v6.gh-proxy.org/' }],
  )
  await assert.rejects(fetchViaSources(only.d, url), (e: Error) => e === reset)
  const mirrored = deps(
    [
      ['https://github.com/', reset],
      ['https://m.example.com/', 'zip'],
    ],
    [
      { id: 'origin', enabled: true },
      { id: 'mirror', enabled: true, prefix: 'https://m.example.com/' },
    ],
  )
  assert.equal(await (await fetchViaSources(mirrored.d, url)).text(), 'zip')
  // 原地址和自己加的镜像都不通时，最后走预置的 gh-proxy（IPv6 不通也只是再换下一个）
  resetPreferred()
  const preset = deps([
    ['https://github.com/', reset],
    ['https://v6.gh-proxy.org/', 'zip6'],
  ])
  assert.equal(await (await fetchViaSources(preset.d, url)).text(), 'zip6')
  assert.equal(preset.calls.at(-1)?.url, `https://v6.gh-proxy.org/${url}`)
  assert.equal(mirrored.calls[1].url, `https://m.example.com/${url}`)
})

test('调用方取消后不再换来源', async () => {
  resetPreferred()
  const ac = new AbortController()
  const { d, calls } = deps([['https://raw.githubusercontent.com/', reset]])
  const fetch = d.fetch
  d.fetch = async (u, i) => {
    ac.abort()
    return fetch(u, i)
  }
  await assert.rejects(fetchViaSources(d, CATALOG, { signal: ac.signal }))
  assert.equal(calls.length, 1)
})

test('设置页检测：每个来源各取一次样例，标出通不通', async () => {
  const { d } = deps([
    ['https://raw.githubusercontent.com/', reset],
    ['https://api.github.com/', '{"name":"agent-panel"}'],
    ['https://github.com/', '<html>改版了</html>'],
    ['https://cdn.jsdelivr.net/', 503],
  ])
  const rows = await testSources(d, [], 'https://raw.githubusercontent.com/fixcode-h/agent-panel/main/package.json')
  const by = Object.fromEntries(rows.map((r) => [r.key, r]))
  assert.equal(by.origin.ok, false)
  assert.equal(by.api.ok, true)
  assert.equal(by.web.ok, false)
  assert.equal(by.jsdelivr.error, 'HTTP 503')
})
