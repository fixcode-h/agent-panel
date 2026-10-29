import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { searchFiles } from './locate-file.ts'

test('大文件按名字和大小在目录里找回原路径，同名同大小的挑修改时间最接近的', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-panel-locate-'))
  const deep = path.join(root, 'a', 'b')
  const other = path.join(root, 'c')
  mkdirSync(deep, { recursive: true })
  mkdirSync(other, { recursive: true })
  writeFileSync(path.join(deep, '录屏.mp4'), 'x'.repeat(100))
  writeFileSync(path.join(other, '录屏.mp4'), 'x'.repeat(100))
  writeFileSync(path.join(other, '别的.mp4'), 'x'.repeat(100))
  utimesSync(path.join(deep, '录屏.mp4'), new Date(1_000_000), new Date(1_000_000))
  utimesSync(path.join(other, '录屏.mp4'), new Date(9_000_000), new Date(9_000_000))
  const want = { name: '录屏.mp4', size: 100, mtime: 1_000_000 }
  const wrongSize = { name: '别的.mp4', size: 5 }
  const found = await searchFiles([want, wrongSize], [root])
  assert.equal(found.get(want)?.path, path.join(deep, '录屏.mp4'))
  assert.equal(found.has(wrongSize), false, '大小对不上的不算')

  // 被占用、正在写的文件：浏览器拿到的大小已经过时，宽松查找只比名字，挑修改时间最接近的
  const writing = { name: '录屏.mp4', size: 7, mtime: 9_000_000 }
  assert.equal((await searchFiles([writing], [root])).has(writing), false, '默认还是要求大小一致')
  const loose = await searchFiles([writing], [root], 4, 4000, true)
  assert.equal(loose.get(writing)?.path, path.join(other, '录屏.mp4'))
})
