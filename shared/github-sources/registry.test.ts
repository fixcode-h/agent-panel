import { test } from 'node:test'
import assert from 'node:assert/strict'
import { candidatesFor, normalizePrefix, parseGithubUrl, resolveSources, toSettingList } from './registry.ts'
import { extractBlobText } from './web-blob.ts'

const CATALOG = 'https://raw.githubusercontent.com/fixcode-h/UEKit/main/catalog.json'

test('认得各种 GitHub 地址，别的地址不管', () => {
  assert.deepEqual(parseGithubUrl(CATALOG), {
    kind: 'raw',
    url: CATALOG,
    owner: 'fixcode-h',
    repo: 'UEKit',
    ref: 'main',
    path: 'catalog.json',
  })
  const refs = parseGithubUrl('https://raw.githubusercontent.com/o/r/refs/heads/dev/a/b.json')
  assert.equal(refs?.kind === 'raw' && `${refs.ref}|${refs.path}`, 'dev|a/b.json')
  const web = parseGithubUrl('https://github.com/o/r/raw/v1/x.txt')
  assert.equal(web?.kind === 'raw' && `${web.ref}|${web.path}`, 'v1|x.txt')
  assert.equal(parseGithubUrl('https://github.com/o/r/blob/main/x.txt?raw=true')?.kind, 'raw')
  assert.equal(parseGithubUrl('https://github.com/o/r/blob/main/x.txt')?.kind, 'page')
  assert.equal(parseGithubUrl('https://github.com/o/r/releases/download/v1/a.zip')?.kind, 'release')
  assert.equal(parseGithubUrl('https://github.com/o/r/releases/latest/download/a.zip')?.kind, 'release')
  assert.equal(parseGithubUrl('https://codeload.github.com/o/r/zip/HEAD')?.kind, 'archive')
  assert.equal(parseGithubUrl('https://api.github.com/repos/o/r/releases')?.kind, 'api')
  assert.equal(parseGithubUrl('https://hf-mirror.com/x/y'), null)
  assert.equal(parseGithubUrl('不是地址'), null)
})

test('默认顺序：原地址 → API → 网页 → jsDelivr；仓库文件四个都能试', () => {
  const list = resolveSources([])
  assert.deepEqual(
    list.map((s) => s.key),
    ['origin', 'api', 'web', 'jsdelivr'],
  )
  const urls = candidatesFor(parseGithubUrl(CATALOG)!, list).map((c) => c.candidate.url)
  assert.deepEqual(urls, [
    CATALOG,
    'https://api.github.com/repos/fixcode-h/UEKit/contents/catalog.json?ref=main',
    'https://github.com/fixcode-h/UEKit/blob/main/catalog.json',
    'https://cdn.jsdelivr.net/gh/fixcode-h/UEKit@main/catalog.json',
  ])
})

test('分支写 HEAD 时不用 jsDelivr，API 不带 ref', () => {
  const urls = candidatesFor(
    parseGithubUrl('https://raw.githubusercontent.com/o/r/HEAD/a.json')!,
    resolveSources([]),
  ).map((c) => c.candidate.url)
  assert.ok(urls.includes('https://api.github.com/repos/o/r/contents/a.json'))
  assert.ok(!urls.some((u) => u.includes('jsdelivr')))
})

test('设置里的顺序、开关、镜像：认不得的丢掉，缺的内置来源接在后面', () => {
  const list = resolveSources([
    { id: 'mirror', enabled: true, prefix: 'https://m.example.com' },
    { id: 'web', enabled: true },
    { id: 'origin', enabled: false },
    { id: 'nope', enabled: true },
    { id: 'mirror', enabled: true, prefix: 'https://m.example.com/' },
    { id: 'mirror', enabled: true, prefix: 'ftp://x' },
  ])
  assert.deepEqual(
    list.map((s) => `${s.key}:${s.enabled}`),
    ['mirror:https://m.example.com/:true', 'web:true', 'origin:false', 'api:true', 'jsdelivr:true'],
  )
  // Release 附件只有镜像能换；关掉的原地址不试
  const release = 'https://github.com/o/r/releases/download/v1/a.zip'
  assert.deepEqual(
    candidatesFor(parseGithubUrl(release)!, list).map((c) => c.candidate.url),
    [`https://m.example.com/${release}`],
  )
  assert.deepEqual(toSettingList(list)[0], { id: 'mirror', enabled: true, prefix: 'https://m.example.com/' })
  assert.equal(normalizePrefix(' https://a.b '), 'https://a.b/')
  assert.equal(normalizePrefix('a.b'), '')
})

test('网页来源：从内嵌 JSON 里取出文件内容，字段藏在哪层都认', () => {
  const data = { payload: { 'codeViewBlobLayoutRoute.StyledBlob': { rawLines: ['{', '  "a": "<\\/script>"', '}'] } } }
  const html = `<html><script type="application/json" data-target="react-app.embeddedData">${JSON.stringify(data).replace(/</g, '\\u003c')}</script></html>`
  assert.equal(extractBlobText(html), '{\n  "a": "<\\/script>"\n}\n')
  assert.equal(extractBlobText('<html>没有内容</html>'), null)
  const big = `<script type="application/json" data-target="react-app.embeddedData">{"payload":{"blob":{"rawLines":null}}}</script>`
  assert.equal(extractBlobText(big), null)
})
