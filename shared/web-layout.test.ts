import assert from 'node:assert/strict'
import test from 'node:test'
import { webLayoutTree } from './web-layout.ts'
import { webLayoutFixtures } from './web-layout.fixtures.ts'

/** 按名字取算出来的位置（四舍五入到 0.1 像素）；期望值和画布在浏览器里量出来的一致（scripts/ui/11-umg-layout.mjs 每次推送对照） */
function rects(name: string) {
  const f = webLayoutFixtures().find((x) => x.name === name)!
  const by = new Map(webLayoutTree(f.root, { size: f.size, components: [] }).map((r) => [r.name, r]))
  return (n: string) => {
    const r = by.get(n)
    assert.ok(r, `没有算出 ${n}`)
    const k = (v: number) => Math.round(v * 10) / 10
    return [k(r.x), k(r.y), k(r.w), k(r.h)]
  }
}

test('网页：竖排的内边距和间距、横排的 between / center / evenly、fill 先扣掉内边距再平分、边框算在宽高里', () => {
  const at = rects('网页竖排和横排')
  assert.deepEqual(at('Header'), [40, 24, 1120, 64])
  assert.deepEqual(at('Logo'), [57, 40, 120, 32])
  assert.deepEqual(at('N2'), [1063, 44, 80, 24])
  assert.deepEqual(at('Left'), [40, 108, 426, 300])
  assert.deepEqual(at('Right'), [490, 108, 446, 300])
  assert.deepEqual(at('Dot'), [1040, 108, 40, 40])
  assert.deepEqual(at('Line'), [40, 428, 1120, 2])
  assert.deepEqual(at('Btn'), [520, 460, 160, 40])
  assert.deepEqual(at('Rest'), [40, 530, 1120, 246])
  assert.deepEqual(at('A'), [346.7, 726, 100, 50])
})

test('网页：换行按宽度分行、容器高度算上所有行；绝对定位按 Pin 贴角', () => {
  const at = rects('网页换行和绝对定位')
  assert.deepEqual(at('C4'), [20, 156, 260, 120])
  assert.deepEqual(at('C1Badge'), [242, 28, 30, 20])
  assert.deepEqual(at('Box'), [20, 276, 400, 200])
  assert.deepEqual(at('Center'), [205, 356, 50, 30])
  assert.deepEqual(at('Corner'), [22, 454, 396, 20])
})

test('网页：文字按字宽估、固定宽度里折行，后面的控件跟着往下排', () => {
  const at = rects('网页文字和控件')
  assert.deepEqual(at('Title'), [24, 24, 752, 48])
  assert.deepEqual(at('Body'), [24, 84, 300, 72])
  assert.deepEqual(at('After'), [24, 228, 752, 40])
})

test('网页：平板 / 手机用断点里的属性，Collapsed 的不画也不占位置', () => {
  const root = {
    id: 'p',
    Type: 'Frame' as const,
    Name: 'Page',
    Properties: { Width: 'fill', Height: 'fill', Direction: 'row', Mobile: { Direction: 'column' } },
    Children: [
      { id: 'a', Type: 'Frame' as const, Name: 'A', Properties: { Width: 100, Height: 50 } },
      {
        id: 'b',
        Type: 'Frame' as const,
        Name: 'B',
        Properties: { Width: 100, Height: 50, Mobile: { Visibility: 'Collapsed' } },
      },
      { id: 'c', Type: 'Frame' as const, Name: 'C', Properties: { Width: 100, Height: 50 } },
    ],
  }
  const desk = webLayoutTree(root, { size: { X: 800, Y: 600 }, components: [] })
  assert.equal(desk.find((r) => r.name === 'C')!.x, 200)
  const phone = webLayoutTree(root, { size: { X: 390, Y: 800 }, components: [], device: 'mobile' })
  assert.ok(!phone.some((r) => r.name === 'B'))
  assert.deepEqual([phone.find((r) => r.name === 'C')!.x, phone.find((r) => r.name === 'C')!.y], [0, 50])
})
