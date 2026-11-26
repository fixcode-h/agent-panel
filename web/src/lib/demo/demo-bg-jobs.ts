/**
 * 演示：后台作业（ADR 0075）。演示没有真的后台任务，放一条跑着的编译（进度自己往前走）、一条完成的下载、一条失败的安装，
 * 取消和清除照真的做；状态变化在页面里发 bg-jobs 窗口事件（演示没有推送通道）
 */
import type { BgJob, BgJobLog } from '@shared/jobs/types'
import { DEMO_BG_JOBS_EVENT } from '@/lib/live/bg-jobs'
import { fail } from './demo-http'

const t0 = Date.now()
const jobs: BgJob[] = [
  {
    id: 'demo-build',
    source: 'ue',
    kind: 'build',
    title: '编译 ShopGameEditor',
    status: 'running',
    phase: '编译 C++',
    done: 12,
    total: 40,
    startedAt: t0 - 40_000,
    cancelable: true,
    lines: 6,
  },
  {
    id: 'demo-dl',
    source: 'panel',
    kind: 'download',
    title: '下载语音识别模型',
    status: 'done',
    startedAt: t0 - 600_000,
    endedAt: t0 - 540_000,
    cancelable: false,
    lines: 2,
    info: '已下载 75 MB',
  },
  {
    id: 'demo-install',
    source: 'ue',
    kind: 'install',
    title: '安装 UELink 2.20.1',
    status: 'failed',
    startedAt: t0 - 900_000,
    endedAt: t0 - 880_000,
    cancelable: false,
    lines: 3,
    info: '项目目录只读：先签出 Plugins/UELink',
  },
] // 演示的作业只在这一页里
const logs: Record<string, string[]> = {
  'demo-build': [
    '> Build.bat ShopGameEditor Win64 Development',
    'Using bundled DotNet SDK',
    'Building ShopGameEditor...',
    '[1/40] Compile Module.Shop.cpp',
    '[2/40] Compile Module.Cart.cpp',
    '[12/40] Compile Module.Checkout.cpp',
  ],
  'demo-dl': ['下载 https://…/sherpa-zh.tar.bz2', '完成，75 MB'],
  'demo-install': ['复制 UELink 到 Plugins/UELink', 'EACCES: permission denied', '项目目录只读：先签出 Plugins/UELink'],
}

const emit = () => window.dispatchEvent(new CustomEvent(DEMO_BG_JOBS_EVENT, { detail: { jobs: [...jobs] } }))
// 跑着的编译自己往前走，走完算完成。第一次有人取列表时才开始走、编译结束就停：
// 模块一加载就挂一个不停的定时器，单测进程（demo-contract）会因为它一直不退出
// 模块状态：演示编译的计时器，只有一个
let ticker: ReturnType<typeof setInterval> | undefined
const startTicker = () => {
  if (ticker || !jobs.some((j) => j.id === 'demo-build' && j.status === 'running')) return
  ticker = setInterval(tick, 3000)
}
function tick() {
  const b = jobs.find((j) => j.id === 'demo-build' && j.status === 'running')
  if (!b) {
    clearInterval(ticker)
    ticker = undefined
    return
  }
  b.done = Math.min(40, (b.done ?? 0) + 1)
  logs[b.id].push(`[${b.done}/40] Compile Module.Part${b.done}.cpp`)
  b.lines = logs[b.id].length
  if (b.done >= 40) Object.assign(b, { status: 'done', endedAt: Date.now(), cancelable: false, info: '编译通过' })
  emit()
}

/** 别的演示模块开一条作业（演示的「安装 rg」）：返回追加日志、改状态的办法 */
export function demoStartJob(job: Omit<BgJob, 'startedAt' | 'lines' | 'status' | 'cancelable'>) {
  const j: BgJob = { ...job, status: 'running', startedAt: Date.now(), cancelable: false, lines: 0 }
  jobs.unshift(j)
  logs[j.id] = []
  emit()
  return {
    step(phase: string) {
      logs[j.id].push(`> ${phase}`)
      Object.assign(j, { phase, lines: logs[j.id].length })
      emit()
    },
    end(ok: boolean, info?: string) {
      Object.assign(j, { status: ok ? 'done' : 'failed', endedAt: Date.now(), ...(info ? { info } : {}) })
      emit()
    },
  }
}

export function demoBgJobs(method: string, id: string | undefined, sub: string | undefined, query: URLSearchParams) {
  if (method === 'GET' && !id) {
    startTicker()
    return { jobs }
  }
  if (method === 'POST' && id === 'clear') {
    for (let i = jobs.length - 1; i >= 0; i--) if (jobs[i].status !== 'running') jobs.splice(i, 1)
    emit()
    return { jobs }
  }
  const j = jobs.find((x) => x.id === id)
  if (!j) return fail('没有这条作业（可能面板重启过）', 404)
  if (sub === 'log') {
    const from = Number(query.get('from') ?? 0) || 0
    const all = logs[j.id] ?? []
    return { lines: all.slice(from), next: all.length } satisfies BgJobLog
  }
  if (sub === 'cancel') {
    if (j.status !== 'running') return { ok: false, info: '这条作业已经结束了' }
    Object.assign(j, { status: 'canceled', endedAt: Date.now(), cancelable: false })
    logs[j.id].push('已取消')
    emit()
    return { ok: true, info: '' }
  }
  return fail('not found', 404)
}
