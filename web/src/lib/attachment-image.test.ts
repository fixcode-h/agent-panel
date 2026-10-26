/**
 * 消息里的图片能不能显示：附件找不到了（接口 404、文件被清理）时不能把地址交给 img，
 * 否则气泡和看大图的浮层里都是破图。这里只测结果怎么分，加载由浏览器完成。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { shownImages } from '@/lib/attachment-image'

test('能加载出来的图片：卡片用缩略图，看大图用原图', () => {
  const { urls, fulls, missing } = shownImages([
    ['attachments/截图.png', '/api/uploads/raw?path=a&w=640', '/api/uploads/raw?path=a', true],
    ['/data/uploads/x/图2.png', '/api/uploads/raw?path=b&w=640', '/api/uploads/raw?path=b', true],
  ])
  assert.deepEqual(urls, {
    'attachments/截图.png': '/api/uploads/raw?path=a&w=640',
    '/data/uploads/x/图2.png': '/api/uploads/raw?path=b&w=640',
  })
  assert.deepEqual(fulls, {
    'attachments/截图.png': '/api/uploads/raw?path=a',
    '/data/uploads/x/图2.png': '/api/uploads/raw?path=b',
  })
  assert.deepEqual(missing, {})
})

test('加载不出来的记成找不到：不给地址（不显示破图），由卡片显示附件已经不在了', () => {
  const { urls, fulls, missing } = shownImages([
    ['attachments/没了.png', '/api/uploads/raw?path=a&w=640', '/api/uploads/raw?path=a', false],
    ['/data/uploads/x/空的.png', '', '', false],
  ])
  assert.deepEqual(urls, {}, '破图的地址不进结果')
  assert.deepEqual(fulls, {})
  assert.deepEqual(missing, { 'attachments/没了.png': true, '/data/uploads/x/空的.png': true })
})

test('拿到地址才算成功：地址为空时不算能显示', () => {
  const { urls, missing } = shownImages([['/data/uploads/x/a.png', '', '', true]])
  assert.deepEqual(urls, {})
  assert.deepEqual(missing, { '/data/uploads/x/a.png': true })
})

test('没有原图地址时（在线演示）缩略图地址兜底，浮层也能打开', () => {
  const { fulls } = shownImages([['/data/uploads/x/a.png', 'blob:demo', '', true]])
  assert.deepEqual(fulls, { '/data/uploads/x/a.png': 'blob:demo' })
})
