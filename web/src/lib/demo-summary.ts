/**
 * 在线演示版的工作总结：不跑 CLI，过一会儿按选中的项目给出示例分项（需求 / Bug），
 * 采纳后用正式那份 renderReport 拼报告。接口字段和正式后端一致（SummaryJob / SummaryRecord，见 shared/summary.ts），
 * 页面两边共用一套代码。第一次打开时预置几份报告，左侧树里能看到按天、按周的分组。
 */
import {
  renderReport,
  reportsInWindow,
  summaryPeriod,
  SummaryCreateRequest,
  SummaryExtractRequest,
  type SummaryEntry,
  type SummaryJob,
  type SummaryRecord,
} from '@shared/summary'
import { dayKey } from '@shared/usage'
import { LessonDraftInput, LessonDraftRecord, lessonDraftsFromReport, missingDrafts } from '@shared/lesson-draft'
import { demoMs } from './demo-speed'

/** 演示用的需求：标题 + 做了什么 */
const NEEDS = [
  {
    title: '购物车数量与结算页保持一致',
    content: '加购、改数量和结算都以服务端返回的数量为准，切页面后不再出现两个数字',
  },
  { title: '商品列表首屏加载骨架', content: '首次加载时先显示和真实行等高的占位块，数据到了再替换，页面不再跳动' },
  { title: '价格显示统一保留两位小数', content: '所有页面改用同一个价格格式化入口，列表、详情和订单里的金额写法一致' },
  { title: '搜索框支持拼音首字母', content: '输入拼音首字母也能匹配商品名，例如输入 sj 能搜到「手机」' },
]
/** 演示里的 Bug：只有用户在对话里报过的问题才写进来 */
const BUGS = [
  {
    title: '点「全部应用」后按钮状态不变',
    cause: '保存只改了内存里的值，没有写回接口，刷新后又变回旧状态',
    fix: '保存成功后重新拉取配置并刷新按钮；已用界面检查确认',
  },
  {
    title: '设置弹窗打开时先闪在左上角',
    cause: '弹窗挂载时还没拿到定位用的锚点，第一帧按默认位置画',
    fix: '等挂载完成后再定位，打开即居中',
  },
  {
    title: '接口超时后页面一直转圈',
    cause: '超时的请求没有走统一的错误处理，加载状态没被清掉',
    fix: '所有请求失败都清掉加载状态并提示原因',
  },
]

const reports = new Map<string, SummaryRecord>()
const jobs = new Map<string, SummaryJob>()
/** 面板里加过的项目：演示里只存在内存 */
let config: { projectIds: string[] } = { projectIds: [] }
/** 候选教训草稿：和正式后端同一套提炼（shared/lesson-draft.ts），字段也一致 */
const drafts = new Map<string, LessonDraftRecord>()

const draftList = () => [...drafts.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
const reportList = () => [...reports.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))

/** 按项目名给一组示例分项：每个项目两条需求、一条 Bug，round 换一批，几次提炼看到的不一样 */
function sampleItems(names: string[], round: number): SummaryEntry[] {
  return names.flatMap((project, i) => {
    const k = i + round
    const needs = [NEEDS[k % NEEDS.length], NEEDS[(k + 1) % NEEDS.length]]
    const bug = BUGS[k % BUGS.length]
    return [
      ...needs.map((n) => ({ id: crypto.randomUUID(), kind: 'need' as const, project, ...n, cause: '', fix: '' })),
      { id: crypto.randomUUID(), kind: 'bug' as const, project, content: '', ...bug },
    ]
  })
}

/** 预置一份报告：createdAt 往前推，树里按天、按周分组时有内容可看 */
function seedReport(grain: 'day' | 'week', day: Date, names: string[], round: number, hour: number) {
  const win = summaryPeriod(grain, day)
  const items = sampleItems(names, round)
  const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour).toISOString()
  const rec: SummaryRecord = {
    id: crypto.randomUUID(),
    createdAt: at,
    updatedAt: at,
    day: win.toDay,
    from: win.fromDay,
    to: win.toDay,
    grain,
    source: grain === 'week' ? 'reports' : 'tasks',
    projectIds: [],
    projectNames: grain === 'week' ? [] : names,
    md: renderReport({ grain, from: win.fromDay, to: win.toDay, items }),
    items,
    cli: 'demo',
    model: '',
    effort: '',
    taskCount: grain === 'week' ? 0 : names.length * 3,
    reportCount: grain === 'week' ? 3 : 0,
    durationMs: demoMs(1600),
  }
  reports.set(rec.id, rec)
}

let seeded = false
/** 第一次读报告时预置：昨天两份、前天一份、上周一份周报 */
function seed(projects: { id: string; name: string }[]) {
  if (seeded) return
  seeded = true
  const names = projects.slice(0, 2).map((p) => p.name)
  if (!names.length) return
  const now = new Date()
  const ago = (n: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - n)
  seedReport('day', ago(1), names.slice(0, 1), 0, 18)
  seedReport('day', ago(1), names, 1, 20)
  seedReport('day', ago(2), names, 2, 19)
  seedReport('week', ago(7), names, 3, 21)
}

/**
 * 演示版的候选教训草稿区：接口字段和正式后端一致。
 * 提炼走的是正式那份纯函数，所以演示里看到的就是真实规则的结果（有 Bug 条目就会出草稿）。
 */
