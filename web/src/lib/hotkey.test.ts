/** 快捷键：录键、匹配（含 `·` 的键位兼容）、显示、输入框里不触发 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MODS,
  hotkeyFromEvent,
  hotkeyLabel,
  isTypingTarget,
  joinHotkey,
  matchesHotkey,
  parseHotkey,
  shouldTrigger,
  type KeyLike,
} from '@/lib/hotkey'

/** 一次按键：只写关心的字段，其余默认没按下 */
const ev = (key: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
})

test('parseHotkey：修饰键按固定顺序，写法大小写不敏感；认不出来返回 undefined', () => {
  assert.deepEqual(parseHotkey('Ctrl+Alt+K'), { mods: ['Ctrl', 'Alt'], key: 'K' })
  assert.deepEqual(parseHotkey('alt+ctrl+K'), { mods: ['Ctrl', 'Alt'], key: 'K' })
  assert.deepEqual(parseHotkey('·'), { mods: [], key: '·' })
  assert.equal(parseHotkey(''), undefined)
  assert.equal(parseHotkey('Ctrl+'), undefined)
  assert.equal(parseHotkey('Hyper+K'), undefined)
})

test('joinHotkey：修饰键顺序固定，可打印字符上的 Shift 归一掉', () => {
  assert.equal(joinHotkey(['Shift', 'Ctrl'], 'K'), 'Ctrl+K')
  assert.equal(joinHotkey(['Shift', 'Ctrl'], 'Enter'), 'Ctrl+Shift+Enter')
  assert.equal(joinHotkey(['Shift', 'Shift'] as never, '·'), '·')
  assert.equal(joinHotkey([], '·'), '·')
  assert.deepEqual([...MODS], ['Ctrl', 'Alt', 'Shift', 'Meta'])
})

test('parseHotkey：可打印字符上的 Shift 归一掉，手写 Ctrl+Shift+K 也能用', () => {
  // 录键不会存 Shift+字母，手写成 Ctrl+Shift+K 时不能变成一个永远匹配不上的值
  assert.deepEqual(parseHotkey('Ctrl+Shift+K'), { mods: ['Ctrl'], key: 'K' })
  assert.deepEqual(parseHotkey('Ctrl+Shift+·'), { mods: ['Ctrl'], key: '·' })
  // 命名键的 Shift 是修饰键，留着
  assert.deepEqual(parseHotkey('Shift+Enter'), { mods: ['Shift'], key: 'Enter' })
})

