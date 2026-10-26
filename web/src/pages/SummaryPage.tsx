/**
 * 工作总结：选几个项目，把「今天」执行过的对话交给本机 CLI，生成一份简短的 Markdown 报告。
 * 报告能编辑（自动保存）、预览、一键复制；最近几份存在数据目录里（见 server/summary.ts），点开能回看。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from '@/lib/toast'
import { AlertTriangle, Copy, FileText, Loader2, Sparkles, Square } from 'lucide-react'
import { CLIS } from '@shared/clis'
import { defaultCli, orderClis } from '@shared/settings'
import { reportTitle, todayWindow, type SummaryJob, type SummaryRecord } from '@shared/summary'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { useAutosave } from '@/lib/useAutosave'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Select, Textarea } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
import { Markdown } from '@/components/tasks/Markdown'
import { PageFrame } from '@/components/library/parts'

const NO_TEAM = new Set<string>()
/** 生成中的轮询间隔：CLI 一轮要跑十几秒，再密也没用 */
const POLL_MS = 700

/** 报告正文：预览 / 编辑切换，编辑后自动保存 */
function ReportEditor({ id, md: initial, onCopy }: { id: string; md: string; onCopy: (md: string) => void }) {
  const [md, setMd] = useState(initial)
  const [mode, setMode] = useState<'preview' | 'edit'>('preview')
  // 自动保存按报告 id 隔离：组件用 key 按 id 重挂，切走时补存的也是这份报告
  const { status } = useAutosave(md, (v) => api.saveSummary(id, v), !!id)
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
          onChange={setMode}
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
          onChange={(e) => setMd(e.target.value)}
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
  const { projects, clis, settings } = useData()
  const { day } = todayWindow()
  const usable = useMemo(
    () =>
      orderClis(CLIS, settings?.cliOrder ?? []).filter((c) =>
        clis.some((s) => s.id === c.id && s.installed && s.enabled),
      ),
    [clis, settings],
  )
  const [cli, setCli] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [job, setJob] = useState<SummaryJob | null>(null)
  /** 当前打开的这份报告：id 用来保存，md 是它的内容 */
  const [current, setCurrent] = useState<{ id: string; md: string } | null>(null)
  const [reports, setReports] = useState<SummaryRecord[]>([])
  const [error, setError] = useState('')

  // 默认用设置里的「AI 处理」CLI（Assist 用的那个），没设置就用列表里第一个能用的
  useEffect(() => {
    if (cli || !usable.length) return
    const pref = settings?.assist.cli || (settings ? defaultCli(settings) : '')
    setCli(usable.find((c) => c.id === pref)?.id ?? usable[0].id)
  }, [cli, usable, settings])

  // 默认选中第一个项目：报告一次分析几个项目，先给一个最省的起点
  const picked = useRef(false)
  useEffect(() => {
    if (picked.current || !projects.length) return
    picked.current = true
    setSelected([projects[0].id])
  }, [projects])

  useEffect(() => {
    void api
      .summary()
      .then((r) => setReports(r.reports))
      .catch((e) => setError((e as Error).message))
  }, [])

  // 生成中轮询：完成时切到新报告，失败时把 CLI 的报错显示出来
  useEffect(() => {
    if (job?.status !== 'running') return
    const timer = setTimeout(async () => {
      try {
        const next = await api.summaryJob(job.id)
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
        setJob({ ...job, status: 'failed', error: (e as Error).message })
        setError((e as Error).message)
      }
    }, POLL_MS)
    return () => clearTimeout(timer)
  }, [job])

  const running = job?.status === 'running'
  const message = job?.status === 'failed' ? (job.error ?? error) : error
  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => (on ? (prev.includes(id) ? prev : [...prev, id]) : prev.filter((x) => x !== id)))

  const start = async () => {
    if (!selected.length || !cli) return
    setError('')
    try {
      setJob(await api.generateSummary({ projectIds: selected, cli, model: '', effort: '' }))
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
        '选几个项目，把今天（{day}）执行过的对话整理成一份简短的 Markdown 报告。生成后可以编辑、预览、一键复制；最近的报告留在本机，点开还能接着改。',
        { day },
      )}
    >
      <section className="rounded-xl border bg-panel">
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
          <span className="text-[0.8125rem] font-medium">{t('项目')}</span>
          <span className="text-xs text-subtle">{t('已选 {n} 个', { n: selected.length })}</span>
          <button
            type="button"
            className="cursor-pointer text-xs text-muted hover:text-fg"
            onClick={() => setSelected(projects.map((p) => p.id))}
          >
            {t('全选')}
          </button>
          <button
            type="button"
            className="cursor-pointer text-xs text-muted hover:text-fg"
            onClick={() => setSelected([])}
          >
            {t('清空')}
          </button>
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
              <Button size="sm" disabled={!selected.length || !cli} onClick={start}>
                <Sparkles className="h-3.5 w-3.5" />
                {job?.status === 'failed' ? t('重试') : t('生成报告')}
              </Button>
            )}
          </div>
        </div>
        {projects.length ? (
          <div className="grid gap-2 px-4 py-3 md:grid-cols-2">
            {projects.map((p) => (
              <Checkbox
                key={p.id}
                checked={selected.includes(p.id)}
                onChange={(on) => toggle(p.id, on)}
                label={p.name}
              />
            ))}
          </div>
        ) : (
          <p className="px-4 py-3 text-xs text-subtle">{t('还没有项目，先在侧栏添加一个项目。')}</p>
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

      {current && <ReportEditor key={current.id} id={current.id} md={current.md} onCopy={copy} />}

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