export function demoLessonDrafts(method: string, id: string | undefined, body: unknown): unknown {
  if (method === 'GET' && !id) return { drafts: draftList() }
  if (method === 'POST' && !id) {
    const reportId = String((body as { reportId?: string }).reportId ?? '')
    const report = reports.get(reportId)
    if (!report) throw new Error('找不到这份报告')
    // 和正式后端同一套：只补草稿区还没有的条目，丢掉一条后能再找回来
    const found = lessonDraftsFromReport(report)
    const missing = missingDrafts(
      found,
      draftList().filter((d) => d.reportId === reportId),
    )
    const now = new Date().toISOString()
    for (const x of missing) {
      const rec: LessonDraftRecord = { ...x, id: crypto.randomUUID(), createdAt: now, updatedAt: now }
      drafts.set(rec.id, rec)
    }
    return {
      drafts: draftList(),
      created: missing.length,
      info: missing.length
        ? ''
        : found.length
          ? '这份报告的候选教训都已经在草稿区了'
          : '这份报告里没有可提炼的返工，不硬造条目',
    }
  }
  if (method === 'PUT' && id) {
    const cur = drafts.get(id)
    if (!cur) throw new Error('找不到这条草稿')
    const next: LessonDraftRecord = {
      ...cur,
      ...LessonDraftInput.parse(body),
      id: cur.id,
      createdAt: cur.createdAt,
      updatedAt: new Date().toISOString(),
    }
    drafts.set(id, next)
    return next
  }
  if (method === 'DELETE' && id) {
    if (!drafts.delete(id)) throw new Error('找不到这条草稿')
    return undefined
  }
  throw new Error('演示版不支持这个操作')
}

export function demoSummary(
  method: string,
  id: string | undefined,
  sub: string | undefined,
  tail: string | undefined,
  body: unknown,
  projects: { id: string; name: string }[],
): unknown {
  seed(projects)
  // /summary/jobs/:id、/summary/jobs/:id/stop
  if (id === 'jobs' && sub) {
    const job = jobs.get(sub)
    if (!job) throw new Error('找不到这次提炼，可能已过期')
    if (tail === 'stop' && job.status === 'running') Object.assign(job, { status: 'stopped' })
    return job
  }
  if (id === 'config') {
    if (method === 'PUT') config = { projectIds: [...new Set((body as { projectIds?: string[] }).projectIds ?? [])] }
    return config
  }
  // POST /summary/extract：开始提炼
  if (id === 'extract' && method === 'POST') {
    const input = SummaryExtractRequest.parse(body)
    if (input.source === 'tasks' && !input.projectIds.length) throw new Error('先添加要总结的项目')
    const win = summaryPeriod(input.grain, input.day)
    const chosen = input.projectIds
      .map((pid) => projects.find((x) => x.id === pid))
      .filter((p): p is { id: string; name: string } => !!p)
    // 来源是报告时和正式版同一个口径取窗口内的报告，分项从这些报告里来
    const sources = input.source === 'reports' ? reportsInWindow(reportList(), win) : []
    const job: SummaryJob = {
      id: crypto.randomUUID(),
      status: 'running',
      source: input.source,
      grain: input.grain,
      from: win.fromDay,
      to: win.toDay,
      projectIds: input.projectIds,
      items: [],
      taskCount: input.source === 'tasks' ? chosen.length * 3 : 0,
      reportCount: sources.length,
      cli: 'demo',
      model: '',
      effort: '',
      tools: [],
      outChars: 0,
      startedAt: Date.now(),
    }
    jobs.set(job.id, job)
    // 选的那天不在演示数据里（太早、未来）时，和正式版一样直接给空结果
    const empty = input.source === 'reports' ? !sources.length : !chosen.length || win.fromDay > dayKey(new Date())
    setTimeout(() => (job.thinking = '先按项目把这段时间做过的事分成需求和 Bug，再合并重复的条目。'), demoMs(400))
    setTimeout(() => (job.outChars = 860), demoMs(900))
    setTimeout(() => {
      if (job.status !== 'running') return
      const items = empty
        ? []
        : input.source === 'reports'
          ? // 汇总报告：把几份报告的分项按标题去重，模拟「同一件事合成一条」
            [...new Map(sources.flatMap((r) => r.items).map((x) => [`${x.project}|${x.title}`, x])).values()].map(
              (x) => ({ ...x, id: crypto.randomUUID() }),
            )
          : sampleItems(
              chosen.map((p) => p.name),
              reports.size,
            )
      Object.assign(job, { status: 'done', items, durationMs: demoMs(1500) })
    }, demoMs(1500))
    return job
  }
  // PUT /summary/:id：保存编辑后的正文
  if (method === 'PUT' && id) {
    const rec = reports.get(id)
    if (!rec) throw new Error('找不到这份报告')
    rec.md = String((body as { md?: string }).md ?? '')
    rec.updatedAt = new Date().toISOString()
    return rec
  }
  if (method === 'DELETE' && id) {
    if (!reports.delete(id)) throw new Error('找不到这份报告')
    return { ok: true }
  }
  // POST /summary：用采纳的分项拼报告
  if (method === 'POST') {
    const input = SummaryCreateRequest.parse(body)
    const now = new Date().toISOString()
    const { items, ...meta } = input
    const rec: SummaryRecord = {
      ...meta,
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
      day: meta.to,
      md: renderReport({ grain: meta.grain, from: meta.from, to: meta.to, items }),
      items,
    }
    reports.set(rec.id, rec)
    return rec
  }
  // GET /summary：全部报告
  return { reports: reportList() }
}
