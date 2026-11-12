import { summariesOf } from '../summary/card.ts'
import { clip } from '../text.ts'

/**
 * 子对话一轮结束交给父对话那封信里的「最近的结果」：只带要点，全文留在子对话里。
 *
 * 子对话按设计写详细总结（需求 / 方案 / 改动明细 / 影响 / 验证 / 遗留，常有一两千字），
 * 整篇进父对话上下文后父对话还要再总结一遍，派三个子对话就多出五千字以上（实测报告问题 17）。
 * 以前取的是回复开头 300 字，开头多是「我先看一下……」，结论在末尾反而被截掉。
 * 所以这里从回复里认出总结，只摘「类型｜结论」和各段的头一句；验证、遗留、要你处理排前面，原因、修法也各留一句，
 * 改动明细和影响逐文件的内容不带（父对话核对要点用，卡片由面板按子对话的总结自动画，点标题看全文）。
 */
export const LETTER_RESULT_MAX = 600

// 改动明细逐个文件、影响写波及面：600 字里放不下，父对话核对看结论、验证和遗留/要你处理即可，最先省掉
const SKIP = new Set(['changes', 'impact']) // 模块状态：常量，加载后不改
// 父对话最要核对的：先占额度，后面的段落按剩下的分
const FIRST = ['verified', 'remaining', 'needs']

/** 回复里认出了总结时返回摘要，否则按原文截到上限（问答、提问这类短回复照原样） */
export function letterResult(text: string, max = LETTER_RESULT_MAX): { text: string; cut: boolean } {
  const src = text.trim()
  if (!src) return { text: '', cut: false }
  const cards = summariesOf(src)
  if (!cards.length) {
    const one = src.replace(/\s+/g, ' ')
    return { text: clip(one, max), cut: one.length > max }
  }
  const per = Math.floor(max / cards.length)
  const out = cards.map((c) => {
    const head = clip(`${c.label}｜${c.title}`.replace(/\s+/g, ' '), Math.max(40, Math.floor(per / 3)))
    const fields = c.fields
      .filter((f) => !f.key || !SKIP.has(f.key))
      .map((f) => ({ ...f, text: f.text.replace(/\s+/g, ' ').trim() }))
      .filter((f) => f.text)
    const rank = (k?: string) => (k && FIRST.includes(k) ? 0 : 1)
    const order = [...fields].sort((a, b) => rank(a.key) - rank(b.key))
    let left = per - head.length
    const lines = new Map<(typeof fields)[number], string>()
    order.forEach((f, i) => {
      // 每段至少留几十个字，剩下的额度在还没分到的段落里平分
      const cap = Math.max(40, Math.floor(left / (order.length - i)) - f.label.length - 4)
      const line = `- ${f.label}：${clip(f.text, cap)}`
      lines.set(f, line)
      left -= line.length + 1
    })
    // 按原来的段落顺序写出来，读起来和子对话里的总结一致
    return [head, ...fields.map((f) => lines.get(f)!)].join('\n')
  })
  return { text: clip(out.join('\n'), max), cut: true }
}