test('matchesHotkey：手写成 Ctrl+Shift+E 的快捷键按 Ctrl+E 能触发', () => {
  // 设置页文案里就举了 Ctrl+Shift+E 这个例子：归一之后按下去得有反应
  assert.equal(matchesHotkey(ev('e', { ctrlKey: true }), 'Ctrl+Shift+E'), true)
  assert.equal(matchesHotkey(ev('E', { ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+E'), true)
})

test('hotkeyFromEvent：录下按下的键，只按修饰键本身时继续等', () => {
  assert.equal(hotkeyFromEvent(ev('k', { ctrlKey: true })), 'Ctrl+k')
  assert.equal(hotkeyFromEvent(ev('·')), '·')
  // 只按了 Ctrl / Shift：还不算一次完整的快捷键
  assert.equal(hotkeyFromEvent(ev('Control', { ctrlKey: true })), undefined)
  assert.equal(hotkeyFromEvent(ev('Shift', { shiftKey: true })), undefined)
  // 输入法打开时按下的那个键
  assert.equal(hotkeyFromEvent(ev('Process')), undefined)
  assert.equal(hotkeyFromEvent(ev('+', { ctrlKey: true })), undefined)
  // 命名键的 Shift 要留：Enter 和 Shift+Enter 是两个快捷键
  assert.equal(hotkeyFromEvent(ev('Enter', { shiftKey: true })), 'Shift+Enter')
})

test('hotkeyFromEvent：可打印字符不记 Shift，字符本身已经带了 Shift 的效果', () => {
  // Shift+3 打出的是 '#'，下次按 '#' 就该触发，不能存成 Shift+#
  assert.equal(hotkeyFromEvent(ev('#', { shiftKey: true })), '#')
  // 反引号同理：Shift+` 打出来的是 '~'
  assert.equal(hotkeyFromEvent(ev('~', { shiftKey: true })), '~')
  // 字母也是：存 'K'，按 K 那一格（带不带 Shift 都打出同一个字符）就触发
  assert.equal(hotkeyFromEvent(ev('K', { shiftKey: true })), 'K')
})

test('matchesHotkey：修饰键要完全一致，多按一个 Ctrl 就不算', () => {
  assert.equal(matchesHotkey(ev('·'), '·'), true)
  assert.equal(matchesHotkey(ev('k', { ctrlKey: true }), 'Ctrl+k'), true)
  // 存的是 'K'（录键时按的 Shift+K）：下次按 K 那一格就触发，带不带 Shift 都行
  assert.equal(matchesHotkey(ev('K'), 'K'), true)
  assert.equal(matchesHotkey(ev('K', { shiftKey: true }), 'K'), true)
  // 多按一个 Alt 就不算 Ctrl+k
  assert.equal(matchesHotkey(ev('k', { ctrlKey: true, altKey: true }), 'Ctrl+k'), false)
  assert.equal(matchesHotkey(ev('k'), 'Ctrl+k'), false)
  assert.equal(matchesHotkey(ev('·'), ''), false)
  // 命名键的 Shift 是修饰键，不能送
  assert.equal(matchesHotkey(ev('Enter'), 'Shift+Enter'), false)
  assert.equal(matchesHotkey(ev('Enter', { shiftKey: true }), 'Shift+Enter'), true)
})

test('matchesHotkey：`·` 认反引号和小键盘小数点这两个物理键位（中文输入法、小键盘都能按出来）', () => {
  // 中文输入法打开时 IME 吃掉一次按键，e.key 是 Process，只能按 code 认
  assert.equal(matchesHotkey({ ...ev('Process'), code: 'Backquote' }, '·'), true)
  assert.equal(matchesHotkey({ ...ev('`'), code: 'Backquote' }, '·'), true)
  assert.equal(matchesHotkey({ ...ev('·'), code: 'NumpadDecimal' }, '·'), true)
  // 别的键的 code 不能误命中
  assert.equal(matchesHotkey({ ...ev('Process'), code: 'KeyA' }, '·'), false)
  // 按着 Shift 时反引号打出的不是 '·'，不认
  assert.equal(matchesHotkey({ ...ev('~', { shiftKey: true }), code: 'Backquote' }, '·'), false)
})

test('hotkeyLabel：给人看的写法，Mac 上换成符号', () => {
  assert.equal(hotkeyLabel('·'), '·')
  // 可打印字符上的 Shift 被归一掉（存的就是按那格键），显示也不带 Shift
  assert.equal(hotkeyLabel('Ctrl+Shift+K'), isMacLabel('Ctrl+K'))
  assert.equal(hotkeyLabel('Shift+Enter'), isMacLabel('Shift+Enter'))
  assert.equal(hotkeyLabel('Space'), 'Space')
  // 认不出来的原样显示，不要显示成空白
  assert.equal(hotkeyLabel('Ctrl+'), 'Ctrl+')
})

/** 测试跑在 node 里，navigator.platform 不一定是 Mac：按同一个判断给出期望值 */
function isMacLabel(text: string) {
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '')
  if (!mac) return text
  return text.replace('Ctrl+', '⌃').replace('Alt+', '⌥').replace('Shift+', '⇧').replace('Meta+', '⌘')
}

test('isTypingTarget：输入框、多行文本、下拉、contenteditable 都算在打字', () => {
  const el = (tag: string, extra: Record<string, unknown> = {}) =>
    ({ tagName: tag, isContentEditable: false, closest: () => null, ...extra }) as unknown as Element
  assert.equal(isTypingTarget(el('INPUT')), true)
  assert.equal(isTypingTarget(el('TEXTAREA')), true)
  assert.equal(isTypingTarget(el('SELECT')), true)
  assert.equal(isTypingTarget(el('DIV', { isContentEditable: true })), true)
  assert.equal(
    isTypingTarget(el('SPAN', { closest: (s: string) => (s.includes('contenteditable') ? {} : null) })),
    true,
  )
  assert.equal(isTypingTarget(el('DIV')), false)
  assert.equal(isTypingTarget(null), false)
})

test('shouldTrigger：不带修饰键的快捷键在输入框里不触发，带了 Ctrl / Alt / Meta 的照常触发', () => {
  const input = { tagName: 'TEXTAREA', isContentEditable: false, closest: () => null } as unknown as Element
  const body = { tagName: 'DIV', isContentEditable: false, closest: () => null } as unknown as Element
  assert.equal(shouldTrigger(ev('·'), input), false)
  assert.equal(shouldTrigger(ev('·'), body), true)
  assert.equal(shouldTrigger(ev('k', { ctrlKey: true }), input), true)
  assert.equal(shouldTrigger(ev('k', { altKey: true }), input), true)
  // Shift 不算：Shift+· 还是在打字
  assert.equal(shouldTrigger(ev('·', { shiftKey: true }), input), false)
})
