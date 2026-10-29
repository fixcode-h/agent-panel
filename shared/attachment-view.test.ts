import assert from 'node:assert/strict'
import test from 'node:test'
import {
  blocksSend,
  chipTextOf,
  formatSize,
  itemPath,
  routeOf,
  sendAttachmentOf,
  sendAttachments,
  type ItemLike,
} from './attachment-view.ts'

const item = (x: Partial<ItemLike> = {}): ItemLike => ({
  name: 'a.txt',
  mime: 'text/plain',
  size: 10,
  state: 'ready',
  ...x,
})

test('阈值分流、发送取哪份、拦发送和卡片显示', () => {
  assert.equal(routeOf(10, 10), 'copy')
  assert.equal(routeOf(11, 10), 'ref')
  assert.equal(routeOf(0, 10), 'copy')
  const source = '/home/me/需求.pdf'
  const copying = item({ source, state: 'copying' })
  assert.deepEqual(sendAttachmentOf(copying), {
    name: 'a.txt',
    path: source,
    size: 10,
    mime: 'text/plain',
    ref: true,
  })
  assert.equal(sendAttachmentOf(item({ source, state: 'ref' }))?.ref, true, '拷不了就降级成引用原路径')
  const done = { name: 'a.txt', path: '/data/uploads/1/a.txt', size: 10, mime: 'text/plain' }
  assert.deepEqual(sendAttachmentOf(item({ source, done, state: 'copied' })), done)
  // 卡片上显示 @路径和大小，引用卡片不换
  const shown = chipTextOf(item({ source: 'C:\\Users\\Me\\需求.pdf', size: 2048, state: 'copying' }))
  assert.equal(shown?.label, 'C:\\Users\\Me\\需求.pdf · 2 KB')
  assert.ok(shown?.status, '拷贝中要显示状态')
  assert.equal(chipTextOf(item({ quote: '一段话' })), undefined)
  // 没有原路径时用数据目录里的路径，最后退回文件名
  assert.equal(itemPath(item({ done: { name: 'b.txt', path: '/d/b.txt', size: 1, mime: '' } })), '/d/b.txt')
  assert.equal(itemPath(item()), 'a.txt')
  assert.equal(formatSize(512), '512 B')
  assert.equal(formatSize(2048), '2 KB')
  assert.equal(formatSize(3 * 1024 * 1024), '3.0 MB')
  // 没有路径的附件拦住发送；一批里只交出可发送的那些
  assert.equal(blocksSend(item({ state: 'locating' })), true)
  assert.equal(blocksSend(item({ state: 'uploading' })), true)
  // 引用卡片的原文还没传成文件时也要等
  assert.equal(blocksSend(item({ quote: '原文', state: 'uploading' })), true)
  const ready = { name: 'b.txt', path: '/d/b.txt', size: 1, mime: '' }
  assert.equal(blocksSend(item({ done: ready, state: 'ready' })), false)
  assert.deepEqual(
    sendAttachments([
      item({ done: ready, state: 'ready' }),
      item({ state: 'locating' }),
      item({ source: '/x/b.txt', state: 'copying' }),
    ]).map((a) => a.path),
    ['/d/b.txt', '/x/b.txt'],
  )
})
