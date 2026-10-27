/**
 * 在线演示版的工作总结：不跑 CLI，过一秒按选中的项目给一份示例报告。
 * 接口字段和正式后端一致（SummaryJob / SummaryRecord，见 shared/summary.ts），页面两边共用一套代码；
 * 报告结构也和正式版一样：三个二级节、项目三级标题、条目带序号（格式自检能直接通过）。
 */
import {
  DEFAULT_SUMMARY_RANGE,
  rangeWindow,
  type SummaryJob,
  type SummaryRange,
  type SummaryRecord,
} from '@shared/summary'
import { LessonDraftInput, LessonDraftRecord, lessonDraftsFromReport, missingDrafts } from '@shared/lesson-draft'
import { demoMs } from './demo-speed'

/** 演示用的需求条目：标题、状态、实现原理 */
const NEEDS = [
  { title: '购物车数量不同步', status: '已完成（4/4）', how: '数量以服务端返回为准，前端只做乐观更新' },
  { title: '商品列表缺加载骨架', status: '已完成（3/3）', how: '首次加载时先渲染和行高等高的占位块' },
  { title: '价格显示格式不统一', status: '进行中（2/5）', how: '把格式化收成一个函数，所有页面都调它' },
  { title: '接口超时只转圈不提示', status: '已完成（2/2）', how: '请求失败统一走错误提示，不再静默重试' },
]
/** 演示里的 Bug：只有用户在对话里报过的问题才写进来 */
const BUGS = [
  {
    title: '点「全部应用」后按钮没有变化',
    cause: '保存只更新了内存里的值，没有回写接口',
    fix: '保存后重新拉一遍配置并刷新按钮状态',
  },
  {
    title: '设置弹窗打开时先闪在左上角',
    cause: '弹窗挂载时还没拿到定位用的锚点',
    fix: '等挂载完成后再定位，打开即居中',
  },
]
/** 每个项目最多给几条需求 / 几条 Bug，够看出格式即可 */
const NEEDS_PER_PROJECT = 2

/**
 * 演示里第二份报告和第一份不一样：点「对比两份」时能看到新增、消失和状态变化。
 * 第一条状态推进（状态变化）、第二条换成新需求（旧的消失、新的新增），Bug 同理
 */
const NEEDS_NEXT = [
  { ...NEEDS[0], status: '已完成（6/6）', how: '数量以服务端为准，加购和结算都读同一个值' },
  { title: '搜索框支持拼音输入', status: '进行中（1/3）', how: '输入先转成拼音再匹配商品名' },
  NEEDS[3],
]
const BUGS_NEXT = [
  {
    title: '总结页换范围后还显示上一段的报告',
    cause: '换范围时没把当前报告清掉',
    fix: '换范围时一起清空当前报告和对比',
  },
  BUGS[1],
]

const reports = new Map<string, SummaryRecord>()
const jobs = new Map<string, SummaryJob>()
/** 候选教训草稿：和正式后端同一套提炼（shared/lesson-draft.ts），字段也一致 */
const drafts = new Map<string, LessonDraftRecord>()

const draftList = () => [...drafts.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))

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

/** round > 0（第二份及以后）时换成推进过的条目：演示里两份报告对比能看到差异 */
function sampleMd(day: string, names: string[], round: number) {
  const needPool = round ? NEEDS_NEXT : NEEDS
  const bugPool = round ? BUGS_NEXT : BUGS
  const needs = names.map((name, i) => {
    const picked = Array.from(
      { length: NEEDS_PER_PROJECT },
      (_, k) => needPool[(i * NEEDS_PER_PROJECT + k) % needPool.length],
    )
    return [
      `### 1.${i + 1} ${name}`,
      ...picked.flatMap((n, k) => [`${k + 1}. **${n.title}** ｜ ${n.status}`, `   实现：${n.how}`]),
      '',
    ]
  })
  const bugs = names.map((name, i) => {
    const bug = bugPool[i % bugPool.length]
    return [`### 2.${i + 1} ${name}`, `1. **${bug.title}**`, `   原因：${bug.cause}`, `   修复：${bug.fix}`, '']
  })
  return [
    `# ${day} 工作总结`,
    '',
    '## 一、需求进度',
    '',
    ...needs.flat(),
    '## 二、用户报告的 Bug',
    '',
    ...bugs.flat(),
    '## 三、今日小结',
    `今天完成了 ${names.length} 个项目的主要需求，剩下的按计划继续推进。`,
    '',
  ].join('\n')
}

