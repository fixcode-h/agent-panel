/**
 * 弹窗拖拽调整大小的纯逻辑：尺寸约束、按弹窗记忆、四边/四角拖拽的计算。
 * 这里测的就是界面拖拽真正用的那条口径，浏览器里只负责把数值套到样式上。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  clampDialogSize,
  modalSizeBounds,
  modalSizeKey,
  MODAL_MIN_SIZE,
  MODAL_SIZE_STORAGE_PREFIX,
  MODAL_VIEWPORT_GAP,
  readModalSize,
  resizeDialogSize,
  writeModalSize,
  type DialogSizeBounds,
} from './modal-size.ts'

const bounds = (viewportW = 1440, viewportH = 900) => modalSizeBounds(viewportW, viewportH)

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  }
}

function withBounds(overrides: Partial<DialogSizeBounds>): DialogSizeBounds {
  return { ...bounds(), ...overrides }
}

test('视口上限：四周各留 30px，最小尺寸不超过视口', () => {
  const normal = bounds()
  assert.equal(normal.maxW, 1440 - MODAL_VIEWPORT_GAP * 2)
  assert.equal(normal.maxH, 900 - MODAL_VIEWPORT_GAP * 2)
  assert.equal(normal.minW, MODAL_MIN_SIZE.w)
  assert.equal(normal.minH, MODAL_MIN_SIZE.h)

  // 视口比最小尺寸还小时，min 收到 max 以内，弹窗不会顶出屏幕
  const tiny = bounds(300, 250)
  assert.equal(tiny.maxW, 240)
  assert.equal(tiny.maxH, 190)
  assert.ok(tiny.minW <= tiny.maxW)
  assert.ok(tiny.minH <= tiny.maxH)
})

test('尺寸约束：低于最小值抬到最小、超过上限压回上限、小数取整', () => {
  const b = bounds()
  assert.deepEqual(clampDialogSize({ w: 100, h: 80 }, b), { w: 320, h: 200 })
  assert.deepEqual(clampDialogSize({ w: 5000, h: 5000 }, b), { w: 1380, h: 840 })
  assert.deepEqual(clampDialogSize({ w: 520.4, h: 320.6 }, b), { w: 520, h: 321 })
  // 视口极小：以视口能放下的尺寸为准
  const tiny = bounds(300, 250)
  assert.deepEqual(clampDialogSize({ w: 1000, h: 1000 }, tiny), { w: 240, h: 190 })
})

test('左右边只改宽、上下边只改高：被拖的那条边跟手（对称伸缩，位移乘 2）', () => {
  const start = { w: 520, h: 320 }
  assert.deepEqual(resizeDialogSize(start, 1, 0, 50, 0, bounds()), { w: 620, h: 320 })
  assert.deepEqual(resizeDialogSize(start, -1, 0, -50, 0, bounds()), { w: 620, h: 320 })
  assert.deepEqual(resizeDialogSize(start, 0, -1, 0, -40, bounds()), { w: 520, h: 400 })
  assert.deepEqual(resizeDialogSize(start, 0, 1, 0, 40, bounds()), { w: 520, h: 400 })
  // 反方向拖也只是按约束缩到最小/上限
  assert.deepEqual(resizeDialogSize(start, 1, 0, -500, 0, bounds()), { w: 320, h: 320 })
})

test('四角按拖拽开始时的宽高比等比缩放', () => {
  const start = { w: 400, h: 300 }
  // 两轴位移都换算成 1.1 倍
  assert.deepEqual(resizeDialogSize(start, 1, 1, 20, 15, bounds()), { w: 440, h: 330 })
  // 只有横向动、纵向没动时也按横向的缩放比例同步改高（40px → 宽 480，1.2 倍 → 高 360）
  assert.deepEqual(resizeDialogSize(start, 1, 1, 40, 0, bounds()), { w: 480, h: 360 })
  // 只有纵向动时同理（30px → 高 360，1.2 倍 → 宽 480）
  assert.deepEqual(resizeDialogSize(start, 1, 1, 0, 30, bounds()), { w: 480, h: 360 })
  // 缩小同样保持比例（左上角往右下收 20/15px → 0.9 倍）
  assert.deepEqual(resizeDialogSize(start, -1, -1, 20, 15, bounds()), { w: 360, h: 270 })
})

test('四角缩放也要受最小尺寸和视口上限约束，且不破坏比例', () => {
  const start = { w: 400, h: 300 }
  // 放大到视口上限前先被 limit scale 截住
  const grown = resizeDialogSize(start, 1, 1, 500, 500, withBounds({ maxW: 500, maxH: 1000 }))
  assert.deepEqual(grown, { w: 500, h: 375 })
  // 缩到最小时比例仍然保持（320/400 = 0.8 → 300 * 0.8 = 240）
  const shrunk = resizeDialogSize(start, -1, -1, 500, 500, withBounds({ minW: 320, minH: 200 }))
  assert.deepEqual(shrunk, { w: 320, h: 240 })
})

test('记忆键：显式 key 优先，否则用「尺寸档 + 标题」区分弹窗', () => {
  assert.equal(modalSizeKey('file-diff', '差异', 'xl'), 'file-diff')
  assert.equal(modalSizeKey('  ', '设置', 'xl'), 'xl:设置')
  assert.equal(modalSizeKey(undefined, ' 设置 ', 'xl'), 'xl:设置')
  // 标题不是字符串（富标题、null）时退回档位，至少同档的窗口共用一份记忆
  assert.equal(modalSizeKey(undefined, null, 'sm'), 'sm')
  assert.equal(modalSizeKey(undefined, 123, 'sm'), 'sm')
  // 不同标题、不同档各自一份，不会互相串
  assert.notEqual(modalSizeKey(undefined, '设置', 'xl'), modalSizeKey(undefined, '新建项目', 'xl'))
  assert.notEqual(modalSizeKey(undefined, '设置', 'xl'), modalSizeKey(undefined, '设置', 'lg'))
})

test('尺寸记忆：写入后能读回，按 key 隔开', () => {
  const storage = memoryStorage()
  writeModalSize(storage, 'xl:设置', { w: 1280.4, h: 720.6 })
  assert.equal(storage.data.get(`${MODAL_SIZE_STORAGE_PREFIX}xl:设置`), '{"w":1280,"h":721}')
  assert.deepEqual(readModalSize(storage, 'xl:设置'), { w: 1280, h: 721 })
  assert.equal(readModalSize(storage, 'xl:新建项目'), null)
})

test('尺寸记忆：坏数据、非正数、读写异常都当作没有记忆', () => {
  const storage = memoryStorage({
    [`${MODAL_SIZE_STORAGE_PREFIX}xl:坏 JSON`]: 'not json',
    [`${MODAL_SIZE_STORAGE_PREFIX}xl:零宽`]: '{"w":0,"h":300}',
    [`${MODAL_SIZE_STORAGE_PREFIX}xl:负数`]: '{"w":-1,"h":-1}',
    [`${MODAL_SIZE_STORAGE_PREFIX}xl:字符串`]: '{"w":"800","h":600}',
  })
  assert.equal(readModalSize(storage, 'xl:坏 JSON'), null)
  assert.equal(readModalSize(storage, 'xl:零宽'), null)
  assert.equal(readModalSize(storage, 'xl:负数'), null)
  assert.equal(readModalSize(storage, 'xl:字符串'), null)

  const throwing = {
    getItem: () => {
      throw new Error('blocked')
    },
    setItem: () => {
      throw new Error('quota')
    },
  }
  assert.equal(readModalSize(throwing, 'xl:设置'), null)
  assert.doesNotThrow(() => writeModalSize(throwing, 'xl:设置', { w: 800, h: 600 }))
})

test('恢复记忆值时要重新过一遍当前视口约束', () => {
  const storage = memoryStorage()
  writeModalSize(storage, 'xl:设置', { w: 1280, h: 720 })
  const restored = readModalSize(storage, 'xl:设置')
  assert.ok(restored)
  // 窗口缩到 1000x700：恢复的尺寸收进 940x640
  assert.deepEqual(clampDialogSize(restored, bounds(1000, 700)), { w: 940, h: 640 })
})
