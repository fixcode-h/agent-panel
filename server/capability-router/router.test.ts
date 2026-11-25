import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { findRequestOf, inferLang } from '../../shared/capability-router/find/request.ts'
import { formatHits, mergeHits, parseFindJson } from '../../shared/capability-router/find/hits.ts'
import { declRe } from '../../shared/capability-router/find/text-patterns.ts'
import type { ExternalFindSource, FindRequest } from '../../shared/capability-router/find/types.ts'
import { closeMcpPool } from '../mcp-client/pool.ts'
import { externalSource, routerCommand } from './find/external.ts'
import { textSource } from './find/text-source.ts'
import { routeLog } from './log.ts'
import { route, type RouteSource } from './router.ts'

const req = (kind: FindRequest['kind'], query: string, extra: Record<string, unknown> = {}) => {
  const r = findRequestOf(kind, { query, ...extra })
  assert.ok(typeof r !== 'string', String(r))
  return r
}

test('查找请求：按扩展名、目录、写法推语言，推不准是 other；参数缺了说清楚', () => {
  assert.equal(req('symbol', 'UMyComp::Tick').lang, 'cpp')
  assert.equal(req('symbol', 'PlayerCtrl:OnInit').lang, 'lua')
  assert.equal(req('outline', 'Content/Script/UI/Main.lua').lang, 'lua')
  assert.equal(req('symbol', 'OnInit', { under: ['Content/Script'] }).lang, 'lua')
  assert.equal(req('symbol', 'OnInit', { under: 'Source/Game' }).lang, 'cpp')
  assert.equal(inferLang({ kind: 'symbol', query: 'OnInit' }), 'other')
  assert.equal(req('symbol', 'OnInit', { lang: 'lua' }).lang, 'lua', '给了就照给的')
  assert.equal(req('refs', 'x', { limit: '9999' }).limit, 200, '上限 200')
  assert.match(String(findRequestOf('outline', {})), /query/)
})

test('结果：外部服务的 JSON 读成命中、几条路合并去重（声明在前）、按字数分页', () => {
  const r = req('refs', 'Foo')
  const ext = parseFindJson(
    {
      target: { name: 'Foo', file: 'D:/P/Content/Script/a.lua', line: 3 },
      items: [{ file: 'D:\\P\\Content\\Script\\b.lua', line: 10, text: 'Foo()' }],
    },
    r,
    ['D:/P'],
  )!
  assert.deepEqual(
    ext.hits.map((h) => [h.file, h.line, h.rank]),
    [
      ['Content/Script/a.lua', 3, 0],
      ['Content/Script/b.lua', 10, 1],
    ],
  )
  const text = [
    { file: 'Content/Script/b.lua', line: 10, text: 'Foo()', rank: 1 as const },
    { file: 'Content/Script/c.lua', line: 5, text: 'self:Foo()', rank: 1 as const },
  ]
  const merged = mergeHits([ext.hits, text])
  assert.equal(merged.length, 3, '同一行只留一条')
  assert.equal(merged[0].file, 'Content/Script/a.lua')
  const many = Array.from({ length: 300 }, (_, i) => ({
    file: `x/${'f'.repeat(40)}${i}.lua`,
    line: i + 1,
    rank: 1 as const,
  }))
  const page = formatHits(many, { ...r, limit: 200 }, [])
  assert.ok(page.length < 4000)
  assert.match(page, /还有 \d+ 条：offset=\d+ 接着看/)
  assert.equal(formatHits([], r, []), '没有找到。')
  assert.equal(parseFindJson({ nope: 1 }, r, []), undefined, '认不出的形状交给调用方按出错处理')
})

test('文本兜底认得常见的声明写法', () => {
  const lua = declRe('OnInit', 'lua')
  for (const l of [
    'function M:OnInit()',
    'local function OnInit(a)',
    'M.OnInit = function()',
    'function UI.Main.OnInit (self)',
  ])
    assert.ok(lua.test(l), l)
  assert.ok(!lua.test('self:OnInit()'))
  assert.ok(!lua.test('if x.OnInit == nil then'))
  const cpp = declRe('UMyComp', 'cpp')
  assert.ok(cpp.test('class MYGAME_API UMyComp : public UActorComponent'))
  assert.ok(declRe('Tick', 'cpp').test('void UMyComp::Tick(float Dt)'))
  assert.ok(!declRe('Tick', 'cpp').test('  Comp->Tick(0.1f);'))
})

test('仅路由器模式的命令：值有空格加引号，数组传 JSON', () => {
  assert.equal(
    routerCommand('lua_code', { action: 'search', query: 'On Init', kinds: ['function'], n: undefined }),
    'lua_code --action search --query "On Init" --kinds ["function"]',
  )
})

const src = (id: string, rank: number, o: Partial<RouteSource<string, string[]>>): RouteSource<string, string[]> => ({
  id,
  rank,
  accepts: () => true,
  ready: () => ({ state: 'ready' }),
  run: async () => [id],
  ...o,
})

