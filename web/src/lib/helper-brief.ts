/**
 * 子任务窗口顶上那块「派给它的要求」：把 TaskStep.brief 拆成能一眼看懂的几块。
 *
 * brief 是派发时原样交给它的要求，由 `shared/engine.ts` 的 spawn 落盘：instructions 原文，后面可能接着
 * - `## 评审交接单（派你的对话整理）` + 引擎按固定小标题写的几节（`briefPart`，评审才带）
 * - `## 重试时补充`（同一个子任务重试时追加，可能追加多次）
 * 而 instructions 本身通常是 `## 用户原话`、`## 要做的事` 这类小节。这里只做排版用的拆分：
 * 正文一个字都不改（一块里的内容原样交给 Markdown 渲染），没有小节就按段落显示。
 *
 * 放在 web 而不是 shared：只有子任务窗口用它，brief 的格式由 engine 定，这里只读不写。
 */
import { t } from '@shared/i18n'

/**
 * 一块的样子：tone 决定标题的颜色——
 * key 是验收标准这类必须满足的要求，note 是后来补充的要求，plain 照常
 */
export interface BriefBlock {
  /** 小节标题；第一个小节之前的那段话为空字符串 */
  title: string
  /** 小节正文（Markdown 原文，不做任何改写） */
  body: string
  tone: 'plain' | 'key' | 'note'
}

export interface BriefView {
  /** 派发时没留下要求（旧记录没有这个字段，或者只写了标题没写要求） */
  empty: boolean
  /** 按 `##` 拆开的小节；没有 `##` 小节时是空的，用 paragraphs */
  blocks: BriefBlock[]
  /** 没有小节的纯文字：按空行分成的段落 */
  paragraphs?: string[]
  /** 派发之后又追加了几次要求（真正的「重试时补充」块数，不是返工次数） */
  added: number
  /** 折叠着的时候显示的一句话 */
  summary: string
}

/**
 * 引擎拼进 brief 的两段（原文，改了 `shared/engine.ts` 这里要跟着改）：
 * 评审交接单的开头、重试时追加的要求。
 */
const REVIEW_HEAD = '## 评审交接单（派你的对话整理）'
/** 重试时追加的那一节（见 `shared/engine.ts` 的 spawn）：展示时另标一块，和上面的原始要求分开 */
const RETRY_TITLE = '重试时补充'
/**
 * 交接单开头那句是引擎写给评审的提示（`briefPart` 里写死的），不是要求本身。
 * 当前引擎不会产出「只有引言、没有子节」的交接单（`shared/engine.ts` 的 briefPart 在 rows 为空时直接返回空串），
 * 这条剔除只是防御：旧记录里的 brief、或以后引擎改了拼接方式时，别把这行提示当成要求显示
 */
const REVIEW_HINT = '这就是评审要用的背景，不用再去读模块文档、搜项目还原它们。'

/** 交接单里必须满足的那一节：标重点 */
const REVIEW_KEY = new Set(['要达成什么、验收标准'])

/**
 * 常见小节排前面：先看「要做什么」（要做的事 → 用户原话 → 验收标准 → 其余）。
 * 不在表里的小节按原文顺序排在后面，不会因为不认识就丢掉
 */
const SECTION_ORDER = [
  '要做的事',
  '用户需求',
  '用户原话',
  '验收标准',
  '验收',
  '注意点',
  '注意事项',
  '约束',
  '限制',
  '必须遵守',
  '现象',
  '当前状态',
  '根因',
  '背景',
]

/** 必须满足的要求：标重点 */
const KEY_SECTIONS = new Set(['验收标准', '验收', '注意点', '注意事项', '约束', '限制', '必须遵守'])

/** 一行小标题：`## 文字`，标题文字不含 `#` */
const HEAD = /^##[ \t]+(\S.*?)[ \t]*$/
/** 交接单里的子标题：`### 文字` */
const SUB_HEAD = /^###[ \t]+(\S.*?)[ \t]*$/

