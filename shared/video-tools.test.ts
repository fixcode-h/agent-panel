/**
 * 视频截帧进阶工具的纯逻辑：感知哈希、相似帧去重（只删自动帧、留最清楚的）、帧差找变化的框、标注和设置的校验。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_PREFS,
  FrameShape,
  HASH_H,
  HASH_W,
  VideoPrefs,
  boxesToShapes,
  dHash,
  diffBoxes,
  hamming,
  similarToDrop,
} from './video-tools.ts'

/** 9×8 的灰度图：f(x, y) 给每个点的亮度 */
const img = (f: (x: number, y: number) => number) => {
  const a = new Uint8Array(HASH_W * HASH_H)
  for (let y = 0; y < HASH_H; y++) for (let x = 0; x < HASH_W; x++) a[y * HASH_W + x] = f(x, y)
  return a
}

test('dHash：整体变亮哈希不变，画面内容变了才变', () => {
  const grad = img((x) => 200 - x * 20)
  const h = dHash(grad)
  assert.equal(h.length, 16)
  assert.equal(hamming(h, dHash(img((x) => 230 - x * 20))), 0, '整体亮度变化')
  assert.ok(hamming(h, dHash(img((x) => 20 + x * 20))) > 32, '明暗反过来')
  assert.equal(hamming('', h), 64, '算不出来的当成完全不同')
})

test('相似帧去重：相邻几乎一样的一组只留一张，有手动帧留手动帧，都是自动帧留最清楚的', () => {
  const a = '0000000000000000'
  const near = '0000000000000003' // 差 2 位
  const far = 'ffffffffffffffff'
  const fr = (id: string, time: number, hash: string, sharp: number, source: 'manual' | 'auto' = 'auto') => ({
    id,
    time,
    hash,
    sharp,
    source,
  })
  assert.deepEqual(similarToDrop([fr('1', 0, a, 1), fr('2', 1, near, 5), fr('3', 2, far, 1)]), ['1'])
  // 手动帧在组里：自动帧都删，手动帧留着（即使它不是最清楚的）
  assert.deepEqual(similarToDrop([fr('1', 0, a, 9), fr('m', 1, near, 1, 'manual')]), ['1'])
  // 两张手动帧几乎一样：都不删
  assert.deepEqual(similarToDrop([fr('m1', 0, a, 1, 'manual'), fr('m2', 1, a, 1, 'manual')]), [])
  // 不相邻的一样画面（中间隔了一张不同的）不算一组
  assert.deepEqual(similarToDrop([fr('1', 0, a, 1), fr('2', 1, far, 1), fr('3', 2, a, 1)]), [])
})

test('帧差：只框出变了的那块，整张都变时给整图框', () => {
  const w = 64
  const h = 32
  const a = new Uint8Array(w * h).fill(50)
  const b = new Uint8Array(a)
  // 右下角 16×8 的一块变亮
  for (let y = 16; y < 24; y++) for (let x = 40; x < 56; x++) b[y * w + x] = 220
  const boxes = diffBoxes(a, b, w, h)
  assert.equal(boxes.length, 1)
  assert.deepEqual(boxes[0], { x: 40 / w, y: 16 / h, w: 16 / w, h: 8 / h })
  assert.deepEqual(diffBoxes(a, a, w, h), [], '没变')
  assert.deepEqual(diffBoxes(a, new Uint8Array(w * h).fill(250), w, h), [{ x: 0, y: 0, w: 1, h: 1 }], '切镜头')
  assert.deepEqual(boxesToShapes(boxes)[0], { kind: 'rect', ...boxes[0], color: '#ef4444' })
})

test('标注和设置的校验：坐标超出 0~1 的不收，设置里坏掉的字段回到默认', () => {
  assert.ok(FrameShape.safeParse({ kind: 'arrow', x1: 0, y1: 0, x2: 1, y2: 1, color: '#fff' }).success)
  assert.ok(!FrameShape.safeParse({ kind: 'rect', x: 0, y: 0, w: 1.5, h: 1, color: '#fff' }).success)
  assert.ok(!FrameShape.safeParse({ kind: 'text', x: 0, y: 0, text: '  ', color: '#fff' }).success)
  assert.deepEqual(VideoPrefs.parse({ mode: 'bogus', count: 999, method: 'x', range: '' }), {
    ...DEFAULT_PREFS,
    method: 'x',
  })
})
