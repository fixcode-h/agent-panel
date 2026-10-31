/**
 * 工作总结：左边是全部报告的树（按日期归档），右边是提炼面板或打开的报告。
 *
 * 地址：#/summary 是提炼面板，#/summary/<报告 id> 打开一份报告。
 * 提炼分两步：先由「每日工作总结」角色提炼出一条条需求 / Bug（服务端 job，页面轮询），
 * 用户逐项采纳，确认后只用采纳的分项拼出报告（见 shared/summary.ts 的 renderReport）。
 * 来源、日期、进行中的提炼和已采纳的分项存在本机（web/src/lib/summary-page.ts），加过的项目存在服务端。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { FileText } from 'lucide-react'
import { toast } from '@/lib/toast'
import { copyText } from '@/lib/copy-text'
import { getCli } from '@shared/clis'
import { agentRun } from '@shared/settings'
import {
  activeInRange,
  reportSpan,
  reportsInWindow,
  summaryPeriod,
  summaryRole,
  type SummaryJob,
  type SummaryRecord,
} from '@shared/summary'
import { taskDeleted } from '@shared/task'
import { dayKey, USAGE_LOOKBACK_DAYS } from '@shared/usage'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { useData, useNav, useTasks } from '@/lib/data'
import { loadSummaryPage, pruneProjects, saveSummaryPage, type SummaryPageState } from '@/lib/summary-page'
import { ConfirmDialog } from '@/components/ui/dialog'
import { DetailEmpty } from '@/components/layout/Detail'
import { ReportTree } from '@/components/summary/ReportTree'
import { ReportView } from '@/components/summary/ReportView'
import { SummaryComposer } from '@/components/summary/SummaryComposer'

/** 提炼中的轮询间隔：CLI 一轮要跑十几秒，再密也没用 */
const POLL_MS = 700
/** 轮询连续失败几次才判失败：面板重启一下、网络断一下不该把还在跑的提炼算失败 */
const POLL_FAIL_MAX = 3

