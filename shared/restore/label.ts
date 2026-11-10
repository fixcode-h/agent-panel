import { z } from 'zod'
import { ELEMENT_KINDS, type RepeatGroup, type RestoreElement } from './schema.ts'
import { kindPrefix } from './detect.ts'

/**
 * 标注：算法量出来的框交给模型，模型只看图说「这是什么」——类型、名字、文字内容、重复组叫什么、
 * 有没有漏掉或者多出来的。坐标一律不收：位置靠算法量，模型看图估的坐标差几十像素，这正是以前还原不准的根源。
 * 模型说漏掉了的，只记一句话放进决策卡，让用户在图上框出来
 */

export const LabelReply = z.object({
  elements: z
    .array(
      z.object({
        n: z.number().int(),
        kind: z.enum(ELEMENT_KINDS).optional(),
        name: z.string().max(80).optional(),
        text: z.string().max(400).optional(),
        /** 这个框不是一个独立的元素（框错了、是别的东西的一部分） */
        drop: z.boolean().optional(),
      }),
    )
    .max(600)
    .default([]),
  groups: z
    .array(z.object({ id: z.string(), name: z.string().max(80) }))
    .max(40)
    .default([]),
  /** 漏掉的元素、拿不准的地方（给人看的一两句话） */
  missing: z.array(z.string().max(200)).max(10).default([]),
  note: z.string().max(600).default(''),
})
export type LabelReply = z.infer<typeof LabelReply>

/** 给模型的那张图上每个框标的号：从 1 开始，跳过背景 */
export const labelNumbers = (list: RestoreElement[]) =>
  new Map(list.filter((e) => !e.hidden && e.kind !== 'background').map((e, i) => [e.id, i + 1]))

export function buildLabelPrompt(o: {
  image: string
  width: number
  height: number
  elements: RestoreElement[]
  groups: RepeatGroup[]
  feedback?: string
}) {
  const nums = labelNumbers(o.elements)
  const rows = o.elements
    .filter((e) => nums.has(e.id))
    .map((e) => {
      const b = e.box
      const extra = [e.repeat ? `组 ${e.repeat}` : '', e.confidence < 0.6 ? '把握低' : ''].filter(Boolean).join('，')
      return `${nums.get(e.id)}. ${e.kind} ${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.w)}×${Math.round(b.h)}${extra ? `（${extra}）` : ''}`
    })
  const groups = o.groups.map((g) => `- ${g.id}：${g.rows} 行 × ${g.cols} 列，格子 ${g.cell.w}×${g.cell.h}`)
  return `你在帮忙把一张游戏 UI 原画一比一还原成 UE 的 UMG 控件树。算法已经量出了每个元素的框（位置是准的，不要改），你只负责看图说出每个框是什么。

先用读文件的工具打开这张图看：${o.image}（${o.width}×${o.height}，彩色框是算法找到的元素，框左上角的白底数字是编号）。

## 算法找到的元素（编号. 类型 x,y 宽×高）
${rows.join('\n')}
${groups.length ? `\n## 重复组（大小一样、等间距排开的）\n${groups.join('\n')}\n` : ''}
## 要你做的
1. 每个编号给出：kind（${ELEMENT_KINDS.join(' / ')}）、name（英文 PascalCase，带类型前缀：Panel_ / Btn_ / Slot_ / Icon_ / Txt_ / Bar_ / Input_ / Deco_，例如 Btn_Use、Icon_Gem、Txt_ItemName）。
2. 文字（kind 为 text）照图上的字原样写进 text，一个字都不要改；按钮上的字是按钮里面的一个 text 元素。
3. 框错了的（半个字、图标的一部分、背景上的噪点）写 drop: true。
4. 重复组起个名字（例如 Slot_Item）。
5. 图上明显漏框的元素，用一句话写进 missing（例如「右上角关闭按钮没有框」），不要给坐标。
${o.feedback?.trim() ? `\n## 用户的意见\n${o.feedback.trim()}\n` : ''}
只输出一个 JSON，不要别的文字：
{"elements":[{"n":1,"kind":"panel","name":"Panel_Main"},{"n":2,"kind":"text","name":"Txt_Title","text":"背包"}],"groups":[{"id":"eg1","name":"Slot_Item"}],"missing":[],"note":"一两句话说明"}`
}

/** 模型的标注合进元素表：只改类型、名字、文字；用户手动改过的（source 为 user）不动 */
export function applyLabels(list: RestoreElement[], groups: RepeatGroup[], reply: LabelReply) {
  const nums = labelNumbers(list)
  const byNum = new Map(reply.elements.map((x) => [x.n, x]))
  const used = new Set<string>()
  const elements = list.map((e) => {
    const x = byNum.get(nums.get(e.id) ?? -1)
    if (!x || e.source === 'user') return e
    if (x.drop) return { ...e, hidden: true }
    const kind = x.kind ?? e.kind
    const next: RestoreElement = { ...e, kind, source: 'ai' }
    if (x.name?.trim()) {
      let name = x.name.trim().replace(/[^\w]/g, '_')
      if (!new RegExp(`^${kindPrefix(kind)}_`).test(name) && kindPrefix(kind)) name = `${kindPrefix(kind)}_${name}`
      let n = name
      for (let i = 2; used.has(n); i++) n = `${name}${i}`
      used.add(n)
      next.name = n
    }
    if (kind === 'text')
      next.text = {
        content: '',
        px: Math.round(e.box.h),
        color: '#FFFFFFFF',
        align: 'left',
        bold: false,
        ...e.text,
        ...(x.text !== undefined ? { content: x.text } : {}),
      }
    return next
  })
  const names = new Map(reply.groups.map((g) => [g.id, g.name]))
  return { elements, groups: groups.map((g) => (names.get(g.id) ? { ...g, name: names.get(g.id)! } : g)) }
}
