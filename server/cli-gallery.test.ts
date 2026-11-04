import assert from 'node:assert/strict'
import test from 'node:test'
import type { GallerySpec } from '../shared/cli-gallery.ts'
import { latestVersions, makeGallery, TOP_PAGES } from './cli-gallery.ts'

/** ADR 0050：不全量翻页，只取热门前 1000 个（4 次请求）缓存一小时；有搜索词直接问 npm；联网失败用旧的并说明 */

const spec: GallerySpec = { npmKeyword: 'pi-package', sourcePrefix: 'npm:', pageUrl: '', types: {} }
const page = (names: string[]) => ({
  objects: names.map((name, i) => ({ package: { name }, downloads: { monthly: 100 - i, weekly: 1 } })),
})

test('插件市场：前 1000 个取 4 页合并、一小时内不再取；有搜索词时带上关键词问一次；取不到时用旧数据并说明原因', async () => {
  const urls: string[] = []
  let now = Date.parse('2026-11-04T00:00:00Z')
  let down = false
  let saved: unknown = null
  const g = makeGallery({
    fetchJson: async (url) => {
      urls.push(url)
      if (down) throw new Error('ECONNRESET')
      const from = Number(new URL(url).searchParams.get('from'))
      return page(from === 0 ? ['a', 'b'] : from === 250 ? ['b', 'c'] : [])
    },
    load: async () => null,
    save: async (_cli, c) => {
      saved = c
    },
    now: () => now,
  })
  const first = await g.page('pi', spec, {})
  assert.equal(urls.length, TOP_PAGES)
  assert.deepEqual(
    first.items.map((x) => x.name),
    ['a', 'b', 'c'],
    '同名的只留一个',
  )
  assert.ok(saved, '写进磁盘缓存')
  await g.page('pi', spec, { sort: 'name', page: 2 })
  assert.equal(urls.length, TOP_PAGES, '一小时内用缓存')
  await g.page('pi', spec, { q: ' web ' })
  assert.equal(new URL(urls.at(-1)!).searchParams.get('text'), 'keywords:pi-package web')
  now += 2 * 60 * 60_000
  down = true
  const stale = await g.page('pi', spec, {})
  assert.match(stale.stale ?? '', /ECONNRESET/)
  assert.equal(stale.items.length, 3)
  await assert.rejects(g.page('pi', spec, { q: 'never' }), /ECONNRESET/, '没有旧数据就报错，带上原因')
  assert.deepEqual(
    await latestVersions(['a', 'a', 'x'], async (url) => {
      if (url.includes('/x/')) throw new Error('404')
      return { version: '2.0.0' }
    }),
    { a: '2.0.0' },
  )
})
