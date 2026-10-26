/**
 * 工作总结：先选一个项目点「增加」，再在该项目下挑要分析的对话（不挑就是今天全部），
 * 把「今天」（本机时区的自然日）执行过的对话交给本机 CLI，生成一份固定三节格式的 Markdown 报告。
 * 报告能编辑（自动保存）、预览、一键复制；最近几份存在数据目录里（见 server/summary.ts），点开能回看。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from '@/lib/toast'
import { AlertTriangle, Copy, FileText, Loader2, Plus, Sparkles, Square, X } from 'lucide-react'
import { CLIS } from '@shared/clis'
import { defaultCli, orderClis } from '@shared/settings'
import {
  activeOnDay,
  reportTitle,
  todayWindow,
  type SummaryFormatIssue,
  type SummaryJob,
  type SummaryRecord,
} from '@shared/summary'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { useAutosave } from '@/lib/useAutosave'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Select, Textarea } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
import { Markdown } from '@/components/tasks/Markdown'
import { PageFrame } from '@/components/library/parts'
import {
  forDay,
  loadSummaryPage,
  prunePicks,
  saveSummaryPage,
  type Pick,
  type ReportMode,
  type SummaryPageState,
} from '@/lib/summary-page'

const NO_TEAM = new Set<string>()
/** 生成中的轮询间隔：CLI 一轮要跑十几秒，再密也没用 */
const POLL_MS = 700
/** 轮询连续失败几次才判失败：面板重启一下、网络断一下不该把还在跑的报告算失败 */
const POLL_FAIL_MAX = 3
/** 编辑框里的草稿写回存档的间隔：和自动保存一样等停止输入，不必每敲一个字就写一次 localStorage */
const DRAFT_SAVE_MS = 400

/**
 * 格式自检的问题码 → 页面文案。写成逐条字面量而不是直接拿 shared 里的提示词文案，
 * 是因为界面文案要过 t() 才会进英文词典；提示词里那份是给 CLI 看的，不翻译
 */
function issueText(issue: SummaryFormatIssue) {
  switch (issue) {
    case 'title':
      return t('一级标题不是「# <日期> 工作总结」')
    case 'sections':
      return t('缺少固定的三个二级节，或顺序不对')
    case 'project':
      return t('项目标题的编号格式不对（应为「### 1.1 项目名」）')
    case 'item':
      return t('条目没有写成「1. **标题** ｜ 状态」加缩进一行的「实现 / 原因 / 修复」')
    case 'empty':
      return t('某一节没有内容时没写「暂无」')
  }
}

