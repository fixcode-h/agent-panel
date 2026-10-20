/**
 * 输入框里的行内卡片：文字里用「[图片:名字]」这样的标记表示，界面上渲染成一张小卡片，
 * 光标停在卡片旁边按一次退格就整张删掉。
 *
 * 发送时的规矩：Skill / 命令决定这一轮怎么跑，必须提到最前面交给服务端展开；
 * 图片、文件留在原来的位置，由 withAttachments 换成真实路径（没引用到的追加在末尾）。
 */
export type ChipKind = 'image' | 'file' | 'skill' | 'command'

export interface Chip {
  kind: ChipKind
  name: string
}

export type Segment = { text: string } | { chip: Chip }

const LABEL: Record<ChipKind, string> = { image: '图片', file: '文件', skill: '技能', command: '命令' }
const KIND: Record<string, ChipKind> = { 图片: 'image', 文件: 'file', 技能: 'skill', 命令: 'command' }

/** 标记是「[类型:名字]」，名字里不会再有方括号；没写全的（例如用户在讲数组）当普通文字 */
const marker = () => /\[(图片|文件|技能|命令):([^\[\]]+)\]/g

/** 卡片存进文字里的样子 */
export const chipMarker = (kind: ChipKind, name: string) => `[${LABEL[kind]}:${name}]`

/** 按出现顺序拆成文本段和卡片段 */
export function segments(value: string): Segment[] {
  const out: Segment[] = []
  const re = marker()
  let at = 0
  for (let m = re.exec(value); m; m = re.exec(value)) {
    if (m.index > at) out.push({ text: value.slice(at, m.index) })
    out.push({ chip: { kind: KIND[m[1]], name: m[2] } })
    at = m.index + m[0].length
  }
  if (at < value.length) out.push({ text: value.slice(at) })
  return out
}

const join = (list: Segment[]) =>
  list.map((s) => ('chip' in s ? chipMarker(s.chip.kind, s.chip.name) : s.text)).join('')

/** 去掉一张卡片：它旁边多出来的一个空格一起收掉，剩下的文字之间不会留两个空格 */
function removeAt(list: Segment[], i: number): Segment[] {
  const out = [...list]
  const next = out[i + 1]
  const prev = out[i - 1]
  const left = prev && 'text' in prev && prev.text.endsWith(' ')
  const right = next && 'text' in next && next.text.startsWith(' ')
  if (right) {
    // 两边都有空格时只留一个；卡片在最前面时开头的空格不要
    if (!prev || left) out[i + 1] = { text: (next as { text: string }).text.slice(1) }
  } else if (left && !next) {
    // 卡片在末尾：它前面补的空格不留着
    out[i - 1] = { text: (prev as { text: string }).text.slice(0, -1) }
  }
  out.splice(i, 1)
  return out
}

const isCommand = (s: Segment) => 'chip' in s && (s.chip.kind === 'skill' || s.chip.kind === 'command')

/** 文字里有哪些卡片 */
export const chips = (value: string) => segments(value).flatMap((s) => ('chip' in s ? [s.chip] : []))

/** Skill / 命令卡片：有它的话发送时由它决定这一轮怎么跑 */
export const commandChip = (value: string) => chips(value).find((c) => c.kind === 'skill' || c.kind === 'command')

/** 删掉一张指定的卡片：按类型和名字认（技能、命令也用它） */
export function removeChip(value: string, chip: Chip): string {
  const list = segments(value)
  const i = list.findIndex((s) => 'chip' in s && s.chip.kind === chip.kind && s.chip.name === chip.name)
  return i < 0 ? value : join(removeAt(list, i))
}

/** 附件从输入框里删掉时，把它那张卡片一起去掉 */
export function dropChip(value: string, name: string): string {
  const list = segments(value)
  const i = list.findIndex(
    (s) => 'chip' in s && s.chip.name === name && (s.chip.kind === 'image' || s.chip.kind === 'file'),
  )
  return i < 0 ? value : join(removeAt(list, i))
}

/** 发给服务端的内容。fallback：只放了附件、一个字没写时补上的一句话（例如「请查看附件」） */
export function forSend(value: string, fallback = ''): string {
  const list = segments(value)
  const head = list.find(isCommand)
  const typed = list.some((s) => 'text' in s && !!s.text.trim())
  const files = list.some((s) => 'chip' in s && (s.chip.kind === 'image' || s.chip.kind === 'file'))
  // Skill / 命令交给服务端展开，留在原位会变成普通文字，先摘掉
  let body = list
  for (let i = body.length - 1; i >= 0; i--) if (isCommand(body[i])) body = removeAt(body, i)
  const rest = join(body).trim()
  const text = typed ? rest : files ? fallback.trim() : ''
  const name = head && 'chip' in head ? head.chip.name : ''
  return name ? `/${name}${text ? ` ${text}` : ''}` : text
}
