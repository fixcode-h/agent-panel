/**
 * 附件缩略图测试：只缩 PNG、保持比例和颜色、比目标小的和别的格式退回原图。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { blank, decodePng, encodePng } from './image.ts'

// 数据目录（缩略图缓存放在它下面的 cache 里）在模块加载时就定死：
// 先把 AGENT_PANEL_DATA 指到临时目录，再加载被测模块，不写本机真实的数据目录
const dataDir = mkdtempSync(path.join(tmpdir(), 'thumb-data-'))
process.env.AGENT_PANEL_DATA = dataDir
const srcDir = mkdtempSync(path.join(tmpdir(), 'thumb-src-'))
process.on('exit', () => {
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(srcDir, { recursive: true, force: true })
})
const { MAX_THUMB_PIXELS, MAX_THUMB_WIDTH, thumbnail } = await import('./thumbnail.ts')

const COLOR: [number, number, number, number] = [30, 120, 200, 255]
const png = (w: number, h: number) => encodePng(blank(w, h, COLOR))
let seq = 0
const write = (buf: Buffer) => {
  const file = path.join(srcDir, `img-${++seq}.png`)
  writeFileSync(file, buf)
  return file
}

test('按宽度缩小，比例和颜色不变', async () => {
  const out = await thumbnail(write(png(1200, 600)), 300)
  const img = decodePng(out!)!
  assert.deepEqual([img.width, img.height], [300, 150])
  assert.deepEqual([...img.data.subarray(0, 4)], [...COLOR])
})

test('同一张图要两次结果一致（第二次读的是缓存）', async () => {
  const file = write(png(800, 400))
  const a = await thumbnail(file, 200)
  const b = await thumbnail(file, 200)
  assert.ok(a && b)
  assert.deepEqual([...a], [...b])
})

test('比目标还小的图不缩（缩了反而糊）', async () => {
  assert.equal(await thumbnail(write(png(100, 100)), 640), null)
})

test('解不开的格式退回原图：调用方拿到 null 就自己用原图', async () => {
  // JPEG 的文件头，内容随便：image.ts 只认 PNG
  const file = path.join(srcDir, 'photo.jpg')
  writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]))
  assert.equal(await thumbnail(file, 640), null)
})

test('文件不在了返回 null', async () => {
  assert.equal(await thumbnail(path.join(srcDir, 'nope.png'), 640), null)
})

test('超过能解码的像素数直接回退原图：不能为了缩略图把服务端卡住', async () => {
  // 全 0 的图 deflate 很快，几十 MB 原始数据压完也只有几百 KB
  const side = Math.ceil(Math.sqrt(MAX_THUMB_PIXELS)) + 100
  assert.equal(await thumbnail(write(png(side, side)), 160), null)
})

test('请求的宽度超过上限时按上限缩', async () => {
  const out = await thumbnail(write(png(2400, 120)), 99_999)
  assert.equal(decodePng(out!)!.width, MAX_THUMB_WIDTH)
})
