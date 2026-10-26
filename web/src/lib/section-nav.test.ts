import assert from 'node:assert/strict'
import { test } from 'node:test'
import { activeIndex, atBottom, BOTTOM_SLACK, jumpTop, SCROLL_GAP, sortByDocument } from './section-nav.ts'

// tops 是各小节顶部相对容器视口顶部的距离：已经滚过去的是负数，还没到的是正数。

test('当前小节：取已经越过容差线的最后一个', () => {
  // 刚进页面，第一个小节的顶部就在容器顶部，其余都在下面
  assert.equal(activeIndex([0, 600, 1200]), 0)
  // 滚了 100：第二小节还没到线（500 > 12），仍算第一个
  assert.equal(activeIndex([-100, 500, 1100]), 0)
  // 第二小节标题正好贴住顶部：算第二个
  assert.equal(activeIndex([-600, 0, 600]), 1)
  // 标题落在留白里也算（用户视角已经在看这一节了）
  assert.equal(activeIndex([-600, -SCROLL_GAP, 600]), 1)
  // 超出留白 1px 就不算：容差是「距离不超过留白」，滚过去多少都是这一节
  assert.equal(activeIndex([-600, SCROLL_GAP + 1, 600]), 0)
})

test('当前小节：滚到底时算最后一个，短内容也不落下', () => {
  // 最后一段内容很短，它的顶部还没越过容差线，但已经到底了
  assert.equal(activeIndex([-3000, -2000, -500], true), 2)
  // 一个小节都没有时不报错（分节里没有 Group title 的页）
  assert.equal(activeIndex([], false), -1)
  assert.equal(activeIndex([], true), -1)
})

test('滚到底的判定：贴着底部就算，内容比可视区矮也算', () => {
  assert.ok(atBottom({ scrollTop: 900, clientHeight: 100, scrollHeight: 1000 }))
  assert.ok(atBottom({ scrollTop: 1000 - 100 - BOTTOM_SLACK, clientHeight: 100, scrollHeight: 1000 }))
  assert.ok(!atBottom({ scrollTop: 800, clientHeight: 100, scrollHeight: 1000 }))
  // 内容比可视区还短：滚不动，只能看到最后那段
  assert.ok(atBottom({ scrollTop: 0, clientHeight: 800, scrollHeight: 300 }))
})

test('跳转位置：头部留白，不滚成负数', () => {
  assert.equal(jumpTop(1000), 1000 - SCROLL_GAP)
  // 第一个小节在顶部：留白不能把滚动位置算成负的
  assert.equal(jumpTop(0), 0)
  assert.equal(jumpTop(5), 0)
})

test('小节按页面位置排，不信挂载顺序（条件渲染的组重新挂载后会被 append 到末尾）', () => {
  // 模拟 DOM 顺序：a < b < c。下面的登记顺序故意是 a、c、b（b 是后挂载的条件渲染组）
  // 每个小节一个「节点」，用对象身份在这张表里定它属于谁，模拟 compareDocumentPosition 的语义
  const positions = new Map<object, number>()
  const node = (id: string, at: number, connected = true) => {
    const el = {
      isConnected: connected,
      // 简化版：对方在文档里靠后时带 FOLLOWING(4) 位，否则带 PRECEDING(2)
      compareDocumentPosition: (o: object) => ((positions.get(el) ?? 0) < (positions.get(o) ?? 0) ? 4 : 2),
    }
    positions.set(el, at)
    return { id, el }
  }
  const a = node('a', 0)
  const b = node('b', 1)
  const c = node('c', 2)
  assert.deepEqual(
    sortByDocument([a, c, b]).map((x) => x.id),
    ['a', 'b', 'c'],
  )
  // 先 push 的一批本来就是顺序的，排序不改变
  assert.deepEqual(
    sortByDocument([a, b, c]).map((x) => x.id),
    ['a', 'b', 'c'],
  )
})

test('小节表滤掉已经不在文档里的死项（开发时热更新会留下）', () => {
  const node = (id: string, connected: boolean) => ({
    id,
    el: {
      isConnected: connected,
      compareDocumentPosition: () => 2,
    },
  })
  assert.deepEqual(
    sortByDocument([node('a', true), node('gone', false), node('b', true)]).map((x) => x.id),
    ['a', 'b'],
  )
})