/** 按 `##` 把原文切成小节，代码块里的 `##` 不算（示例里的 Markdown 不能被切开） */
function splitSections(raw: string) {
  const out: { title: string; lines: string[] }[] = [{ title: '', lines: [] }]
  let fence = false
  for (const line of raw.split('\n')) {
    if (/^\s*```/.test(line)) fence = !fence
    const head = fence ? null : HEAD.exec(line)
    if (head) out.push({ title: head[1], lines: [] })
    else out.at(-1)!.lines.push(line)
  }
  return (
    out
      .map((s) => ({ title: s.title, body: s.lines.join('\n').trim() }))
      // 只有标题、没有正文的小节不给画面留一个空块（第一小节的标题本来就是空的）
      .filter((s) => s.body || s.title === '')
  )
}

/** 交接单那节的子节：`### 标题` 各自成块，标题保留引擎写的原文（和派发时给评审看的一致）。
 * 交接单开头那句提示语不占展示位置；代码块里的 `###` 也不算子节（评审常在里面贴差异和 Markdown）。
 * 没有子节（旧记录、或者写成一整段）时整块原样显示，不丢内容
 */
function reviewBlocks(body: string): BriefBlock[] {
  const parts: { title: string; lines: string[] }[] = [{ title: '', lines: [] }]
  let fence = false
  for (const line of body.split('\n')) {
    if (/^\s*```/.test(line)) fence = !fence
    const sub = fence ? null : SUB_HEAD.exec(line)
    if (sub) parts.push({ title: sub[1], lines: [] })
    else parts.at(-1)!.lines.push(line)
  }
  if (parts.length === 1) {
    const text = body
      .split('\n')
      .filter((l) => l.trim() !== REVIEW_HINT)
      .join('\n')
      .trim()
    return [{ title: t('评审交接单'), body: text, tone: 'plain' }]
  }
  return parts.slice(1).map((p) => ({
    title: p.title,
    body: p.lines.join('\n').trim(),
    tone: REVIEW_KEY.has(p.title) ? ('key' as const) : ('plain' as const),
  }))
}

/** 正文里第一句能当摘要的话：去掉列表符号和 Markdown 标记，太长就截断 */
function firstLine(body: string) {
  for (const line of body.split('\n')) {
    const s = line
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
      .replace(/^#+\s*/, '')
      .replace(/[*_`]/g, '')
      .trim()
    if (s) return s
  }
  return ''
}

/** 摘要不超过这么多字：折叠行最多两行（界面里 `line-clamp-2`），太长的截断 */
const SUMMARY_MAX = 80

/** 「重试时补充」块的数量：派发之后真的又追加过几次要求 */
function countAdded(blocks: BriefBlock[]) {
  return blocks.filter((b) => b.tone === 'note').length
}

function summarize(body: string) {
  const line = firstLine(body)
  return line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX - 1)}…` : line
}

/**
 * 把 brief 拆成展示用的几块。空 / 缺字段返回 `empty`，界面据此不显示这块（旧记录没有 brief）。
 * 有 `##` 小节的按小节排，纯文字的按段落显示——两种都能看到原文，不改写、不摘要掉内容。
 */
export function helperBriefView(raw: string | undefined): BriefView {
  const text = (raw ?? '').trim()
  if (!text) return { empty: true, blocks: [], added: 0, summary: '' }
  const sections = splitSections(text)
  if (!sections.some((s) => s.title)) {
    const paragraphs = text
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean)
    return { empty: false, blocks: [], paragraphs, added: 0, summary: summarize(paragraphs[0] ?? '') }
  }

  // 第一个小节之前的那段话：原样排在最上面
  const lead = sections.find((s) => !s.title && s.body)
  const leadBlock = lead ? { title: '', body: lead.body, tone: 'plain' as const } : undefined
  const plain: BriefBlock[] = []
  const reviews: BriefBlock[] = []
  for (const s of sections) {
    if (!s.title) continue
    if (`## ${s.title}` === REVIEW_HEAD) {
      reviews.push(...reviewBlocks(s.body))
      continue
    }
    if (s.title === RETRY_TITLE) plain.push({ title: t('重试时补充'), body: s.body, tone: 'note' })
    else plain.push({ title: s.title, body: s.body, tone: KEY_SECTIONS.has(s.title) ? 'key' : 'plain' })
  }
  // 排位：认识的按 SECTION_ORDER，不认识的和重试补充都排后面；同一排位保持原文顺序（sort 是稳定的）
  const rank = (b: BriefBlock) => {
    if (b.tone === 'note') return SECTION_ORDER.length + 1
    const i = SECTION_ORDER.indexOf(b.title)
    return i < 0 ? SECTION_ORDER.length : i
  }
  const blocks: BriefBlock[] = [
    ...(leadBlock ? [leadBlock] : []),
    ...plain
      .map((b, i) => ({ b, i }))
      .sort((x, y) => rank(x.b) - rank(y.b) || x.i - y.i)
      .map((x) => x.b),
    ...reviews,
  ]
  // 摘要取「要做的事」那一句：折叠着的时候也要能看出这个子任务要做什么
  const main = blocks.find((b) => b.title === SECTION_ORDER[0]) ?? blocks.find((b) => b.body)
  return { empty: false, blocks, added: countAdded(blocks), summary: summarize(main?.body ?? '') }
}
