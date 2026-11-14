/**
 * 工作总结报告的正文：用采纳的分项按固定模板拼 Markdown，另给一份贴进聊天工具用的纯文本（ADR 0065）。
 *
 * 模板按「别人一眼看出今天做了什么、做到哪、靠不靠谱、要不要他配合」排：
 * 概要一句 → 需求 → 问题 → 遗留与风险 → 明天计划（只留标题给用户自己填）→ 需要协助 → 附：关键代码。
 * 只在节和节之间空一行，条目内部不空行：日报常贴进企业微信 / 飞书，空行和多层标题会把一屏撑得只剩两三条。
 *
 * 纯逻辑；标题（日期）在 shared/summary.ts 的 renderReport 里算好传进来，这里不碰时间
 */
import type { SummaryEntry } from '../summary.ts'
import { codeBlock, splitPoints } from './code.ts'

/**
 * 去掉一眼就像 AI 写的符号：加粗、反引号、破折号，压掉多余空白（ADR 0043）。
 * 只做确定无害的替换，不改写句子；口吻靠「每日工作总结」角色的写法规则
 */
export function plainText(s: string) {
  return s
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\s*(——|—|--)\s*/g, '，')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, ' ')
    .trim()
}

/** 一句话收尾：没有句末标点就补「。」，几句连写时不会粘在一起 */
const sentence = (s: string) => {
  const x = plainText(s)
  return !x || /[。！？.!?；;）)」]$/.test(x) ? x : `${x}。`
}

/** 条目标题：去掉 AI 符号和句末标点（标题不是句子） */
const headline = (s: string) => plainText(s).replace(/[。.；;]+$/, '')

/** 一个标签下最多几点连成一句写在同一行；再多就换成下一级编号，一行太长没法读 */
const INLINE_POINTS = 3

/**
 * 条目下的一行「- 标签：内容」：几点连成一句；点太多时标签单独一行，下面一级编号。
 * pad 是条目内容的缩进（和「1. 」「10. 」的宽度对齐，否则第 10 条起的子项会脱离条目）
 */
function labeled(pad: string, label: string, text: string): string[] {
  const list = splitPoints(text).map(sentence).filter(Boolean)
  if (!list.length) return []
  if (list.length <= INLINE_POINTS) return [`${pad}- ${label}：${list.join('')}`]
  return [`${pad}- ${label}：`, ...list.map((x, i) => `${pad}  ${i + 1}. ${x}`)]
}

/** 需求还在做 / 问题没修好 */
const unfinished = (x: SummaryEntry) => (x.kind === 'need' ? x.status === 'doing' : !x.fix.trim())

/** 条目标题后的括号：状态，有单子时跟在后面 */
function tag(x: SummaryEntry) {
  const state = x.kind === 'need' ? (unfinished(x) ? '进行中' : '已完成') : unfinished(x) ? '未解决' : '已修复'
  return `（${[state, x.link.trim()].filter(Boolean).join(' · ')}）`
}

/** 附录里的编号：只有带关键代码的已修复问题有，按问题在报告里的顺序数 */
type Appendix = Map<string, number>

/** 一条需求或问题：编号标题 + 缩进的几行，条目内部不空行 */
function entryLines(x: SummaryEntry, n: number, appendix: Appendix): string[] {
  const pad = ' '.repeat(String(n).length + 2)
  const head = `${n}. ${headline(x.title)}${tag(x)}`
  if (x.kind === 'need')
    return [
      head,
      ...splitPoints(x.content).map((p) => `${pad}- ${sentence(p)}`),
      ...labeled(pad, '验证', x.verify),
      ...labeled(pad, '影响', x.impact),
    ]
  const ref = appendix.get(x.id)
  const fixed = !unfinished(x)
  return [
    head,
    ...labeled(pad, '现象', x.symptom),
    ...labeled(pad, '原因', x.cause),
    ...(fixed ? labeled(pad, ref ? `修复（代码见附 ${ref}）` : '修复', x.fix) : []),
    ...(fixed ? labeled(pad, '验证', x.verify) : []),
    ...labeled(pad, '影响', x.impact),
  ]
}

/** 一节：标题紧跟条目，没内容的节整节不写（keep 为真时只留标题，给用户自己填） */
const section = (head: string, lines: string[], keep = false) =>
  lines.length || keep ? [[`## ${head}`, ...lines]] : []

/** 「- 标题：内容」一行，内容几点连成一句 */
const bullet = (title: string, text: string) => {
  const s = splitPoints(text).map(sentence).join('')
  return s ? [`- ${headline(title)}：${s}`] : []
}

