/**
 * 输入框里的行内卡片：文字里用「[图片:名字]」这样的标记表示，界面上渲染成一张小卡片，
 * 光标停在卡片旁边按一次退格就整张删掉。
 *
 * 发送时的规矩：Skill / 命令决定这一轮怎么跑，必须提到最前面交给服务端展开；
 * 图片、文件留在原来的位置，由 withAttachments 换成真实路径（没引用到的追加在末尾）；
 * 引用卡片对应一个带原文的附件（Attachment.quote），交给 Agent 时由 withAttachments 在原位换成引用块。
 *
 * 发出去的消息在对话里按同样的卡片显示；复制消息时卡片换成文件路径，粘贴回输入框时再按路径认回卡片（findPaths）。
 */
export type ChipKind = 'image' | 'file' | 'skill' | 'command' | 'quote'

export interface Chip {
  kind: ChipKind
  name: string
}

export type Segment = { text: string } | { chip: Chip }

const LABEL: Record<ChipKind, string> = { image: '图片', file: '文件', skill: '技能', command: '命令', quote: '引用' }
const KIND: Record<string, ChipKind> = { 图片: 'image', 文件: 'file', 技能: 'skill', 命令: 'command', 引用: 'quote' }

/** 标记是「[类型:名字]」，名字里不会再有方括号；没写全的（例如用户在讲数组）当普通文字 */
const marker = () => /\[(图片|文件|技能|命令|引用):([^[\]\n]+)\]/g

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

/** 附件类的卡片：背后有一个附件（图片、文件、引用），删卡片时附件也要一起去掉 */
export const isAttachChip = (kind: ChipKind) => kind === 'image' || kind === 'file' || kind === 'quote'

/** 附件从输入框里删掉时，把它那张卡片一起去掉 */
export function dropChip(value: string, name: string): string {
  const list = segments(value)
  const i = list.findIndex((s) => 'chip' in s && s.chip.name === name && isAttachChip(s.chip.kind))
  return i < 0 ? value : join(removeAt(list, i))
}

/** 卡片用到的附件字段（Attachment 的一部分，免得这里依赖 schema） */
export interface AttachLike {
  name: string
  path: string
  mime: string
  quote?: string
}

const IMAGE_NAME = /\.(png|jpe?g|gif|webp|bmp)$/i

/** 本机绝对路径（Windows 的 `C:\…` 和不带盘符的 `/…`）；拷进对话目录的附件是相对路径。shared 会打进前端，不能 import node:path */
export const isAbsolutePath = (p: string) => /^(?:[a-zA-Z]:[\\/]|[\\/])/.test(p)

/** 附件是哪种卡片：带原文的是引用，图片按类型或扩展名认，其他都是文件 */
export function attachChip(a: Pick<AttachLike, 'name' | 'mime' | 'quote'>): ChipKind {
  if (a.quote !== undefined) return 'quote'
  // mime 在 schema 里有默认值，但历史落盘数据没经过 zod 解析，可能没有这个字段
  return a.mime?.startsWith('image/') || IMAGE_NAME.test(a.name) ? 'image' : 'file'
}

/** 卡片对应的附件：先按名字和类型找，旧数据类型对不上时只按名字 */
export function attachOf<T extends AttachLike>(chip: Chip, list: readonly T[]): T | undefined {
  return list.find((a) => a.name === chip.name && attachChip(a) === chip.kind) ?? list.find((a) => a.name === chip.name)
}

/** 引用块：每行前面加「> 」，后面空一行再接着写 */
export function quoteBlock(text: string) {
  const body = text
    .trim()
    .split('\n')
    .map((l) => (l.trim() ? `> ${l}` : '>'))
    .join('\n')
  return `${body}\n\n`
}

