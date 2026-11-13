/**
 * 插件市场缓存：先给缓存、刷新才重读、读失败给旧缓存带错误、记住最后用的仓库。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DEFAULT_MARKET, type MarketEntry } from './github.ts'
import { cacheDeps, currentMarketRepo, readMarketCached } from './market-cache.ts'

const entry = (version: string): MarketEntry => ({ id: 'ue', name: 'UE', version, description: '', icon: 'puzzle' })

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), 'market-cache-'))
  const calls: string[] = []
  let next: () => Promise<MarketEntry[] | undefined> = async () => [entry('1.0.0')]
  cacheDeps.file = () => path.join(dir, 'cache.json')
  cacheDeps.read = async (repo: string) => {
    calls.push(repo)
    return next()
  }
  return {
    calls,
    set: (f: typeof next) => (next = f),
    done: () => rm(dir, { recursive: true, force: true }),
  }
}

test('第一次读去 GitHub，之后先给缓存；刷新才重读', async () => {
  const s = await setup()
  const a = await readMarketCached('o/r')
  assert.equal(a.plugins?.[0].version, '1.0.0')
  s.set(async () => [entry('1.1.0')])
  const b = await readMarketCached('o/r')
  assert.equal(b.plugins?.[0].version, '1.0.0')
  assert.equal(s.calls.length, 1)
  const c = await readMarketCached('o/r', { refresh: true })
  assert.equal(c.plugins?.[0].version, '1.1.0')
  assert.equal(s.calls.length, 2)
  await s.done()
})

test('重读失败：给旧缓存并带上错误；没有缓存时直接报错', async () => {
  const s = await setup()
  await readMarketCached('o/r')
  s.set(async () => {
    throw new Error('读插件目录失败：断网')
  })
  const r = await readMarketCached('o/r', { refresh: true })
  assert.equal(r.plugins?.[0].version, '1.0.0')
  assert.match(r.error ?? '', /断网/)
  await assert.rejects(readMarketCached('x/y'), /断网/)
  await s.done()
})

test('没有 plugins.json 的仓库也缓存（null）', async () => {
  const s = await setup()
  s.set(async () => undefined)
  assert.equal((await readMarketCached('o/single')).plugins, null)
  assert.equal((await readMarketCached('o/single')).plugins, null)
  assert.equal(s.calls.length, 1)
  await s.done()
})

test('记住最后用的市场仓库；换回默认就不记', async () => {
  const s = await setup()
  assert.equal(await currentMarketRepo(), DEFAULT_MARKET)
  await readMarketCached('me/plugins', { remember: true })
  assert.equal(await currentMarketRepo(), 'me/plugins')
  // 检查更新顺带读别的仓库，不改最后用的
  await readMarketCached('other/repo')
  assert.equal(await currentMarketRepo(), 'me/plugins')
  await readMarketCached(DEFAULT_MARKET, { remember: true })
  assert.equal(await currentMarketRepo(), DEFAULT_MARKET)
  await s.done()
})
