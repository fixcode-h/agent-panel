import { z } from 'zod'
import type { ProjectLesson } from './schema.ts'
import { lessonText, normTags } from './lessons.ts'

/**
 * 项目教训的「AI 评审」：教训越记越多，难免有不再必要、写得不对、能写得更好、已经过期或重复的条目。
 * 在项目里开一个分析对话逐条评审（读得到项目代码，才判断得了过期），回复末尾写 lesson-review 块；
 * 对话里画成一张卡片，每条建议由用户自己点「应用」才写进教训，不会自动改。
 */

export const LESSON_REVIEW_LANG = 'lesson-review'

/** 一条建议的处理：改写、合并（几条并成 id 那一条）、停用、删除 */
export const ReviewAction = z.enum(['rewrite', 'merge', 'disable', 'delete'])
export type ReviewAction = z.infer<typeof ReviewAction>

/** 判出来的问题：不必要、不合理、可以写得更好、已经过期、和别的重复 */
export const ReviewProblem = z.enum(['unnecessary', 'unreasonable', 'optimize', 'outdated', 'duplicate'])
export type ReviewProblem = z.infer<typeof ReviewProblem>

const ReviewItem = z.object({
  /** 要处理的那条教训；merge 时是留下来的那条 */
  id: z.string().trim().min(1),
  action: ReviewAction,
  problems: z.array(z.string()).catch([]).default([]),
  /** 为什么这么判：给用户看的依据，写具体（哪个文件已经没了、和哪条重复） */
  why: z.string().trim().max(1000).catch('').default(''),
  /** rewrite / merge：改写后的内容，没写的字段沿用原来的 */
  title: z.string().trim().max(120).catch('').default(''),
  rule: z.string().trim().max(1500).catch('').default(''),
  paths: z.array(z.string().trim().min(1).max(200)).max(20).optional().catch(undefined),
  tags: z.array(z.string()).optional().catch(undefined),
  /** merge：并进 id 这一条后删掉的那几条 */
  merge: z.array(z.string()).max(20).catch([]).default([]),
})

export interface LessonReviewItem {
  id: string
  action: ReviewAction
  problems: ReviewProblem[]
  why: string
  title: string
  rule: string
  paths?: string[]
  tags?: string[]
  merge: string[]
}

export interface LessonReview {
  summary: string
  items: LessonReviewItem[]
}

const BLOCK = new RegExp('```' + LESSON_REVIEW_LANG + '[^\\n]*\\n([\\s\\S]*?)```', 'g')

