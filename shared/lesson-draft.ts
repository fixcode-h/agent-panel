/**
 * 候选教训草稿：从工作总结报告里提炼的半成品。
 *
 * 边界（对应 docs/lessons/README.md）：
 * - 只生成草稿，放进草稿区（能看、能改、能丢），**不自动写进 docs/lessons/**：写哪一条、落到哪个分片由用户看过后决定；
 * - 提炼要克制：只认报告里真正返工过的地方（「用户报告的 Bug」一节，以及需求进度里写了返工 / 被纠正 / 改回的条目），
 *   同一份报告最多几条，没有返工痕迹就一条都不生成，不硬造；
 * - 草稿按教训条目的格式（标题、规则、起因）和字数上限校验，免得落到分片时才发现超标。
 */
import { z } from 'zod'
import { t } from './i18n.ts'

/** 一份报告最多提炼几条：越多越像凑数，用户改起来也累 */
export const MAX_DRAFTS_PER_REPORT = 4
/** 草稿字段的字数上限：和教训条目的要求对齐（每条不超过 6 行、分片不超过 6KB） */
export const LESSON_TITLE_MAX = 80
export const LESSON_RULE_MAX = 1200
export const LESSON_CAUSE_MAX = 400
/** 一条教训最多几行（README：「每条不超过 6 行」） */
export const LESSON_RULE_MAX_LINES = 6
/** 提炼依据保留多少字：够用户认出是哪件事，又不把整份报告抄进草稿 */
const SOURCE_MAX = 400

/** 报告里出现这些词，说明这件事返工过（和项目教训的「什么时候写」对齐） */
export const REWORK_HINTS = ['返工', '被纠正', '重做', '改回', '撤回', '之前的做法', '漏了', '又出现']

/** 草稿：标题一句话写「该怎么做」、规则展开、起因；来源和分片建议只作参考 */
export const LessonDraftInput = z.object({
  /** 从哪份报告来的；手工新建时可以空 */
  reportId: z.string().default(''),
  /** 报告覆盖的最后一天 */
  day: z.string().default(''),
  projectNames: z.array(z.string()).default([]),
  title: z.string().trim().min(1, t('标题不能为空')).max(LESSON_TITLE_MAX),
  /** 规则展开：做什么、不做什么，具体到文件或字段 */
  rule: z.string().trim().max(LESSON_RULE_MAX).default(''),
  /** 起因：哪次返工（提交号 + 一句话） */
  cause: z.string().trim().max(LESSON_CAUSE_MAX).default(''),
  /** 建议落到哪个分片（docs/lessons/<shard>.md 的文件名）；空表示由用户挑 */
  shard: z.string().trim().max(40).default(''),
  /** 提炼依据：报告里对应的原文，用户判断要不要留 */
  source: z.string().max(SOURCE_MAX).default(''),
})
export type LessonDraftInput = z.infer<typeof LessonDraftInput>

