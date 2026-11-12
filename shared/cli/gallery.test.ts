import assert from 'node:assert/strict'
import test from 'node:test'
import { cautionOf, matchQuery, overlapNote, pageOf, parseSearch, sortItems, type GallerySpec } from './gallery.ts'
import { getCli } from '../clis.ts'

/** ADR 0050：插件市场从 npm 搜索接口取数据，本地排序、翻页；和面板功能重复的、看不到源码的只标出来 */

const spec: GallerySpec = {
  npmKeyword: 'pi-package',
  sourcePrefix: 'npm:',
  pageUrl: '',
  types: { 'pi-extension': '扩展' },
}
const obj = (name: string, monthly: number, date: string, more: Record<string, unknown> = {}) => ({
  package: {
    name,
    version: '1.0.0',
    description: `${name} desc`,
    keywords: ['pi-package', 'pi-extension'],
    date,
    publisher: { username: 'me' },
    links: { npm: `https://npm/${name}`, repository: `https://gh/${name}` },
  },
  downloads: { monthly, weekly: monthly / 4 },
  dependents: '3',
  flags: { insecure: 0 },
  ...more,
})

test('npm 搜索结果：装的来源带前缀、类型从关键词认、字段缺了不让整页失败；按下载、发布时间、名字排，翻页越界落到最后一页，搜索词本地再过滤一遍', () => {
  const items = parseSearch(
    {
      objects: [
        obj('b', 10, '2026-11-01'),
        obj('a', 10, '2026-10-01', { flags: { insecure: 1 } }),
        obj('c', 99, '2026-09-01'),
        { package: {} },
        { package: { name: 'bare' } },
      ],
    },
    spec,
  )
  assert.deepEqual(
    items.map((x) => x.source),
    ['npm:b', 'npm:a', 'npm:c', 'npm:bare'],
  )
  assert.deepEqual(items[0].types, ['扩展'])
  assert.equal(items[0].dependents, 3)
  assert.equal(items[3].npmUrl, 'https://www.npmjs.com/package/bare')
  assert.deepEqual(parseSearch({}, spec), [])
  assert.deepEqual(
    sortItems(items, 'monthly').map((x) => x.name),
    ['c', 'a', 'b', 'bare'],
    '同样的下载数按名字',
  )
  assert.deepEqual(
    sortItems(items, 'recent').map((x) => x.name),
    ['b', 'a', 'c', 'bare'],
  )
  assert.deepEqual(pageOf([1, 2, 3, 4, 5], 9, 2), { items: [5], page: 3, pages: 3, total: 5 })
  assert.deepEqual(pageOf([], 1, 2), { items: [], page: 1, pages: 1, total: 0 })
  assert.equal(cautionOf(items[1]), 'insecure')
  assert.equal(cautionOf(items[3]), 'noRepo')
  assert.equal(cautionOf(items[0]), '')
  // 搜索词每个都要出现在名称、描述、关键词或作者里：npm 带回来的不相关热门包去掉
  assert.deepEqual(
    matchQuery(items, 'BARE').map((x) => x.name),
    ['bare'],
  )
  assert.equal(matchQuery(items, 'pi-extension me').length, 3)
  assert.equal(matchQuery(items, '  ').length, 4)
})

test('Pi 的市场按 pi-package 关键词；和面板功能重复的包（MCP、子 Agent）写明重复在哪', () => {
  const pk = getCli('pi')!.packages!
  assert.equal(pk.gallery?.npmKeyword, 'pi-package')
  assert.match(overlapNote('pi-mcp-adapter', pk.overlaps), /MCP/)
  assert.match(overlapNote('PI-SUBAGENTS', pk.overlaps), /子对话/)
  assert.equal(overlapNote('pi-web-access', pk.overlaps), '')
})