export function demoSummary(
  method: string,
  id: string | undefined,
  sub: string | undefined,
  tail: string | undefined,
  body: unknown,
  projects: { id: string; name: string }[],
): unknown {
  // /summary/jobs/:id、/summary/jobs/:id/stop
  if (id === 'jobs' && sub) {
    const job = jobs.get(sub)
    if (!job) throw new Error('找不到这次生成，可能已过期')
    if (tail === 'stop' && job.status === 'running') Object.assign(job, { status: 'stopped' })
    return job
  }
  // /summary/:id：保存编辑后的正文
  if (method === 'PUT' && id) {
    const rec = reports.get(id)
    if (!rec) throw new Error('找不到这份报告')
    rec.md = String((body as { md?: string }).md ?? '')
    rec.updatedAt = new Date().toISOString()
    return rec
  }
  // POST /summary：开始生成
  if (method === 'POST') {
    const input = body as { projects?: { projectId?: string; taskIds?: string[] }[]; range?: SummaryRange }
    const chosen = (input.projects ?? [])
      .map((p) => {
        const project = projects.find((x) => x.id === p.projectId)
        return project ? { id: project.id, name: project.name, taskIds: p.taskIds ?? [] } : null
      })
      .filter((p): p is { id: string; name: string; taskIds: string[] } => !!p)
    if (!chosen.length) throw new Error('项目不存在')
    // 和正式后端同一个窗口函数：标题、记录里的 from / to 都按选中的范围走
    const win = rangeWindow(input.range ?? DEFAULT_SUMMARY_RANGE)
    const day = win.toDay
    const job: SummaryJob = {
      id: crypto.randomUUID(),
      status: 'running',
      projectIds: chosen.map((p) => p.id),
      from: win.fromDay,
      to: win.toDay,
      md: '',
      tools: [],
      outChars: 0,
      startedAt: Date.now(),
    }
    jobs.set(job.id, job)
    setTimeout(() => (job.thinking = '先看今天每个项目里跑过的对话，按项目整理成三节。'), demoMs(500))
    setTimeout(() => (job.tools = ['任务记录', '消息', '计划']), demoMs(900))
    setTimeout(() => {
      if (job.status !== 'running') return
      const now = new Date().toISOString()
      const record: SummaryRecord = {
        id: crypto.randomUUID(),
        createdAt: now,
        updatedAt: now,
        day,
        from: win.fromDay,
        to: win.toDay,
        projectIds: chosen.map((p) => p.id),
        projectNames: chosen.map((p) => p.name),
        md: sampleMd(
          win.fromDay === win.toDay ? win.fromDay : `${win.fromDay} - ${win.toDay}`,
          chosen.map((p) => p.name),
          reports.size,
        ),
        cli: 'demo',
        model: '',
        effort: '',
        // 没挑对话时按项目今天两条估算，和正式版「不选就是全部」的口径一致
        taskCount: chosen.reduce((n, p) => n + Math.max(p.taskIds.length, 2), 0),
      }
      reports.set(record.id, record)
      Object.assign(job, {
        status: 'done',
        md: record.md,
        reportId: record.id,
        format: { ok: true, issues: [], retried: false },
      })
    }, demoMs(1800))
    return job
  }
  // GET /summary：最近的报告
  return { reports: [...reports.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)) }
}
