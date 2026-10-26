/**
 * 工作总结页的页面状态存档：切到别的页面再回来（甚至刷新）时，已选的项目 / 对话、
 * 正在看的报告（含还没保存的编辑）、预览与编辑 tab、正在生成的 job 都还在。
 *
 * 整页只存一个键：报告本体在服务端（server/summary.ts 保留最近 SUMMARY_KEEP 份），
 * 这里只记「看的是哪一份」和正文草稿，最近报告列表仍以服务端为准。
 * 写不进 localStorage（无痕模式、存储被禁用）时退回内存：同一次打开里切页面仍然保留。
 */

export const SUMMARY_PAGE_KEY = 'summary-page:v1'

/** 报告要分析的一项：项目 + 该项目里选中的对话（空数组表示今天全部对话） */
export interface Pick {
  projectId: string
  taskIds: string[]
}

/** 当前打开的报告：id 用来保存，md 是编辑框里的内容（可能还没自动保存） */
export interface StoredReport {
  id: string
  md: string
}

export type ReportMode = 'preview' | 'edit'

export interface SummaryPageState {
  /** 存这份状态时「今天」是哪天（本机自然日，2026-10-23）：跨天了报告的口径就变了 */
  day: string
  /** 已加入的项目，顺序就是报告里分节的顺序 */
  picks: Pick[]
  report: StoredReport | null
  mode: ReportMode
  /** 还没跑完 / 刚跑完的生成：刷新后接着轮询，不让用户以为「什么都没发生」 */
  jobId: string
  cli: string
}

/** 无痕模式下写不进 localStorage 时，同一次打开里的存档放这里 */
const memory: { raw: string | null } = { raw: null }

const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0

function parsePicks(v: unknown): Pick[] {
  if (!Array.isArray(v)) return []
  const seen = new Set<string>()
  const picks: Pick[] = []
  for (const x of v) {
    const o = x as { projectId?: unknown; taskIds?: unknown } | null
    if (!o || !isText(o.projectId) || seen.has(o.projectId)) continue
    seen.add(o.projectId)
    picks.push({
      projectId: o.projectId,
      taskIds: Array.isArray(o.taskIds) ? o.taskIds.filter(isText) : [],
    })
  }
  return picks
}

function parseReport(v: unknown): StoredReport | null {
  const o = v as { id?: unknown; md?: unknown } | null
  // 没有 id 就存不回去，当作没打开报告
  if (!o || !isText(o.id)) return null
  return { id: o.id, md: typeof o.md === 'string' ? o.md : '' }
}

/** 读存档：坏数据、旧版本缺字段都按默认值处理，页面照常打开 */
export function parseSummaryPage(raw: string | null): SummaryPageState | null {
  if (!raw) return null
  let v: Partial<Record<keyof SummaryPageState, unknown>>
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (!v || typeof v !== 'object') return null
  return {
    day: typeof v.day === 'string' ? v.day : '',
    picks: parsePicks(v.picks),
    report: parseReport(v.report),
    mode: v.mode === 'edit' ? 'edit' : 'preview',
    jobId: typeof v.jobId === 'string' ? v.jobId : '',
    cli: typeof v.cli === 'string' ? v.cli : '',
  }
}

export function loadSummaryPage(): SummaryPageState | null {
  let stored: string | null = null
  try {
    stored = localStorage.getItem(SUMMARY_PAGE_KEY)
  } catch {}
  // 内存里那份永远是最新的（每次 save 都先写它）：先前成功写过、之后配额满写不进去时，
  // localStorage 里只剩一段旧 JSON，不能用它把新的选择盖回去
  return parseSummaryPage(memory.raw ?? stored)
}

export function saveSummaryPage(state: SummaryPageState | null) {
  const raw = state ? JSON.stringify(state) : null
  memory.raw = raw
  try {
    if (raw) localStorage.setItem(SUMMARY_PAGE_KEY, raw)
    else localStorage.removeItem(SUMMARY_PAGE_KEY)
  } catch {}
}

/**
 * 恢复时先按「今天」校正口径：同一天原样恢复；跨天了只留项目（顺序不变、对话清空），
 * 上一天的报告不再是「今天的报告」（「最近的报告」里还能点开），job 也不会跨天还在跑。
 * 今天要分析哪些对话由用户重新挑，避免拿昨天的选择生成一份日期不对的报告。
 */
export function forDay(s: SummaryPageState, day: string): SummaryPageState {
  if (s.day === day) return s
  return {
    day,
    picks: s.picks.map((x) => ({ projectId: x.projectId, taskIds: [] })),
    report: null,
    mode: s.mode,
    jobId: '',
    cli: s.cli,
  }
}

export interface PruneResult {
  picks: Pick[]
  /** 已经从选择里移除的数量：页面据此提示一次，不静默改用户的选择 */
  removedProjects: number
  removedTasks: number
}

/**
 * 剪掉已经不存在的项目和对话：这些可能在别的页面被删了，不能拿它们去生成（服务端会找不到）。
 * 调用方要在项目和任务列表都加载完之后再调，否则会把还没加载出来的当成不存在的清掉。
 */
export function prunePicks(
  picks: Pick[],
  projects: { id: string }[],
  tasks: { id: string; projectId?: string | null }[],
): PruneResult {
  const projectIds = new Set(projects.map((p) => p.id))
  const tasksOf = new Map<string, Set<string>>()
  for (const task of tasks) {
    if (!task.projectId) continue
    const ids = tasksOf.get(task.projectId) ?? new Set<string>()
    ids.add(task.id)
    tasksOf.set(task.projectId, ids)
  }
  const kept: Pick[] = []
  let removedProjects = 0
  let removedTasks = 0
  for (const pick of picks) {
    if (!projectIds.has(pick.projectId)) {
      removedProjects += 1
      continue
    }
    const alive = tasksOf.get(pick.projectId) ?? new Set<string>()
    const taskIds = pick.taskIds.filter((id) => alive.has(id))
    removedTasks += pick.taskIds.length - taskIds.length
    kept.push({ projectId: pick.projectId, taskIds })
  }
  return { picks: kept, removedProjects, removedTasks }
}