/** 复制出来的路径：带空格、引号的用双引号包起来，粘贴回输入框时还能整段认出来 */
export const pathText = (p: string) => (/[\s'"]/.test(p) ? `"${p.replace(/"/g, '')}"` : p)

/**
 * 复制一条用户消息：卡片换成「@路径」（和输入框里引用文件的写法一致，引用给的是存原文的那个文件），
 * Skill / 命令写成「/名字」。文字里没有卡片的附件（旧消息）放在最前面，和对话里显示的位置一致。
 *
 * 路径和前后正文之间一定要留一个空格：不留的话复制出来是「…截图-210356.png前面是抓取的元素」，
 * 粘贴时 findPaths 会把这整段当成一个路径（路径里本来就可以有汉字），服务端 stat 不到这个「文件」，
 * 这一截就永远变不回卡片、整条落成纯文本。卡在开头 / 末尾时不补多余的空格，
 * 只有一张卡片时输出就是那个路径，solePath 仍认得出是文件引用
 */
export function copyText(value: string, attachments: readonly AttachLike[] = []) {
  const used = new Set<AttachLike>()
  let out = ''
  // 刚拼进来的是路径：后面接着写正文时要先隔一个空格，不然会被当成同一个路径的一部分
  let afterPath = false
  for (const s of segments(value)) {
    if ('text' in s) {
      if (afterPath && s.text && !/^\s/.test(s.text)) out += ' '
      afterPath = false
      out += s.text
      continue
    }
    if (!isAttachChip(s.chip.kind)) {
      // Skill / 命令写成「/名字」。贴着前面的路径时也要隔开，否则读出来是「D:\up\a.png/blender」，
      // 既不是那个路径也不是那条命令。正常发送时 Skill 总在最前面（forSend 提到最前），这里的空格只在异常顺序下出现
      if (afterPath) out += ' '
      out += `/${s.chip.name}`
      afterPath = false
      continue
    }
    const a = attachOf(s.chip, attachments)
    if (!a) {
      out += chipMarker(s.chip.kind, s.chip.name)
      afterPath = false
      continue
    }
    used.add(a)
    // 卡片前面也要隔开：路径里本来就能有汉字，和前面正文连在一起时粘贴会认错路径（见函数上方说明）
    if (out && !/\s$/.test(out)) out += ' '
    out += `@${pathText(a.path)}`
    afterPath = true
  }
  const rest = attachments.filter((a) => !used.has(a)).map((a) => `@${pathText(a.path)}`)
  if (!rest.length) return out
  return out.trim() ? `${rest.join(' ')} ${out}` : rest.join(' ')
}

/** 粘贴进来的文字里像本机绝对路径的地方 */
export interface PathHit {
  start: number
  end: number
  path: string
}

const ABS = /^(?:[A-Za-z]:[\\/]|\/(?!\/))/
/**
 * 双引号包着的路径（可以有空格），或者不带空格的绝对路径：Windows 的「C:\」「D:/」开头，其他系统「/」开头。
 * 两种都可以带一个 @ 前缀（输入框里引用文件的写法）；网址里的「//」、相对路径、词中间的斜杠不算；
 * 中文的逗号、句号这些标点当作路径结束
 */
const PATH_RE = /(@?)"([^"\n]+)"|(@?)(?<![\w:/\\.~-])((?:[A-Za-z]:[\\/]|\/(?!\/))[^\s"'<>|*?，。；、！？「」《》]+)/g
/** 句尾跟着的标点不是路径的一部分 */
const TAIL = /[，。、；：！？,.;:!?)）\]】》>'"]+$/

/**
 * 找出文字里的绝对路径：粘贴时交给服务端确认是不是真的文件，是的话换成卡片。
 * 路径前面的 @（复制附件得到的写法）算在命中范围里，换成卡片时一起去掉，卡片自己会显示 @ 路径
 */
export function findPaths(text: string, max = 20): PathHit[] {
  const out: PathHit[] = []
  for (const m of text.matchAll(PATH_RE)) {
    if (out.length >= max) break
    const start = m.index ?? 0
    if (m[2] !== undefined) {
      const p = m[2].trim()
      if (ABS.test(p)) out.push({ start, end: start + m[0].length, path: p })
      continue
    }
    const p = m[4].replace(TAIL, '')
    // end 按命中范围算：@ 前缀也算进去，尾部标点不算
    if (p.length > 1) out.push({ start, end: start + (m[3] ? 1 : 0) + p.length, path: p })
  }
  return out
}

/**
 * 整段就是一个路径（前后只有空白，或者双引号包着）：复制对话、复制文件得到的都是这种，粘贴后应当变成一张卡片。
 * 判据是结构化的：有且只有一个绝对路径，且它前后没有别的文字——不认里面的词写的是什么。
 * 只有解析出来还不够，服务端确认这个路径真的存在（粘贴流程里 stat 一次）才算。
 */
export function solePath(text: string): string | undefined {
  const hits = findPaths(text)
  if (hits.length !== 1) return undefined
  const [hit] = hits
  if (text.slice(0, hit.start).trim() || text.slice(hit.end).trim()) return undefined
  return hit.path
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
  // 只放了图片、文件时补上那句话；卡片留在原位，对话里照样显示成卡片
  const text = typed ? rest : files && fallback.trim() ? `${rest} ${fallback.trim()}` : rest
  const name = head && 'chip' in head ? head.chip.name : ''
  return name ? `/${name}${text ? ` ${text}` : ''}` : text
}