/** 从回复里读出最后一个评审块；格式不对的单条跳过，不让一条写坏的挡住其余的 */
export function parseLessonReview(text: string): LessonReview | null {
  const last = [...text.matchAll(BLOCK)].at(-1)
  if (!last) return null
  let raw: unknown
  try {
    raw = JSON.parse(last[1].trim())
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const items = (Array.isArray(o.items) ? o.items : [])
    .map((x) => ReviewItem.safeParse(x))
    .filter((p) => p.success)
    .map(({ data: x }) => ({
      ...x,
      problems: x.problems.filter((p): p is ReviewProblem => ReviewProblem.safeParse(p).success),
      merge: x.merge.filter((m) => m && m !== x.id),
    }))
    // 改写、合并没给新规则就没法应用
    .filter((x) => (x.action !== 'rewrite' && x.action !== 'merge') || !!x.title)
  return { summary: String(o.summary ?? '').trim(), items }
}

/** 显示时去掉评审块（界面另外画成卡片）；流式输出到一半时去掉到结尾 */
export function stripLessonReview(text: string) {
  if (!text.includes('```' + LESSON_REVIEW_LANG)) return text
  return text.replace(BLOCK, '').replace(new RegExp('```' + LESSON_REVIEW_LANG + '[\\s\\S]*$'), '')
}

/**
 * 这条建议现在的状态，按当前的教训现算（不另存「已应用」）：
 * applied 已经是建议的样子；missing 要改的那条已经不在了（被删、被别处改掉）；pending 还没应用
 */
export function reviewItemState(lessons: ProjectLesson[], it: LessonReviewItem): 'applied' | 'missing' | 'pending' {
  const l = lessons.find((x) => x.id === it.id)
  if (it.action === 'delete') return l ? 'pending' : 'applied'
  if (!l) return 'missing'
  if (it.action === 'disable') return l.enabled ? 'pending' : 'applied'
  const merged = it.merge.every((m) => !lessons.some((x) => x.id === m))
  return l.title === it.title && (!it.rule || l.rule === it.rule) && merged ? 'applied' : 'pending'
}

/**
 * 把一条建议写进教训：改写和合并把原来的版本留进改写记录（写明是 AI 评审改的、为什么），改坏了能恢复；
 * 合并时其余几条删掉。要改的那条已经不在时原样返回
 */
export function applyReviewItem(lessons: ProjectLesson[], it: LessonReviewItem, now = new Date().toISOString()) {
  const l = lessons.find((x) => x.id === it.id)
  if (it.action === 'delete') return lessons.filter((x) => x.id !== it.id)
  if (!l) return lessons
  if (it.action === 'disable') return lessons.map((x) => (x === l ? { ...x, enabled: false, updatedAt: now } : x))
  const why = `AI 评审${it.action === 'merge' ? '合并' : '改写'}${it.why ? `：${it.why}` : ''}`.slice(0, 500)
  const known = lessons.flatMap((x) => x.tags)
  const next: ProjectLesson = {
    ...l,
    title: it.title || l.title,
    rule: it.rule || l.rule,
    paths: it.paths ?? l.paths,
    tags: it.tags ? normTags(it.tags, known) : l.tags,
    updatedAt: now,
    history:
      it.title !== l.title || (it.rule && it.rule !== l.rule)
        ? [{ title: l.title, rule: l.rule, why, at: now }, ...l.history].slice(0, 5)
        : l.history,
  }
  const drop = new Set(it.action === 'merge' ? it.merge : [])
  return lessons.filter((x) => !drop.has(x.id)).map((x) => (x === l ? next : x))
}

const fmtDate = (iso: string) => (iso ? iso.slice(0, 10) : '未知')

/** 交给评审对话的附件：每条教训的全文、id、谁记的、什么时候记和改的、启没启用 */
export function lessonReviewReport(projectName: string, lessons: ProjectLesson[]) {
  return [
    `# 「${projectName}」的项目教训（${lessons.length} 条）`,
    ...lessons.map((l) =>
      [
        lessonText(l, true),
        `记录：${l.source === 'agent' ? '角色自己记的' : '用户记的'}，${fmtDate(l.createdAt)} 记下${l.updatedAt ? `，${fmtDate(l.updatedAt)} 改写过` : ''}${l.enabled ? '' : '，已停用'}`,
        l.history.length ? `改写过 ${l.history.length} 次，最近一次的原因：${l.history[0].why || '没写'}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    ),
  ].join('\n\n')
}

/** 评审对话的第一句话：只读评审、怎么判、结果写成什么格式 */
export function lessonReviewPrompt(projectName: string, count: number, focus = '') {
  return `请评审「${projectName}」的项目教训（共 ${count} 条，全文在附件里，每条带 id）。这是只读评审：不改任何文件，也不要调用 record_lesson 改教训，结论交给我逐条确认。

逐条判断：
1. 是否必须：不写这条，角色照样会做对的（通用常识、CLI 自带的规矩、AGENTS.md 和文档里已经写清的）就不必要。
2. 是否合理：规则本身对不对，会不会把角色带偏，和别的教训、项目现状有没有冲突。
3. 能否优化：写成了一次事件而不是能照做的规则、太长、太含糊、范围（paths）太宽或太窄、标签不贴切。
4. 是否过期：去项目里核对它提到的文件、目录、函数、字段、命令还在不在、做法是不是已经变了。只查教训里点名的东西，用搜索定位，不通读整个项目。
5. 是否重复：几条讲的是同一件事就合并成一条。

拿不准的不提，只提有把握的。没问题的不用逐条列，在总结里说一句即可。

先用几句话写总体结论，然后在回复末尾写一个 ${LESSON_REVIEW_LANG} 代码块（JSON），面板会画成卡片让我逐条应用：

\`\`\`${LESSON_REVIEW_LANG}
{
  "summary": "一句话总结：共几条，哪些要改",
  "items": [
    {
      "id": "要处理的教训 id",
      "action": "rewrite | merge | disable | delete",
      "problems": ["unnecessary | unreasonable | optimize | outdated | duplicate"],
      "why": "具体依据：哪个文件已经不在、和哪条重复、哪里写得不对",
      "title": "rewrite / merge：改写后的一句话规则",
      "rule": "rewrite / merge：改写后的说明，不改就不写",
      "paths": ["rewrite / merge：新的范围，不改就不写这个字段"],
      "tags": ["rewrite / merge：新的标签，不改就不写这个字段"],
      "merge": ["merge：并进 id 这一条后删掉的那几条的 id"]
    }
  ]
}
\`\`\`

action 的选法：不必要、过期且没有保留价值的用 delete；暂时用不上但以后可能用得上的用 disable；写得不对或能写得更好的用 rewrite；重复的用 merge，留下写得最好的那条当 id，把合并后的规则写进 title / rule。${focus ? `\n\n这次重点看：${focus}` : ''}`
}
