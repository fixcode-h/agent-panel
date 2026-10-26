/**
 * 快捷键：设置页录键、抓取模式的全局监听、按钮提示和面板上的显示共用这一份。
 *
 * 存进设置的是一个字符串（`·`、`Shift+·`、`Ctrl+Shift+K`）：能直接写进 JSON，也能手打改。
 * 解析、匹配、显示都按同一套规则，不会出现「录的时候一种写法、比的时候另一种写法」。
 */

/** 修饰键的固定顺序：存和显示都按这个顺序，'Shift+Ctrl+K' 不会变成和 'Ctrl+Shift+K' 两种值 */
export const MODS = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const
export type Mod = (typeof MODS)[number]

export interface Hotkey {
  mods: Mod[]
  key: string
}

/** 一个按键事件里用得上的那些（KeyboardEvent 有全部字段，测试里给假的也能对上） */
export interface KeyLike {
  key: string
  code?: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

/** 只按了修饰键本身时不算一次完整的快捷键 */
const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'CapsLock', 'Dead', 'Process', 'Unidentified'])

/**
 * 同一个物理键在不同键盘布局、输入法下打出来的字符不一样：这里把认得的别名列出来按 code 再认一次。
 * `·`（U+00B7）在中文输入法打开时就是反引号那个键打出来的，小键盘的小数点也常是它；
 * 录音时存的仍然是 `·`，这里只是让「按了那个位置的键」也能命中
 */
const CODE_ALIASES: Record<string, readonly string[]> = {
  '·': ['Backquote', 'NumpadDecimal'],
  '`': ['Backquote'],
  '~': ['Backquote'],
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

const MAC_LABELS: Record<Mod, string> = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘' }
/** 单字符键（'·'、'/'、'K'）：一个字符就是一个键 */
const isChar = (key: string) => [...key].length === 1

/**
 * 可打印字符不分大小写：'K' 和 'k' 是键盘上同一格，大小写锁定、输入法打开时打出来的不一样，
 * 按哪一次都应该触发。拿到的字符本身已经决定了大小写，不再另外算 Shift
 */
const sameKey = (a: string, b: string) =>
  isChar(a) && isChar(b) && /[a-z]/i.test(a) ? a.toLowerCase() === b.toLowerCase() : a === b

/**
 * Shift 要不要当成修饰键：只有命名键（Enter、F1、ArrowUp…）要。可打印字符的 Shift 已经体现在 e.key 里了——
 * Shift+3 打出来的是 '#'，把 Shift 也记进去的话，用户下次按 '#' 反而触发不了
 */
const shiftMatters = (key: string) => !isChar(key)

const modsOf = (e: KeyLike): Mod[] =>
  MODS.filter((m) => ({ Ctrl: e.ctrlKey, Alt: e.altKey, Shift: e.shiftKey, Meta: e.metaKey })[m])

/** 按固定顺序拼成快捷键字符串；可打印字符上的 Shift 一并归一掉（和 parseHotkey 同一个规则） */
export const joinHotkey = (mods: readonly Mod[], key: string): string =>
  [...MODS.filter((m) => mods.includes(m) && (m !== 'Shift' || shiftMatters(key))), key].join('+')

/** 拆成修饰键和主键；写法认不出来（例如空串、'Ctrl+'、不认识的名字）返回 undefined */
export function parseHotkey(hotkey: string): Hotkey | undefined {
  const parts = hotkey.trim().split('+')
  const key = parts.pop() ?? ''
  // 加号本身不做主键：'Ctrl++' 这种写法拆不开，也几乎没人会把加号当快捷键
  if (!key || key === '+') return undefined
  const mods: Mod[] = []
  for (const p of parts) {
    const mod = MODS.find((m) => m.toLowerCase() === p.trim().toLowerCase())
    if (!mod) return undefined
    if (!mods.includes(mod)) mods.push(mod)
  }
  // 可打印字符上的 Shift 归一掉：它已经体现在字符里（Shift+3 打出 '#'），录键也不会存它。
  // 不归一的话，手写成 Ctrl+Shift+K 的值永远匹配不上（held 里没有 Shift），用户按了没反应还没提示
  const keep = mods.filter((m) => m !== 'Shift' || shiftMatters(key))
  return { mods: MODS.filter((m) => keep.includes(m)), key }
}

/**
 * 按一次键得到的快捷键。只按了 Ctrl / Shift 这类修饰键本身、或者键名认不出来时返回 undefined（继续等下一次）。
 * 可打印字符不记 Shift（见 shiftMatters）：Shift+K 存成 'K'，下次按下 K 那一格就触发，不受键盘布局影响
 */
export function hotkeyFromEvent(e: KeyLike): string | undefined {
  const key = e.key
  if (!key || MODIFIER_KEYS.has(key) || key === '+') return undefined
  const mods = modsOf(e).filter((m) => m !== 'Shift' || shiftMatters(key))
  return joinHotkey(mods, key)
}

/**
 * 这次按键是不是这个快捷键。要求的修饰键都要按下、没要求的都要没按下。
 * 可打印字符上的 Shift 不算修饰键（它在 e.key 里），所以 Shift+K 也能命中存下来的 'K'，
 * 反过来按 Ctrl+Shift+K 也会命中 Ctrl+K：录的是哪一格键，按那一格就触发，不区分 Shift
 */
export function matchesHotkey(e: KeyLike, hotkey: string): boolean {
  const spec = parseHotkey(hotkey)
  if (!spec) return false
  const held = modsOf(e).filter((m) => m !== 'Shift' || shiftMatters(spec.key))
  if (spec.mods.length !== held.length || spec.mods.some((m) => !held.includes(m))) return false
  if (sameKey(e.key, spec.key)) return true
  // 键盘布局不同、或者输入法吃掉了一次按键（中文输入法下按反引号键打出的是 '·'，e.key 也可能给 Process）：
  // 按物理键位再认一次。按着 Shift 时不认：Shift+反引号打出的是 '~' 而不是 '·'
  const codes = CODE_ALIASES[spec.key]
  return !!codes && !e.shiftKey && !!e.code && codes.includes(e.code)
}

const keyLabel = (key: string) => (key === ' ' ? 'Space' : key)

/** 给人看的写法：Mac 上用 ⌘⌥⇧⌃，其他系统写 Ctrl / Alt / Shift / Win */
export function hotkeyLabel(hotkey: string): string {
  const spec = parseHotkey(hotkey)
  if (!spec) return hotkey
  if (!isMac) return joinHotkey(spec.mods, keyLabel(spec.key))
  return spec.mods.map((m) => MAC_LABELS[m]).join('') + keyLabel(spec.key)
}
/**
 * 焦点在能打字的地方吗：输入框、多行文本、下拉、contenteditable（对话输入框就是）。
 * 不带修饰键的快捷键在这里不触发，否则用户正打字想输入 '·' 就进了抓取模式
 */
export function isTypingTarget(el: Element | null | undefined): boolean {
  if (!el || !el.tagName) return false
  const tag = el.tagName.toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
  const node = el as HTMLElement
  if (node.isContentEditable) return true
  return typeof node.closest === 'function' && !!node.closest('[contenteditable="true"],[role="textbox"]')
}

/** 这次按键该不该触发快捷键：带了 Ctrl / Alt / Meta 的在输入框里也认（和浏览器快捷方式一致），其余只在不打字时认 */
export const shouldTrigger = (e: KeyLike, el: Element | null | undefined) =>
  !isTypingTarget(el) || e.ctrlKey || e.altKey || e.metaKey
