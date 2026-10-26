/** 抓取元素的设置：旧数据没有这一项要能读、值写错要退回默认，不因为一处脏数据让整份设置失效 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_PICK_BUTTON, DEFAULT_PICK_HOTKEY, ElementPicker, Settings } from '@shared/schema'

test('ElementPicker：默认是 `·` 中键', () => {
  assert.deepEqual(ElementPicker.parse({}), { hotkey: DEFAULT_PICK_HOTKEY, button: DEFAULT_PICK_BUTTON })
  assert.equal(DEFAULT_PICK_HOTKEY, '·')
  assert.equal(DEFAULT_PICK_BUTTON, 'middle')
})

test('ElementPicker：鼠标按键只认左中右，写错退回中键', () => {
  assert.equal(ElementPicker.parse({ button: 'left' }).button, 'left')
  assert.equal(ElementPicker.parse({ button: 'right' }).button, 'right')
  assert.equal(ElementPicker.parse({ button: '双击' }).button, 'middle')
  assert.equal(ElementPicker.parse({ button: 42 }).button, 'middle')
})

test('ElementPicker：快捷键留空、太长时退回默认，正常的写法原样留着', () => {
  assert.equal(ElementPicker.parse({ hotkey: 'Ctrl+Shift+K' }).hotkey, 'Ctrl+Shift+K')
  // 前后空格是手打进去的，存进去没用
  assert.equal(ElementPicker.parse({ hotkey: '  ·  ' }).hotkey, '·')
  assert.equal(ElementPicker.parse({ hotkey: '' }).hotkey, DEFAULT_PICK_HOTKEY)
  assert.equal(ElementPicker.parse({ hotkey: 7 }).hotkey, DEFAULT_PICK_HOTKEY)
  assert.equal(ElementPicker.parse({ hotkey: 'x'.repeat(41) }).hotkey, DEFAULT_PICK_HOTKEY)
})

test('Settings：以前存的设置（没有 elementPicker）读出来用默认值', () => {
  const settings = Settings.parse({ developerMode: true })
  assert.deepEqual(settings.elementPicker, { hotkey: DEFAULT_PICK_HOTKEY, button: DEFAULT_PICK_BUTTON })
  // 只写了其中一项：另一项用默认值
  assert.deepEqual(Settings.parse({ elementPicker: { button: 'left' } }).elementPicker, {
    hotkey: DEFAULT_PICK_HOTKEY,
    button: 'left',
  })
})
