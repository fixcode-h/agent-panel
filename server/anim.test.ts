import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  UiAnimation,
  animKeyState,
  animPropOfField,
  animRuntimeSource,
  animValueOf,
  compileAnimations,
  exportAnimations,
  looseAnimation,
  presetTracks,
  sampleTrack,
  setKeyAt,
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

test('属性面板只给可动画的字段打关键帧：透明度、位移、缩放、旋转', () => {
  assert.equal(animPropOfField('RenderOpacity'), 'RenderOpacity')
  assert.equal(animPropOfField('RenderTransform.Translation'), 'Translation')
  assert.equal(animPropOfField('RenderTransform.Scale'), 'Scale')
  assert.equal(animPropOfField('RenderTransform.Angle'), 'Angle')
  // 其他属性、悬停样式、断点里的字段都不打
  assert.equal(animPropOfField('Visibility'), undefined)
  assert.equal(animPropOfField('RenderTransformPivot'), undefined)
  assert.equal(animPropOfField('Hover.RenderOpacity'), undefined)
  assert.equal(animPropOfField('tablet.RenderOpacity'), undefined)
})

test('在当前时间打关键帧：没轨道就新建，同一时间更新值不重复，按钮状态跟着变', () => {
  const base = UiAnimation.parse({ name: 'A' })
  assert.equal(animKeyState(base, 'Panel', 'RenderOpacity', 0.5), 'no-track')
  const a = setKeyAt(base, 'Panel', 'RenderOpacity', 0.5, 0.3)
  assert.equal(a.tracks.length, 1)
  assert.deepEqual(
    a.tracks[0].keys.map((k) => [k.t, k.v]),
    [[0.5, 0.3]],
  )
  assert.equal(animKeyState(a, 'Panel', 'RenderOpacity', 0.5), 'key')
  assert.equal(animKeyState(a, 'Panel', 'RenderOpacity', 0.6), 'no-key')
  // 同一时间再打一次是更新，不是插一帧重复的；原来的缓动保留
  const b = setKeyAt(setKeyAt(a, 'Panel', 'RenderOpacity', 0.5, 0.8), 'Panel', 'RenderOpacity', 0.5, 0.9)
  assert.equal(b.tracks[0].keys.length, 1)
  assert.equal(b.tracks[0].keys[0].v, 0.9)
  assert.equal(b.tracks[0].keys[0].ease, 'ease-out')
  assert.equal(animKeyState(undefined, 'Panel', 'RenderOpacity', 0), 'no-anim')
})

test('关键帧的值取属性面板当前值：向量补轴、不是数就用初始值', () => {
  assert.deepEqual(animValueOf('Translation', { X: 10 }), { X: 10, Y: 0 })
  assert.deepEqual(animValueOf('Scale', undefined), { X: 1, Y: 1 })
  assert.equal(animValueOf('RenderOpacity', 0.4), 0.4)
  assert.equal(animValueOf('RenderOpacity', 'bad'), 1)
  assert.equal(animValueOf('Angle', 'bad'), 0)
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