export function SummaryPage() {
  const { route, go } = useNav()
  const { projects, agents, settings, clis, loading } = useData()
  const { tasks } = useTasks()
  const [page, setPage] = useState<SummaryPageState>(() => loadSummaryPage())
  /** 改页面状态的唯一入口：同时写回本机，切页面 / 刷新后按它恢复 */
  const patch = (p: Partial<SummaryPageState>) =>
    setPage((s) => {
      const next = { ...s, ...p }
      saveSummaryPage(next)
      return next
    })
  const [reports, setReports] = useState<SummaryRecord[]>([])
  const [loaded, setLoaded] = useState(false)
  /** 面板里加过的项目；null 表示还没从服务端读回来 */
  const [projectIds, setProjectIds] = useState<string[] | null>(null)
  const [job, setJob] = useState<SummaryJob | null>(null)
  const [error, setError] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState<SummaryRecord | null>(null)
  const pollFails = useRef(0)
  const [pollTick, setPollTick] = useState(0)
  const pruned = useRef(false)

  // 每次渲染按今天重算：页面一直开着跨过午夜时，「今天」也跟着变
  const today = dayKey(new Date())
  const win = useMemo(() => summaryPeriod(page.grain, page.day || today), [page.grain, page.day, today])
  const selected = route.id ? reports.find((r) => r.id === route.id) : undefined

  useEffect(() => {
    void api
      .summary()
      .then((r) => setReports(r.reports))
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoaded(true))
    void api
      .summaryConfig()
      .then((c) => setProjectIds(c.projectIds))
      .catch((e) => {
        setProjectIds([])
        setError((e as Error).message)
      })
  }, [])

  // 地址里的报告已经不在了（被删、数据目录换了）：回到提炼面板，不留一个打不开的页面
  useEffect(() => {
    if (!loaded || !route.id || selected) return
    toast.info(t('这份报告已经不在本机了'))
    go({ page: 'summary' })
    // 只在报告列表读回来、地址对不上时纠正一次；go 每次渲染都是新的
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, route.id, selected])

  // 别的页面删掉的项目从面板里剪掉，并提示一次（不静默改用户的选择）
  useEffect(() => {
    if (loading || projectIds === null || pruned.current) return
    pruned.current = true
    const r = pruneProjects(projectIds, projects)
    if (!r.removed) return
    void saveProjects(r.ids)
    toast.info(t('{n} 个项目已不存在，已从列表里移除', { n: r.removed }))
    // 只在第一次加载完做：之后用户自己的增删不再走这里
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, projectIds, projects])

  // 接回上次的提炼：还在跑就接着轮询，跑完了就把分项拿回来；找不到（服务端重启、过了一小时）就清掉
  useEffect(() => {
    if (!page.jobId) return
    void api
      .summaryJob(page.jobId)
      .then((j) => {
        setJob(j)
        if (j.status === 'failed') setError(j.error ?? t('提炼失败'))
      })
      .catch(() => patch({ jobId: '', adopted: [] }))
    // 只在挂载时接一次；之后的 job 由轮询更新
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 提炼中轮询：结束时停，失败时把 CLI 的报错显示出来
  useEffect(() => {
    if (job?.status !== 'running') return
    const timer = setTimeout(async () => {
      try {
        const next = await api.summaryJob(job.id)
        pollFails.current = 0
        setJob(next)
        if (next.status === 'failed') setError(next.error ?? t('提炼失败'))
      } catch (e) {
        pollFails.current += 1
        if (pollFails.current >= POLL_FAIL_MAX) {
          setJob({ ...job, status: 'failed', error: (e as Error).message })
          setError((e as Error).message)
        } else setPollTick((n) => n + 1)
      }
    }, POLL_MS)
    return () => clearTimeout(timer)
  }, [job, pollTick])

  const saveProjects = async (ids: string[]) => {
    const prev = projectIds
    setProjectIds(ids)
    try {
      await api.saveSummaryConfig({ projectIds: ids })
    } catch (e) {
      setProjectIds(prev)
      toast.error(t('项目列表没有保存：{error}', { error: (e as Error).message }))
    }
  }

  /** 生成用的角色：本机的「每日工作总结」，它的 CLI / 模型按设置算；CLI 没装或停用时不能提炼 */
  const role = useMemo(() => {
    if (!settings) return null
    const a = summaryRole(agents)
    const run = agentRun(a, settings)
    const usable = clis.some((c) => c.id === run.cli && c.installed && c.enabled)
    if (!usable) return null
    return {
      name: a.name,
      cli: run.cli,
      cliName: getCli(run.cli)?.name ?? run.cli,
      model: run.model,
      // 本机没有这个角色（被删了）时按内置定义跑，没有可以点开的角色
      onOpen: a.own ? () => go({ page: 'agents', id: a.id }) : undefined,
    }
    // go 每次渲染都是新的，不影响结果
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [agents, settings, clis])

  const ids = useMemo(() => projectIds ?? [], [projectIds])
  /** 各项目在当前窗口里执行过几条对话（和服务端筛选同一个判定） */
  const projectCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const x of tasks)
      if (x.projectId && !taskDeleted(x) && activeInRange(x, win)) m.set(x.projectId, (m.get(x.projectId) ?? 0) + 1)
    return m
  }, [tasks, win])
  /** 月历上的圆点：对话来源标出加过的项目有对话的日子，报告来源标出有报告的日子 */
  const marked = useMemo(() => {
    const s = new Set<string>()
    if (page.source === 'reports') {
      for (const r of reports) {
        const { from, to } = reportSpan(r)
        if (from === to) s.add(from)
      }
      return s
    }
    const set = new Set(ids)
    for (const x of tasks)
      if (set.has(x.projectId) && !taskDeleted(x))
        for (const iso of [x.updatedAt, x.turnDoneAt, x.runStartedAt]) if (iso) s.add(dayKey(new Date(iso)))
    return s
  }, [page.source, reports, tasks, ids])
  const minDay = useMemo(() => {
    const d = new Date()
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - USAGE_LOOKBACK_DAYS)
  }, [])
  const sourceReports = useMemo(() => reportsInWindow(reports, win), [reports, win])
  const adopted = useMemo(() => new Set(page.adopted), [page.adopted])

  /** 换来源 / 粒度 / 日期：上一次提炼的结果属于旧的那一段，收起来（提炼中不允许换，按钮已禁用） */
  const changeScope = (p: Partial<SummaryPageState>) => {
    if (job?.status === 'running') return
    setJob(null)
    setError('')
    patch({ ...p, jobId: '', adopted: [] })
  }

  const extract = async () => {
    setError('')
    pollFails.current = 0
    try {
      const next = await api.extractSummary({
        source: page.source,
        grain: page.grain,
        day: win.fromDay,
        projectIds: ids,
      })
      setJob(next)
      patch({ jobId: next.id, adopted: [] })
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const stop = async () => {
    if (!job) return
    try {
      setJob(await api.stopSummary(job.id))
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const confirm = async () => {
    if (!job || confirming) return
    const items = job.items.filter((x) => adopted.has(x.id))
    if (!items.length) return
    setConfirming(true)
    try {
      // 报告里实际出现的项目：按分项里的项目名，分项都没写项目时用加过的项目
      const fromItems = [...new Set(items.map((x) => x.project).filter(Boolean))]
      const names = fromItems.length
        ? fromItems
        : projects.filter((p) => job.projectIds.includes(p.id)).map((p) => p.name)
      const rec = await api.createSummary({
        source: job.source,
        grain: job.grain,
        from: job.from,
        to: job.to,
        projectIds: job.source === 'tasks' ? job.projectIds : [],
        projectNames: names,
        items,
        cli: job.cli,
        model: job.model,
        effort: job.effort,
        taskCount: job.taskCount,
        reportCount: job.reportCount,
        durationMs: job.durationMs ?? 0,
      })
      setReports((prev) => [rec, ...prev])
      setJob(null)
      patch({ jobId: '', adopted: [], mode: 'preview' })
      toast.success(t('报告已生成'))
      go({ page: 'summary', id: rec.id })
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setConfirming(false)
    }
  }

  const remove = async (r: SummaryRecord) => {
    try {
      await api.deleteSummary(r.id)
      setReports((prev) => prev.filter((x) => x.id !== r.id))
      if (route.id === r.id) go({ page: 'summary' })
      toast.success(t('已删除报告'))
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const copy = (md: string) => void copyText(md, { done: t('已复制报告'), fail: t('复制失败') })

  return (
    <>
      <ReportTree
        reports={reports}
        loaded={loaded}
        selected={route.id ?? ''}
        onSelect={(id) => go({ page: 'summary', id })}
        onNew={() => go({ page: 'summary' })}
        onCopy={(r) => copy(r.md)}
        onDelete={setDeleting}
      />
      {route.id ? (
        selected ? (
          <ReportView
            key={selected.id}
            report={selected}
            mode={page.mode}
            onMode={(mode) => patch({ mode })}
            onCopy={copy}
            onSaved={(md) => setReports((prev) => prev.map((r) => (r.id === selected.id ? { ...r, md } : r)))}
            onDelete={() => setDeleting(selected)}
          />
        ) : (
          <DetailEmpty icon={<FileText className="h-6 w-6" />} title={t('读取中…')} />
        )
      ) : (
        <SummaryComposer
          source={page.source}
          onSource={(source) => changeScope({ source })}
          grain={page.grain}
          onGrain={(grain) => changeScope({ grain })}
          win={win}
          onDay={(d) => changeScope({ day: dayKey(d) })}
          onToday={() => changeScope({ day: '' })}
          marked={marked}
          minDay={minDay}
          projects={projects}
          projectIds={ids}
          projectCounts={projectCounts}
          onProjects={(next) => void saveProjects(next)}
          sourceReports={sourceReports}
          onOpenReport={(id) => go({ page: 'summary', id })}
          role={role}
          job={job}
          error={error}
          adopted={adopted}
          onToggle={(id) =>
            patch({ adopted: adopted.has(id) ? page.adopted.filter((x) => x !== id) : [...page.adopted, id] })
          }
          onAdoptAll={(list, on) =>
            patch({
              adopted: on ? [...new Set([...page.adopted, ...list])] : page.adopted.filter((x) => !list.includes(x)),
            })
          }
          onExtract={extract}
          onStop={stop}
          onConfirm={confirm}
          confirming={confirming}
        />
      )}
      <ConfirmDialog
        open={!!deleting}
        title={t('删除这份报告？')}
        description={t('删除后不能恢复；它提炼过的候选教训草稿不受影响。')}
        onConfirm={async () => {
          if (deleting) await remove(deleting)
          setDeleting(null)
        }}
        onOpenChange={(open) => !open && setDeleting(null)}
      />
    </>
  )
}