test('路由：用不了的跳过并记原因、正在启动的等它、出错的往下走、够了就停，每次都记一条', async () => {
  let starting = 2
  const r = await route<string, string[]>({
    capability: 'find',
    projectId: 'p-route',
    entry: 'test',
    what: 'x',
    req: 'x',
    waitMs: 10_000,
    sources: [
      src('text', 1000, {}),
      src('down', 1, { ready: () => ({ state: 'down', why: '没开' }) }),
      src('boom', 2, { run: async () => Promise.reject(new Error('炸了')) }),
      src('slow', 3, {
        ready: () => (starting-- > 0 ? { state: 'starting', why: '建索引', etaMs: 200 } : { state: 'ready' }),
      }),
      src('empty', 4, { run: async () => [] }),
      src('other-lang', 5, { accepts: () => false }),
    ],
    isEmpty: (o) => !o.length,
    enough: (s) => s.id === 'slow',
  })
  assert.deepEqual(
    r.outs.map((x) => x.source),
    ['slow'],
  )
  assert.deepEqual(
    r.steps.map((s) => [s.source, s.outcome]),
    [
      ['down', 'skipped'],
      ['boom', 'failed'],
      ['slow', 'used'],
    ],
  )
  assert.equal(routeLog('p-route')[0].served, 'slow')
  assert.match(routeLog('p-route')[0].steps[1].why ?? '', /炸了/)
})

test('文本兜底：候选文件从索引取、声明排前，独立分支里读对话目录那份', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'route-text-'))
  const wt = await mkdtemp(path.join(os.tmpdir(), 'route-wt-'))
  try {
    await mkdir(path.join(dir, 'S'))
    await mkdir(path.join(wt, 'S'))
    await writeFile(path.join(dir, 'S/a.lua'), 'local M = {}\nfunction M:OnInit()\nend\n')
    await writeFile(path.join(dir, 'S/b.lua'), 'x:OnInit()\n-- OnInitX 不算\n')
    await writeFile(path.join(wt, 'S/b.lua'), 'y:OnInit()\n')
    const files = ['S/a.lua', 'S/b.lua']
    const idx = {
      ready: async () => true,
      // 和真的索引一样：空查询不回结果
      find: (q: string, o: { ext?: string[] }) =>
        (q ? files : [])
          .filter((f) => !o.ext || o.ext.includes(f.split('.').pop()!))
          .map((f) => ({ path: f, abs: path.join(dir, f), score: 0 })),
    } as never
    const s = textSource(async () => idx)
    const refs = await s.run(req('refs', 'M:OnInit'))
    assert.deepEqual(
      mergeHits([refs.hits]).map((h) => [h.file, h.line, h.rank]),
      [
        ['S/a.lua', 2, 0],
        ['S/b.lua', 1, 1],
      ],
    )
    const sym = await s.run(req('symbol', 'OnInit', { lang: 'lua' }))
    assert.deepEqual(
      sym.hits.map((h) => h.file),
      ['S/a.lua'],
      'symbol 只要声明',
    )
    // 独立分支：b.lua 读对话目录那份，a.lua 那边没有就不算
    const inWt = textSource(
      async () => idx,
      (f) => (f.path === 'S/b.lua' ? { ...f, abs: path.join(wt, f.path) } : undefined),
    )
    const r = await inWt.run(req('refs', 'OnInit', { lang: 'lua' }))
    assert.deepEqual(
      r.hits.map((h) => h.text),
      ['y:OnInit()'],
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(wt, { recursive: true, force: true })
  }
})

// 假的 stdio MCP 服务：lua_code 第一次答「正在建索引」，之后按参数回结果；记下收到的参数
const FAKE = `
let n = 0
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
let buf = ''
process.stdin.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    const m = JSON.parse(line)
    if (m.id === undefined) continue
    if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { serverInfo: { name: 'fake' }, capabilities: {} } })
    else if (m.method === 'tools/call') {
      n++
      if (n === 1) send({ jsonrpc: '2.0', id: m.id, result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'indexing', message: '稍后' }) }] } })
      else send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify({ items: [{ name: 'OnInit', kind: 'method', container: 'M', file: process.cwd() + '/S/a.lua', line: 2, args: m.params.arguments }] }) }] } })
    } else send({ jsonrpc: '2.0', id: m.id, result: {} })
  }
})
`

test('外部路：面板自己当客户端调别家的 MCP 工具，服务在建索引时等它，结果路径换成相对项目根', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'route-ext-'))
  try {
    await writeFile(path.join(dir, 'fake.mjs'), FAKE)
    const spec: ExternalFindSource = {
      id: 'idea.lua_code',
      tool: 'lua_code',
      kinds: ['symbol'],
      langs: ['lua'],
      rank: 10,
      args: (r) => ({ action: 'search', query: r.query, limit: r.offset + r.limit }),
    }
    const server = {
      name: 'idea-fake',
      transport: 'stdio' as const,
      command: process.execPath,
      args: [path.join(dir, 'fake.mjs')],
      env: {},
      url: '',
      headers: {},
    }
    const none = externalSource(spec, [{ name: 'x', server, cwd: dir, tools: ['other'] }], {
      projectId: 'p',
      dirs: [dir],
    })
    assert.equal((await none.ready(req('symbol', 'OnInit', { lang: 'lua' }))).state, 'down', '服务上没有这个工具就跳过')
    const s = externalSource(spec, [{ name: 'idea-fake', server, cwd: dir, tools: ['lua_code'] }], {
      projectId: 'p',
      dirs: [dir],
    })
    const r = await s.run(req('symbol', 'OnInit', { lang: 'lua' }))
    assert.deepEqual(
      r.hits.map((h) => [h.file, h.line, h.name, h.container]),
      [['S/a.lua', 2, 'OnInit', 'M']],
    )
  } finally {
    closeMcpPool()
    await rm(dir, { recursive: true, force: true })
  }
})