/** 存进数据目录的记录：草稿字段加 id 和时间（和别的集合一样） */
export const LessonDraftRecord = LessonDraftInput.extend({
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type LessonDraftRecord = z.infer<typeof LessonDraftRecord>

/** 草稿能不能落盘：缺什么就列出来（保存时给用户看，不静默通过） */
export function lessonDraftProblems(d: LessonDraftInput): string[] {
  const out: string[] = []
  if (!d.title.trim()) out.push(t('标题不能为空'))
  if (!d.rule.trim()) out.push(t('规则还没写：写清做什么、不做什么'))
  else if (d.rule.trim().split('\n').length > LESSON_RULE_MAX_LINES)
    out.push(t('规则超过 {n} 行：一条教训最多 {n} 行，把同类的要求合起来写', { n: LESSON_RULE_MAX_LINES }))
  if (d.rule.length > LESSON_RULE_MAX) out.push(t('规则超过 {n} 字', { n: LESSON_RULE_MAX }))
  if (!d.cause.trim()) out.push(t('起因还没写：哪次返工（提交号 + 一句话）'))
  return out
}

/**
 * 再次提炼时还缺哪些，只补草稿区还没有的条目。
 * 判重看「提炼依据」（报告里的原文，界面上只展示、不给编辑），不看标题：
 * 草稿标题是要用户改成「该怎么做」的，按标题判重会在用户改过标题后再提炼时重复生成同一条。
 */
export function missingDrafts(
  found: LessonDraftInput[],
  existing: Pick<LessonDraftInput, 'source'>[],
): LessonDraftInput[] {
  const seen = new Set(existing.map((d) => d.source.trim()))
  return found.filter((x) => !seen.has(x.source.trim()))
}

/** 报告里的一条：标题、状态和时间点后面的缩进正文 */
interface ReportItem {
  title: string
  status: string
  body: string
}

const ITEM_HEAD = /^\s*\d+\.\s+\*\*(.+?)\*\*(?:\s*[｜|]\s*(.*))?$/
const SECTION_HEAD = /^##\s/
/** 三级标题是报告里的项目分组（`### 1.2 项目名`）：它结束上一条目，不是上一条的正文 */
const PROJECT_HEAD = /^###\s/

/** 取某一节（到下一个二级标题为止）的行；找不到返回空数组 */
function sectionLines(md: string, head: string): string[] {
  const lines = md.split('\n')
  const start = lines.findIndex((l) => l.trim().startsWith(head))
  if (start < 0) return []
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => SECTION_HEAD.test(l))
  return (end < 0 ? rest : rest.slice(0, end)).filter((l) => l.trim() && l.trim() !== '暂无')
}

/** 一节里的条目：编号行是标题，后面的缩进行是正文 */
function sectionItems(lines: string[]): ReportItem[] {
  const out: ReportItem[] = []
  let cur: ReportItem | undefined
  for (const line of lines) {
    if (PROJECT_HEAD.test(line)) {
      if (cur) out.push(cur)
      cur = undefined
      continue
    }
    const m = line.match(ITEM_HEAD)
    if (m) {
      if (cur) out.push(cur)
      cur = { title: m[1].trim(), status: (m[2] ?? '').trim(), body: '' }
      continue
    }
    if (cur) cur.body = cur.body ? `${cur.body}\n${line.trim()}` : line.trim()
  }
  if (cur) out.push(cur)
  return out
}

/** 正文里「实现：/修复：/原因：」这类行拼成规则草稿，去掉前缀后保留后面的话 */
const BODY_PREFIX = /^(实现|修复|原因|处理|做法|结论|改动)[：:]\s*/

function ruleFromBody(body: string) {
  const rows = body
    .split('\n')
    .map((l) => l.replace(BODY_PREFIX, '').trim())
    .filter(Boolean)
  return rows.join('\n').slice(0, LESSON_RULE_MAX)
}

/**
 * 从一份报告提炼候选草稿：
 * - 「## 二、用户报告的 Bug」里的每条都算（这一节本身就是用户报的、已经修过的返工）；
 * - 「## 一、需求进度」里正文写了返工 / 被纠正 / 改回的条目也算；
 * - 没有「怎么修的」正文的不算（没有痕迹就不是教训），同一标题只留一条，最多 MAX_DRAFTS_PER_REPORT 条。
 */
export function lessonDraftsFromReport(report: {
  id: string
  day: string
  md: string
  projectNames?: string[]
}): LessonDraftInput[] {
  const bugs = sectionItems(sectionLines(report.md, '## 二、用户报告的 Bug'))
  const progress = sectionItems(sectionLines(report.md, '## 一、需求进度'))
  const picked: { item: ReportItem; why: string }[] = [
    ...bugs.map((x) => ({ item: x, why: t('用户报告的 Bug') })),
    ...progress
      .filter((x) => REWORK_HINTS.some((w) => x.body.includes(w) || x.title.includes(w) || x.status.includes(w)))
      .map((x) => ({ item: x, why: t('需求进度里的返工') })),
  ]
  const seen = new Set<string>()
  const out: LessonDraftInput[] = []
  for (const { item, why } of picked) {
    if (out.length >= MAX_DRAFTS_PER_REPORT) break
    const rule = ruleFromBody(item.body)
    // 没写怎么修的不生成：只有标题的条目凑不出「该怎么做」
    if (!rule) continue
    const key = item.title.replace(/\s+/g, '')
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      reportId: report.id,
      day: report.day,
      projectNames: report.projectNames ?? [],
      // 草稿标题先用报告里的标题，等用户改成「该怎么做」的一句话
      title: item.title.slice(0, LESSON_TITLE_MAX),
      rule,
      cause: t('{day} 的工作总结（{why}）：{title}', {
        day: report.day,
        why,
        title: item.title,
      }).slice(0, LESSON_CAUSE_MAX),
      shard: '',
      source: `${item.title}${item.status ? ` ｜ ${item.status}` : ''}\n${item.body}`.trim().slice(0, SOURCE_MAX),
    })
  }
  return out
}
