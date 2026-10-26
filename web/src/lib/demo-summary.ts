/**
 * 在线演示版的工作总结：不跑 CLI，过一秒按选中的项目给一份示例报告。
 * 接口字段和正式后端一致（SummaryJob / SummaryRecord，见 shared/summary.ts），页面两边共用一套代码。
 */
import { todayWindow, type SummaryJob, type SummaryRecord } from '@shared/summary'
import { demoMs } from './demo-speed'

/** 演示用的报告内容：按项目轮流取一条，看起来像真的今天做过的事 */
const DONE = [
  ['修好购物车数量不同步，补了商品列表的加载骨架', '把价格格式化抽成一个函数，统一页面上的显示'],
  ['新增「工作总结」页面，能把今天执行过的对话整理成报告', '报告支持编辑、预览和一键复制'],
  ['补了接口超时的提示，失败时不再只转圈', '把重复的请求封装成一个方法，减少了三处重复代码'],
]
const DECIDED = [
  '数量以服务端返回为准，前端只做乐观更新',
  '报告只存最近几份，旧的在生成时删掉',
  '外部输入在边界校验，内部不再重复判断',
]
const BUGS = [
  '问题在 cart 模块的合并逻辑：异地加购会互相覆盖；改成按商品合并后修好',
  '问题在设置弹窗挂载时机：打开时先出现在左上角再跳到中间；改成挂载后再定位',
  '问题是后台命令的结果没有回传：轮询判断写反了；改正后能正常显示',
]
const TODO = ['结算页的多币种还没验证', '还没加按项目筛选历史报告的入口', '手机宽度下的排版还没检查']

const reports = new Map<string, SummaryRecord>()
const jobs = new Map<string, SummaryJob>()

function sampleMd(names: string[]) {
  return names
    .map((name, i) => {
      const done = DONE[i % DONE.length]
      return [
        `## ${name}`,
        '',
        `- **做了**：${done[0]}`,
        `- **做了**：${done[1]}`,
        `- **关键决策**：${DECIDED[i % DECIDED.length]}`,
        `- **Bug**：${BUGS[i % BUGS.length]}`,
        `- **遗留**：${TODO[i % TODO.length]}`,
        '',
      ].join('\n')
    })
    .join('\n')
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
    const input = body as { projectIds?: string[] }
    const chosen = (input.projectIds ?? [])
      .map((pid) => projects.find((p) => p.id === pid))
      .filter((p): p is { id: string; name: string } => !!p)
    if (!chosen.length) throw new Error('项目不存在')
    const { day } = todayWindow()
    const job: SummaryJob = {
      id: crypto.randomUUID(),
      status: 'running',
      projectIds: chosen.map((p) => p.id),
      md: '',
      tools: [],
      outChars: 0,
      startedAt: Date.now(),
    }
    jobs.set(job.id, job)
    setTimeout(() => (job.thinking = '先看今天每个项目里跑过的对话，按项目整理成几条。'), demoMs(500))
    setTimeout(() => (job.tools = ['任务记录', '消息', '计划']), demoMs(900))
    setTimeout(() => {
      if (job.status !== 'running') return
      const now = new Date().toISOString()
      const record: SummaryRecord = {
        id: crypto.randomUUID(),
        createdAt: now,
        updatedAt: now,
        day,
        projectIds: chosen.map((p) => p.id),
        projectNames: chosen.map((p) => p.name),
        md: sampleMd(chosen.map((p) => p.name)),
        cli: 'demo',
        model: '',
        effort: '',
        taskCount: chosen.length * 2,
      }
      reports.set(record.id, record)
      Object.assign(job, { status: 'done', md: record.md, reportId: record.id })
    }, demoMs(1800))
    return job
  }
  // GET /summary：最近的报告
  return { reports: [...reports.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)) }
}
