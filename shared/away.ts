/**
 * 「我不在」模式（分析稿 A4）：人不在电脑前时，能反悔的选择题按 Agent 推荐的选项自动选，整棵对话树不用停着等。
 *
 * 只认数据里的字段，不按文字猜（ADR 0041、0049）：问题自己标了 reversible（选错了回头改得了）、
 * recommended（推荐第几项）才自动选；缺一个、多选、选项对不上，一律照旧等你。
 * 审批（跑命令、改文件）、工作流节点确认、推送授权、诊断报告确认、等你操作（request_user_action）都不是提问，
 * 不走这里，照旧等。自动选过的每一条记进数据目录的 away.json，总览页集中列出来，回来能去改。
 *
 * 服务端（server/away.ts）和演示版（web/src/lib/demo-away.ts）共用这里的判定和结构。
 */
import { z } from 'zod'
import type { AskQuestion, TaskRequest } from './task-request.ts'
import { t } from './i18n.ts'

/** 一条自动选过的记录：总览页按它列出来，点「去改」回到那个对话 */
export const AwayPick = z.object({
  id: z.string(),
  taskId: z.string(),
  projectId: z.string().default(''),
  /** 记下时对话的标题：对话改名、删掉后总览上仍看得出是哪一件 */
  taskTitle: z.string().default(''),
  /** 问了什么、自动选了什么，一个问题一条 */
  items: z.array(z.object({ question: z.string(), picked: z.string() })).default([]),
  at: z.string(),
})
export type AwayPick = z.infer<typeof AwayPick>

/** 数据目录里存的整份状态 */
export const AwayState = z.object({
  on: z.boolean().default(false),
  /** 打开的时间：总览上写「从几点开始」 */
  since: z.string().default(''),
  picks: z.array(AwayPick).default([]),
})
export type AwayState = z.infer<typeof AwayState>

/** 记录最多留这么多条，旧的先丢：总览是看「我不在时发生了什么」的，不是档案 */
export const AWAY_PICKS_MAX = 50

/**
 * 模型交来的一个问题里的 recommended / reversible：类型不对就当没写（拿不准），不按 label 里的「（推荐）」字样猜
 */
export function askMeta(q: unknown): Pick<AskQuestion, 'recommended' | 'reversible'> {
  const x = (q ?? {}) as { recommended?: unknown; reversible?: unknown }
  const i = x.recommended
  return {
    ...(typeof i === 'number' && Number.isInteger(i) && i >= 0 ? { recommended: i } : {}),
    ...(typeof x.reversible === 'boolean' ? { reversible: x.reversible } : {}),
  }
}

/** 一个问题能不能替你选：标了能反悔、单选、推荐的是一个存在的选项 */
const pickOf = (q: AskQuestion): string | undefined => {
  if (q.reversible !== true || q.multiSelect) return undefined
  const i = q.recommended
  if (typeof i !== 'number' || !Number.isInteger(i) || i < 0 || i >= q.options.length) return undefined
  return q.options[i].label
}

/**
 * 「我不在」时这个请求能不能自动选、选哪个：返回每个问题的答案；有一个问题拿不准就整个不选（返回 undefined）。
 * 只看提问（kind question）、不是面板自己发起的授权（purpose）
 */
export function awayAnswers(req: Pick<TaskRequest, 'kind' | 'purpose' | 'questions'>): string[] | undefined {
  if (req.kind !== 'question' || req.purpose) return undefined
  const qs = req.questions ?? []
  if (!qs.length) return undefined
  const got = qs.map(pickOf)
  return got.every((x): x is string => typeof x === 'string') ? got : undefined
}

/** 对话里留的那一行：说清是面板替你选的、回来能改 */
export const awayNote = (picked: string[]) =>
  t('你不在，面板按 Agent 推荐的选项替你选了「{picked}」。回来想改，直接在这里告诉它。', {
    picked: picked.join('」「'),
  })

/** 总览上「去改」时预先填进那个对话输入框的话：用户接着写改成什么就行 */
export const awayRedoDraft = (p: Pick<AwayPick, 'items'>) =>
  t('我不在时你问的「{question}」，面板替我选了「{picked}」。我改成：', {
    question: p.items.map((x) => x.question).join('」「'),
    picked: p.items.map((x) => x.picked).join('」「'),
  })

/** 新记录排在最前，超出上限的旧记录丢掉 */
export const addPick = (s: AwayState, p: AwayPick): AwayState => ({
  ...s,
  picks: [p, ...s.picks.filter((x) => x.id !== p.id)].slice(0, AWAY_PICKS_MAX),
})

/** 打开 / 关掉：打开时记下时间，关掉不清记录（回来要看的正是这些） */
export const switchAway = (s: AwayState, on: boolean, now = new Date().toISOString()): AwayState => ({
  ...s,
  on,
  since: on ? (s.on ? s.since : now) : '',
})

/** 总览上「知道了」：去掉一条；不给 id 时全部清掉 */
export const dropPicks = (s: AwayState, id?: string): AwayState => ({
  ...s,
  picks: id ? s.picks.filter((x) => x.id !== id) : [],
})