/** 已加入的一个项目：项目名 + 该项目今天有执行的对话 + 对话选择（下拉增加、可删） */
function ProjectPickRow({
  name,
  tasks,
  picked,
  disabled,
  onAddTask,
  onRemoveTask,
  onRemove,
}: {
  name: string
  /** 该项目今天有执行的对话；列表里只留标题，拿到的是任务摘要 */
  tasks: { id: string; title: string }[]
  /** 已加入要分析的对话 id */
  picked: string[]
  disabled: boolean
  onAddTask: (id: string) => void
  onRemoveTask: (id: string) => void
  onRemove: () => void
}) {
  // 下拉里不重复列出已经加过的对话；删掉一个后它回到下拉里
  const rest = tasks.filter((x) => !picked.includes(x.id))
  const [draft, setDraft] = useState('')
  useEffect(() => {
    if (!rest.some((x) => x.id === draft)) setDraft(rest[0]?.id ?? '')
  }, [rest, draft])
  const titleOf = (id: string) => tasks.find((x) => x.id === id)?.title ?? id
  return (
    <li className="px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="text-[0.8125rem] font-medium">{name}</span>
        {!!tasks.length && <span className="text-xs text-subtle">{t('今天 {n} 个对话', { n: tasks.length })}</span>}
        <button
          type="button"
          aria-label={t('删除项目 {name}', { name })}
          onClick={onRemove}
          disabled={disabled}
          className="ml-auto grid h-6 w-6 cursor-pointer place-items-center rounded text-subtle hover:bg-sel hover:text-fg disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-subtle"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {!tasks.length ? (
        <p className="mt-1 text-xs text-subtle">{t('今天没有可总结的对话')}</p>
      ) : (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Select
              aria-label={t('选择要分析的对话')}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="h-8 w-[260px]"
              options={rest.map((x) => ({ value: x.id, label: x.title }))}
              disabled={disabled || !rest.length}
            />
            <Button size="sm" variant="secondary" disabled={disabled || !draft} onClick={() => onAddTask(draft)}>
              <Plus className="h-3.5 w-3.5" />
              {t('增加')}
            </Button>
            <span className="text-xs text-subtle">
              {picked.length
                ? t('只分析已选的 {n} 个对话', { n: picked.length })
                : t('未选对话时分析该项目今天全部对话')}
            </span>
          </div>
          {!!picked.length && (
            <div className="mt-2 flex flex-wrap gap-1">
              {picked.map((id) => (
                <span
                  key={id}
                  className="flex items-center gap-1 rounded-lg bg-sel px-2 py-1 text-[0.75rem] text-muted"
                >
                  <span className="max-w-[240px] truncate">{titleOf(id)}</span>
                  <button
                    type="button"
                    aria-label={t('删除对话 {title}', { title: titleOf(id) })}
                    onClick={() => onRemoveTask(id)}
                    disabled={disabled}
                    className="grid h-4 w-4 cursor-pointer place-items-center rounded text-subtle hover:text-fg disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-subtle"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </>
      )}
    </li>
  )
}

/** 报告正文：预览 / 编辑切换，编辑后自动保存 */
function ReportEditor({
  id,
  md: initial,
  mode,
  onMode,
  onCopy,
  onSaved,
  onDraft,
}: {
  id: string
  md: string
  /** 预览 / 编辑由页面记着：切页面回来后还是走之前的那个 tab */
  mode: ReportMode
  onMode: (mode: ReportMode) => void
  onCopy: (md: string) => void
  /** 保存成功后把新正文交回去：列表里的快照跟着变，不然再点回这份报告会拿旧内容覆盖 */
  onSaved: (md: string) => void
  /** 还没保存的编辑也要记着：切页面回来不能变回保存前的正文 */
  onDraft: (md: string) => void
}) {
  const [md, setMd] = useState(initial)
  // 自动保存按报告 id 隔离：组件用 key 按 id 重挂，切走时补存的也是这份报告
  const { status } = useAutosave(
    md,
    async (v) => {
      const r = await api.saveSummary(id, v)
      onSaved(v)
      return r
    },
    !!id,
  )
  const statusText =
    status === 'pending' || status === 'saving'
      ? t('保存中…')
      : status === 'saved'
        ? t('已保存')
        : status === 'error'
          ? t('保存失败')
          : ''
  return (
    <section className="rounded-xl border bg-panel">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        <FileText className="h-4 w-4 text-accent" />
        <span className="text-[0.8125rem] font-medium">{t('今天的报告')}</span>
        <Segmented
          label={t('报告视图')}
          value={mode}
          onChange={onMode}
          options={[
            { id: 'preview', label: t('预览') },
            { id: 'edit', label: t('编辑') },
          ]}
        />
        <span className="text-xs text-subtle" aria-live="polite">
          {statusText}
        </span>
        <Button variant="secondary" size="sm" className="ml-auto" onClick={() => onCopy(md)}>
          <Copy className="h-3.5 w-3.5" />
          {t('复制')}
        </Button>
      </div>
      {mode === 'edit' ? (
        <Textarea
          aria-label={t('报告内容')}
          value={md}
          onChange={(e) => {
            setMd(e.target.value)
            onDraft(e.target.value)
          }}
          className="min-h-[420px] rounded-none border-0 bg-transparent px-4 py-3 font-mono text-[0.8125rem] leading-relaxed focus:ring-0"
        />
      ) : (
        <div className="px-4 py-3">
          <Markdown text={md} teamNames={NO_TEAM} />
        </div>
      )}
    </section>
  )
}

export function SummaryPage() {
  const { projects, clis, settings, tasks, loading, tasksLoaded } = useData()
  const { day } = todayWindow()
  // 切走再回来（甚至刷新）接着用上次的页面状态：先按今天校正口径，项目和任务加载完再剪掉已删的
  const [restored] = useState(() => {
    const s = loadSummaryPage()
    return s ? forDay(s, day) : null
  })
  const usable = useMemo(
    () =>
      orderClis(CLIS, settings?.cliOrder ?? []).filter((c) =>
        clis.some((s) => s.id === c.id && s.installed && s.enabled),
      ),
    [clis, settings],
  )
  const [cli, setCli] = useState(restored?.cli ?? '')
  /** 已加入的项目：顺序就是报告里分节的顺序 */
  const [picks, setPicks] = useState<Pick[]>(restored?.picks ?? [])
  /** 项目下拉当前选到哪个（点「增加」才真的加进去） */
  const [projectDraft, setProjectDraft] = useState('')
  const [job, setJob] = useState<SummaryJob | null>(null)
  /** 生成中 / 刚生成完的 job id：存到本机，刷新后还能接着看进度或结果 */
  const [jobId, setJobId] = useState(restored?.jobId ?? '')
  /** 当前打开的这份报告：id 用来保存，md 是它的内容 */
  const [current, setCurrent] = useState<{ id: string; md: string } | null>(restored?.report ?? null)
  const [mode, setMode] = useState<ReportMode>(restored?.mode ?? 'preview')
  const [reports, setReports] = useState<SummaryRecord[]>([])
  const [error, setError] = useState('')
  /** 轮询失败次数：连续几次才判失败，见 POLL_FAIL_MAX */
  const pollFails = useRef(0)
  const [pollTick, setPollTick] = useState(0)
  /** 存档里那份：几个 effect 各自只改自己负责的字段，报告正文可能是还没保存的草稿 */
  const saved = useRef<SummaryPageState>({
    day,
    picks: restored?.picks ?? [],
    report: restored?.report ?? null,
    mode: restored?.mode ?? 'preview',
    jobId: restored?.jobId ?? '',
    cli: restored?.cli ?? '',
  })
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 已经剪过一次已删的项目 / 对话：只在加载完的第一时间做，之后用户自己的删除不再提示 */
  const pruned = useRef(false)
  /** 存档里恢复出来的报告与 job：挂载时各只能校验一次，用稳定的引用免得 effect 重跑 */
  const restoredReport = restored?.report ?? null
  const restoredJob = restored?.jobId ?? ''
  /** 「新报告已生成」只提示一次：StrictMode 下 effect 会双调，别弹两遍 */
  const jobDoneNotified = useRef(false)

  // 默认用设置里的「AI 处理」CLI（Assist 用的那个），没设置就用列表里第一个能用的；
  // 存档里的 CLI 已经不可用（卸载 / 禁用了）时也回到默认的那个
  useEffect(() => {
    if (!usable.length || usable.some((c) => c.id === cli)) return
    const pref = settings?.assist.cli || (settings ? defaultCli(settings) : '')
    setCli(usable.find((c) => c.id === pref)?.id ?? usable[0].id)
  }, [cli, usable, settings])

  // 下拉只列还没加过的项目：同一个项目不需要加两次
  const projectOptions = useMemo(
    () => projects.filter((p) => !picks.some((x) => x.projectId === p.id)).map((p) => ({ value: p.id, label: p.name })),
    [projects, picks],
  )

  // 下拉默认选中第一个可加的项目；加完项目后自动移到下一个，接着加不用再点
  useEffect(() => {
    if (projectOptions.some((o) => o.value === projectDraft)) return
    setProjectDraft(projectOptions[0]?.value ?? '')
  }, [projectOptions, projectDraft])

  /** 该项目今天有执行的对话（和生成时服务端筛的是同一个判定） */
  const todayTasks = (projectId: string) =>
    tasks
      .filter((x) => x.projectId === projectId && activeOnDay(x, day))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
      .map((x) => ({ id: x.id, title: x.title || t('未命名对话') }))

  // 恢复出来的报告可能已经不在本机（被挤出最近 SUMMARY_KEEP 份、数据目录重置、演示版刷新）：
  // 留着它只会在自动保存时一直失败，也存不回来，所以收起并说明
  useEffect(() => {
    void api
      .summary()
      .then((r) => {
        setReports(r.reports)
        if (!restoredReport || r.reports.some((x) => x.id === restoredReport.id)) return
        setCurrent(null)
        toast.info(t('上次打开的报告已经不在本机，无法继续编辑'))
      })
      .catch((e) => setError((e as Error).message))
  }, [restoredReport])

  /** 编辑框里的草稿：先更新存档里的正文，停止输入后再写回本机 */
  const draft = (md: string) => {
    const report = saved.current.report
    if (!report) return
    saved.current = { ...saved.current, report: { id: report.id, md } }
    if (draftTimer.current) clearTimeout(draftTimer.current)
    draftTimer.current = setTimeout(() => {
      draftTimer.current = null
      saveSummaryPage(saved.current)
    }, DRAFT_SAVE_MS)
  }

  // 选择、tab、CLI、生成中的 job 变了就写回：切页面 / 刷新后按这份恢复。
  // 当前报告不在这里写：草稿已经比 current 新，写成 current 会把刚输入的内容退回去
  useEffect(() => {
    saved.current = { ...saved.current, picks, mode, jobId, cli }
    saveSummaryPage(saved.current)
  }, [picks, mode, jobId, cli])

  // 换成另一份报告（刚生成完、点开最近的一份）才写 report。
  // 同一份不再写：存档里的正文是编辑框的草稿，可能比 current.md 新（自动保存还没回写），
  // 在自动保存窗口内点开同一份不能把刚输入的内容退回去
  useEffect(() => {
    const stored = saved.current.report
    if (current && stored?.id === current.id) return
    saved.current = { ...saved.current, report: current }
    saveSummaryPage(saved.current)
  }, [current])

  // 切走、刷新（F5）、关标签页时把防抖还没写回的草稿补上：下一次进来靠它恢复。
  // React 的卸载清理在浏览器卸载页面时不会跑，所以还要听 pagehide
  useEffect(() => {
    const flush = () => {
      if (!draftTimer.current) return
      clearTimeout(draftTimer.current)
      draftTimer.current = null
      saveSummaryPage(saved.current)
    }
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      flush()
    }
  }, [])

  // 接回上次切走时还在跑的生成：在跑就接着轮询，已结束就按结果收尾，不让用户以为什么都没发生
  useEffect(() => {
    if (!restoredJob) return
    void api
      .summaryJob(restoredJob)
      .then((j) => {
        if (j.status !== 'done') {
          setJob(j)
          if (j.status === 'failed') setError(j.error ?? t('生成失败'))
          return
        }
        setJobId('')
        if (!j.reportId) return
        // 用户回来后可能已经自己点开了一份报告（包括恢复之后才点开的）：那份不能被顶掉。
        // 判据读最新的存档，不能只看挂载时恢复的那份
        const watching = saved.current.report
        if (watching && watching.id !== j.reportId) {
          if (!jobDoneNotified.current) {
            jobDoneNotified.current = true
            toast.info(t('新报告已经生成，可在「最近的报告」里找到'))
          }
          // 列表也刷新一下，否则提示指向的还是旧列表
          void api
            .summary()
            .then((r) => setReports(r.reports))
            .catch(() => {})
          return
        }
        // 生成完但切走时还没来得及打开：按服务端的最新正文打开这份报告
        void api
          .summary()
          .then((r) => {
            setReports(r.reports)
            const rec = r.reports.find((x) => x.id === j.reportId)
            if (rec) setCurrent({ id: rec.id, md: rec.md })
          })
          .catch(() => {})
      })
      .catch(() => {
        // 找不到这次生成（服务端重启、演示版刷新）：不能把「生成中」留在页面上
        setJobId('')
      })
  }, [restoredJob])

  // 项目和任务都加载完后剪掉已经不在的选择：加载中先按存档渲染，免得刚回来就闪一下。
  // 只在这一时间点做：之后用户自己删的那个不需要再提示
  useEffect(() => {
    if (loading || !tasksLoaded || pruned.current) return
    pruned.current = true
    const r = prunePicks(picks, projects, tasks)
    if (!r.removedProjects && !r.removedTasks) return
    setPicks(r.picks)
    // 不静默改用户的选择：说清楚哪几项已经没了
    if (r.removedProjects) toast.info(t('{n} 个项目已不存在，已从选择里移除', { n: r.removedProjects }))
    if (r.removedTasks) toast.info(t('{n} 个对话已不存在，已从选择里移除', { n: r.removedTasks }))
  }, [loading, tasksLoaded, picks, projects, tasks])

  // 生成中轮询：完成时切到新报告，失败时把 CLI 的报错显示出来
  useEffect(() => {
    if (job?.status !== 'running') return
    const timer = setTimeout(async () => {
      try {
        const next = await api.summaryJob(job.id)
        pollFails.current = 0
        setJob(next)
        if (next.status === 'done' && next.reportId) {
          setCurrent({ id: next.reportId, md: next.md })
          setError('')
          void api
            .summary()
            .then((r) => setReports(r.reports))
            .catch(() => {})
        } else if (next.status === 'failed') setError(next.error ?? t('生成失败'))
      } catch (e) {
        pollFails.current += 1
        if (pollFails.current >= POLL_FAIL_MAX) {
          setJob({ ...job, status: 'failed', error: (e as Error).message })
          setError((e as Error).message)
        } else {
          // 连接断了一下：服务端还在跑、跑完也会存报告，接着轮询
          setPollTick((n) => n + 1)
        }
      }
    }, POLL_MS)
    return () => clearTimeout(timer)
  }, [job, pollTick])

  const running = job?.status === 'running'
  const stopped = job?.status === 'stopped'
  const message = job?.status === 'failed' ? (job.error ?? error) : error
  const addProject = () => {
    if (!projectDraft || picks.some((x) => x.projectId === projectDraft)) return
    setPicks((prev) => [...prev, { projectId: projectDraft, taskIds: [] }])
  }
  const removeProject = (projectId: string) => setPicks((prev) => prev.filter((x) => x.projectId !== projectId))
  const addTask = (projectId: string, taskId: string) =>
    setPicks((prev) =>
      prev.map((x) =>
        x.projectId === projectId && !x.taskIds.includes(taskId) ? { ...x, taskIds: [...x.taskIds, taskId] } : x,
      ),
    )
  const removeTask = (projectId: string, taskId: string) =>
    setPicks((prev) =>
      prev.map((x) => (x.projectId === projectId ? { ...x, taskIds: x.taskIds.filter((id) => id !== taskId) } : x)),
    )

  const start = async () => {
    if (!picks.length || !cli) return
    setError('')
    // 新的一次从清零开始：上一次连续失败的次数不能带到这一次的第一次轮询
    pollFails.current = 0
    // 上一次的 job 先从存档里清掉：这次请求失败时，刷新后不该再去接着看旧的那次
    setJobId('')
    try {
      const next = await api.generateSummary({
        projects: picks.map((x) => ({ projectId: x.projectId, taskIds: x.taskIds })),
        cli,
        model: '',
        effort: '',
      })
      setJob(next)
      setJobId(next.id)
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

  const copy = (md: string) => {
    void navigator.clipboard.writeText(md).then(
      () => toast.success(t('已复制报告')),
      () => toast.error(t('复制失败')),
    )
  }

  const lastThought = job?.thinking?.trim().split('\n').filter(Boolean).at(-1)

  return (
    <PageFrame
      title={t('工作总结')}
      intro={t(
        '选一个项目点「增加」，再在该项目下挑要分析的对话（不挑就是今天全部），把今天（{day}）的工作整理成一份 Markdown 报告。生成后可以编辑、预览、一键复制；最近的报告留在本机，点开还能接着改。',
        { day },
      )}
    >
      <section className="rounded-xl border bg-panel">
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
          <span className="text-[0.8125rem] font-medium">{t('项目')}</span>
          <Select
            aria-label={t('选择要总结的项目')}
            value={projectDraft}
            onChange={(e) => setProjectDraft(e.target.value)}
            className="h-8 w-[200px]"
            placeholder={t('选择项目')}
            options={projectOptions}
            disabled={running || !projectOptions.length}
          />
          <Button size="sm" variant="secondary" disabled={running || !projectDraft} onClick={addProject}>
            <Plus className="h-3.5 w-3.5" />
            {t('增加')}
          </Button>
          <span className="text-xs text-subtle">{t('已选 {n} 个', { n: picks.length })}</span>
          <div className="ml-auto flex items-center gap-2">
            {usable.length ? (
              <Select
                aria-label={t('用哪个 Agent 生成')}
                value={cli}
                onChange={(e) => setCli(e.target.value)}
                className="h-8 w-[150px]"
                options={usable.map((c) => ({ value: c.id, label: c.name }))}
              />
            ) : (
              <span className="text-xs text-warning">{t('没有可用的 Agent，请先在设置里安装并启用')}</span>
            )}
            {running ? (
              <Button size="sm" variant="secondary" onClick={stop}>
                <Square className="h-3.5 w-3.5" />
                {t('停止')}
              </Button>
            ) : (
              <Button size="sm" disabled={!picks.length || !cli} onClick={start}>
                <Sparkles className="h-3.5 w-3.5" />
                {job?.status === 'failed' ? t('重试') : t('生成报告')}
              </Button>
            )}
          </div>
        </div>
        {loading ? (
          <p className="px-4 py-3 text-xs text-subtle">{t('正在加载…')}</p>
        ) : !projects.length ? (
          <p className="px-4 py-3 text-xs text-subtle">{t('还没有项目，先在侧栏添加一个项目。')}</p>
        ) : !picks.length ? (
          <p className="px-4 py-3 text-xs text-subtle">{t('还没有加入项目。选一个项目后点「增加」。')}</p>
        ) : (
          <ul className="divide-y divide-line">
            {picks.map((pick) => {
              const project = projects.find((p) => p.id === pick.projectId)
              if (!project) return null
              return (
                <ProjectPickRow
                  key={pick.projectId}
                  name={project.name}
                  tasks={todayTasks(pick.projectId)}
                  picked={pick.taskIds}
                  disabled={running}
                  onAddTask={(id) => addTask(pick.projectId, id)}
                  onRemoveTask={(id) => removeTask(pick.projectId, id)}
                  onRemove={() => removeProject(pick.projectId)}
                />
              )
            })}
          </ul>
        )}
      </section>

      {running && job && (
        <div className="flex items-center gap-2 rounded-xl border bg-accent-soft/40 px-4 py-3 text-xs text-muted">
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" />
          <span className="min-w-0 flex-1 truncate">
            {lastThought
              ? t('正在思考：{text}', { text: lastThought })
              : job.tools.length
                ? t('正在查看：{files}', { files: job.tools.join('、') })
                : t('正在分析今天执行过的对话…')}
          </span>
          {job.outChars > 0 && <span className="shrink-0">{t('已写 {n} 字', { n: job.outChars })}</span>}
        </div>
      )}

      {!!message && (
        <p className="flex gap-1.5 rounded-xl border border-danger/40 bg-danger/5 px-4 py-3 text-xs whitespace-pre-wrap text-danger">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {message}
        </p>
      )}

      {stopped && <p className="rounded-xl border bg-panel px-4 py-3 text-xs text-subtle">{t('已停止生成')}</p>}

      {/* 用户选了、但今天没有可写进报告的对话：报告里没它，得说清楚是哪几个。只看完成状态，中途失败/停止时整份报告都没生成 */}
      {job?.status === 'done' && !!job.skipped?.length && (
        <p className="flex gap-1.5 rounded-xl border border-warning/40 bg-warning/5 px-4 py-3 text-xs text-warning">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {t('这些项目没有可写进报告的对话，已跳过：{names}', { names: job.skipped.join('、') })}
        </p>
      )}

      {/* 格式自检不通过：重试过一次仍然不完整，页面要明确告知，不能静默当作正常报告 */}
      {job?.format && !job.format.ok && (
        <p className="flex gap-1.5 rounded-xl border border-warning/40 bg-warning/5 px-4 py-3 text-xs text-warning">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {t('报告格式不完整（已自动重试一次）：{issues}', {
            issues: job.format.issues.map(issueText).join('；'),
          })}
        </p>
      )}

      {/* 失败 / 停止时已经写出来的正文：没有存进去，但至少能看、能复制，不用重新跑一遍 */}
      {job && job.status !== 'done' && !!job.md.trim() && (
        <section className="rounded-xl border bg-panel">
          <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
            <FileText className="h-4 w-4 text-accent" />
            <span className="text-[0.8125rem] font-medium">{t('生成中断，这是已经写出的部分')}</span>
            <Button variant="secondary" size="sm" className="ml-auto" onClick={() => copy(job.md)}>
              <Copy className="h-3.5 w-3.5" />
              {t('复制')}
            </Button>
          </div>
          <div className="px-4 py-3">
            <Markdown text={job.md} teamNames={NO_TEAM} />
          </div>
        </section>
      )}

      {current && (
        <ReportEditor
          key={current.id}
          id={current.id}
          md={current.md}
          mode={mode}
          onMode={setMode}
          onCopy={copy}
          onSaved={(md) => setReports((prev) => prev.map((r) => (r.id === current.id ? { ...r, md } : r)))}
          onDraft={draft}
        />
      )}

      {reports.length > 0 && (
        <section className="rounded-xl border bg-panel">
          <div className="border-b px-4 py-2 text-[0.8125rem] font-medium">{t('最近的报告')}</div>
          <ul className="divide-y divide-line">
            {reports.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => {
                    setError('')
                    setCurrent({ id: r.id, md: r.md })
                  }}
                  className={cn(
                    'flex w-full cursor-pointer items-center gap-3 px-4 py-2 text-left hover:bg-sel',
                    current?.id === r.id && 'bg-accent-soft',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate text-[0.8125rem]">
                    {r.projectNames.join('、') || reportTitle(r.md, r.day)}
                  </span>
                  <span className="shrink-0 text-xs text-subtle">{r.day}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </PageFrame>
  )
}
