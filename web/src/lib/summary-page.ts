/**
 * 工作总结页的页面状态存档：切到别的页面再回来（甚至刷新）时，来源、按天 / 按周、选的日期、
 * 正在跑或刚跑完的提炼、已经采纳的分项、报告的预览 / 编辑 tab 都还在。
 *
 * 只存「看的是什么」：报告本体和面板里加过的项目在服务端（server/summary.ts），提炼结果在服务端的 job 里（留一小时）。
 * 写不进 localStorage（无痕模式、存储被禁用）时退回内存：同一次打开里切页面仍然保留。
 * 日期只在当天有效：第二天再打开回到今天（本周），不让人对着昨天的日期以为是今天。
 */
import { SUMMARY_GRAINS, SUMMARY_SOURCES, type SummaryGrain, type SummarySource } from '@shared/summary'
import { dayKey } from '@shared/usage'

export const SUMMARY_PAGE_KEY = 'summary-page:v2'

export type ReportMode = 'preview' | 'edit'

export interface SummaryPageState {
  source: SummarySource
  grain: SummaryGrain
  /** 选中的日期（YYYY-MM-DD，按周时是那一周里的任意一天）；空串表示今天 */
  day: string
  /** 存档是哪一天写的：不是今天就把 day 清回今天 */
  savedOn: string
  /** 正在跑 / 刚跑完的提炼：刷新后接着看进度或分项 */
  jobId: string
  /** 这次提炼里已经采纳的分项 id */
  adopted: string[]
  mode: ReportMode
}

export const DEFAULT_SUMMARY_PAGE: SummaryPageState = {
  source: 'tasks',
  grain: 'day',
  day: '',
  savedOn: '',
  jobId: '',
  adopted: [],
  mode: 'preview',
}

/** 无痕模式下写不进 localStorage 时，同一次打开里的存档放这里 */
const memory: { raw: string | null } = { raw: null }

const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

/** 读存档：坏数据、旧版本缺字段都按默认值处理，页面照常打开 */
export function parseSummaryPage(raw: string | null, now = new Date()): SummaryPageState {
  if (!raw) return { ...DEFAULT_SUMMARY_PAGE }
  let v: Partial<Record<keyof SummaryPageState, unknown>>
  try {
    v = JSON.parse(raw)
  } catch {
    return { ...DEFAULT_SUMMARY_PAGE }
  }
  if (!v || typeof v !== 'object') return { ...DEFAULT_SUMMARY_PAGE }
  const today = dayKey(now)
  const savedOn = typeof v.savedOn === 'string' ? v.savedOn : ''
  const day = typeof v.day === 'string' && DAY_RE.test(v.day) ? v.day : ''
  return {
    source: (SUMMARY_SOURCES as readonly unknown[]).includes(v.source) ? (v.source as SummarySource) : 'tasks',
    grain: (SUMMARY_GRAINS as readonly unknown[]).includes(v.grain) ? (v.grain as SummaryGrain) : 'day',
    // 隔天打开回到今天：昨天选的日期今天再看已经不是「当前」了
    day: savedOn === today ? day : '',
    savedOn: today,
    jobId: savedOn === today && isText(v.jobId) ? v.jobId : '',
    adopted: Array.isArray(v.adopted) ? [...new Set(v.adopted.filter(isText))] : [],
    mode: v.mode === 'edit' ? 'edit' : 'preview',
  }
}

export function loadSummaryPage(now = new Date()): SummaryPageState {
  let stored: string | null = null
  try {
    stored = localStorage.getItem(SUMMARY_PAGE_KEY)
  } catch {}
  // 内存里那份永远是最新的（每次 save 都先写它）：写不进 localStorage 时不能用里面的旧 JSON 盖回去
  return parseSummaryPage(memory.raw ?? stored, now)
}

export function saveSummaryPage(state: SummaryPageState) {
  const raw = JSON.stringify({ ...state, savedOn: dayKey(new Date()) })
  memory.raw = raw
  try {
    localStorage.setItem(SUMMARY_PAGE_KEY, raw)
  } catch {}
}

/** 面板里加过的项目还在不在：别的页面删掉的项目从列表里剪掉，返回剪掉了几个（页面提示一次） */
export function pruneProjects(ids: string[], projects: { id: string }[]) {
  const alive = new Set(projects.map((p) => p.id))
  const kept = ids.filter((id) => alive.has(id))
  return { ids: kept, removed: ids.length - kept.length }
}
