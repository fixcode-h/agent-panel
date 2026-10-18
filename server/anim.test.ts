import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  animRuntimeSource,
  compileAnimations,
  exportAnimations,
  looseAnimation,
  presetTracks,
  sampleTrack,
} from '../shared/anim.ts'
import { applyOp } from '../shared/design-ops.ts'
import { newWidget, insertWidget } from '../shared/umg.ts'

test('预设展开：多个控件按 stagger 错开，开始前保持第一帧', () => {
  const r = presetTracks({ preset: 'fade-in-up', widgets: ['A', 'B'], stagger: 0.1 })
  assert.equal(r.error, undefined)
  assert.equal(r.tracks.length, 4)
  const b = r.tracks.find((t) => t.widget === 'B' && t.prop === 'RenderOpacity')!
  assert.deepEqual(
    b.keys.map((k) => k.t),
    [0, 0.1, 0.6],
  )
  assert.equal(sampleTrack(b, 0.05), 0)
})

test('AI 写的动画宽松地认：属性别名、[x,y] 写法、预设', () => {
  const r = looseAnimation({
    name: 'Anim_Open',
    tracks: [
      {
        widget: 'Panel',
        prop: 'scale',
        keys: [
          { t: 0, v: 0.8, ease: 'back-out' },
          { t: '0.3', v: [1, 1] },
        ],
      },
    ],
    presets: [{ preset: 'fade-in', widgets: ['Panel'] }],
  })
  assert.ok('animation' in r)
  const a = r.animation
  assert.equal(a.tracks.length, 2)
  assert.deepEqual(a.tracks[0].keys[0].v, { X: 0.8, Y: 0.8 })
  assert.ok('error' in looseAnimation({ name: '打开', tracks: [] }))
})

test('设计操作：加动画检查控件存在，改名时轨道跟着改', () => {
  let root = newWidget('CanvasPanel', 'Root')
  root = insertWidget(root, root.id, newWidget('Image', 'Panel'))
  const s = { root, components: [], animations: [] }
  assert.ok(
    'error' in
      applyOp(s, { op: 'setAnimation', animation: { name: 'A', presets: [{ preset: 'pop-in', widgets: ['Nope'] }] } }),
  )
  const r = applyOp(s, {
    op: 'setAnimation',
    animation: { name: 'A', presets: [{ preset: 'pop-in', widgets: ['Panel'] }] },
  })
  assert.ok('state' in r)
  const r2 = applyOp(r.state, { op: 'rename', target: 'Panel', name: 'Frame' })
  assert.ok('state' in r2)
  assert.ok(r2.state.animations!.every((a) => a.tracks.every((t) => t.widget === 'Frame')))
})

test('导出：UE 关键帧按 30 帧取点，网页播放代码能解析', () => {
  const r = looseAnimation({ name: 'A', presets: [{ preset: 'pop-in', widgets: ['P'] }] })
  assert.ok('animation' in r)
  const ue = exportAnimations([r.animation])
  assert.equal(ue[0].Trigger, 'Construct')
  const scale = ue[0].Tracks.find((t) => t.Property === 'RenderTransform.Scale')!
  assert.ok(scale.Keys.length > 10)
  const src = animRuntimeSource(compileAnimations([r.animation]))
  assert.doesNotThrow(() => new Function(src))
})