/** 开头的概要：按分项直接数（不让 CLI 写，免得数字和下面对不上） */
function overview(items: SummaryEntry[], week: boolean) {
  const needs = items.filter((x) => x.kind === 'need')
  const bugs = items.filter((x) => x.kind === 'bug')
  const doing = needs.filter(unfinished).length
  const open = bugs.filter(unfinished).length
  const help = items.filter((x) => x.help.trim()).length
  const parts = [
    needs.length - doing && `完成需求 ${needs.length - doing} 项`,
    doing && `${doing} 项需求还在做`,
    bugs.length - open && `修好问题 ${bugs.length - open} 个`,
    open && `${open} 个问题还在查`,
    help && `需要协助 ${help} 项`,
  ].filter(Boolean)
  return `${week ? '本周' : '今天'}${parts.join('，')}。`
}

/**
 * 用采纳的分项拼报告正文（ADR 0065，取代 ADR 0056 的「三级标题 + 加粗小标题」模板）：
 * - 需求先写做完的、再写进行中的；问题先写修好的、再写没修好的；
 * - 遗留与风险汇总各条目的遗留和没修好的问题；明天计划只留标题；需要协助汇总各条目的协助；
 * - 关键代码统一挪到最后的附录，正文写「代码见附 N」，读正文的人不用翻过一堆代码。
 */
export function renderReportBody(input: { heading: string; week: boolean; items: SummaryEntry[] }): string {
  const { items } = input
  if (!items.length) return `# ${input.heading}\n\n没有可写的内容。\n`
  // 稳定排序：同一状态里保持 CLI 给的顺序
  const ordered = (kind: SummaryEntry['kind']) =>
    items.filter((x) => x.kind === kind).sort((a, b) => Number(unfinished(a)) - Number(unfinished(b)))
  const needs = ordered('need')
  const bugs = ordered('bug')
  const appendix: Appendix = new Map()
  for (const x of bugs) if (!unfinished(x) && x.code?.length) appendix.set(x.id, appendix.size + 1)
  const remaining = [
    ...items.flatMap((x) => bullet(x.title, x.remaining)),
    ...bugs.filter(unfinished).map((x) => `- 问题「${headline(x.title)}」还没解决。`),
  ]
  const code = bugs
    .filter((x) => appendix.has(x.id))
    .map((x) => [`附 ${appendix.get(x.id)} · ${headline(x.title)}`, ...(x.code ?? []).flatMap(codeBlock)].join('\n'))
  const blocks = [
    [`# ${input.heading}`],
    [overview(items, input.week)],
    ...section(
      '需求',
      needs.flatMap((x, i) => entryLines(x, i + 1, appendix)),
    ),
    ...section(
      '问题',
      bugs.flatMap((x, i) => entryLines(x, i + 1, appendix)),
    ),
    ...section('遗留与风险', remaining),
    ...section(input.week ? '下周计划' : '明天计划', [], true),
    ...section(
      '需要协助',
      items.flatMap((x) => bullet(x.title, x.help)),
    ),
    // 附录的几段代码之间空一行，各自一块
    ...(code.length ? [['## 附：关键代码', code.join('\n\n')]] : []),
  ]
  return `${blocks.map((b) => b.join('\n')).join('\n\n')}\n`
}

const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二']

/**
 * 报告的纯文本版：贴进企业微信、飞书、邮件这些不渲染 Markdown 的地方。
 * 一级标题去掉 #，二级标题换成「一、」「二、」，三级标题去掉 #，去掉加粗和反引号；
 * 代码块去掉围栏、整块缩进四格；连续空行压成一行。用户手改过的正文也按同样的规则转
 */
export function reportPlainText(md: string): string {
  const out: string[] = []
  let fence = ''
  let sec = 0
  for (const line of md.replace(/\r\n/g, '\n').split('\n')) {
    const f = line.match(/^\s*(`{3,}|~{3,})/)
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = ''
      else out.push(`    ${line}`)
      continue
    }
    if (f) {
      fence = f[1]
      continue
    }
    const plain = line.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]*)`/g, '$1')
    const h = plain.match(/^(#{1,6})\s+(.*)$/)
    if (!h) out.push(plain)
    else if (h[1].length === 2) out.push(`${CN_NUM[sec++] ?? sec}、${h[2]}`)
    else out.push(h[2])
  }
  return `${out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()}\n`
}
