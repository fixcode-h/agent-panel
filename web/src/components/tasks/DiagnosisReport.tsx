import { useState, type ReactNode } from 'react'
import { CircleAlert, GraduationCap, Loader2, SquarePlus, Terminal } from 'lucide-react'
import type { Project, Task } from '@shared/schema'
import { t } from '@shared/i18n'
import { taskSummary } from '@shared/task'
import {
  diagnosisFixPrompt,
  diagnosisLessonText,
  type Diagnosis,
  type DiagnosisConfidence,
  type DiagnosisEvidence,
  type DiagnosisFix,
  type DiagnosisParse,
  type DiagnosisSeverity,
} from '@shared/diagnosis'
import { api } from '@/lib/api'
import { aiWindowState, analysisRoute, hideAiWindow } from '@/lib/ai-window'
import { fixHead, fixState } from '@/lib/analysis-report'
import { useData, useNav, type Route } from '@/lib/data'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { DIFF_TONE } from '@/components/ui/diff-tone'
import { RecordLessonDialog } from '@/components/projects/Lessons'
import { useFileOpen } from './FileDialog'

/**
 * 排查类分析的结构化结论（shared/diagnosis.ts），画在 AI 分析对话右侧的功能面板里：
 * 页签「结论 / 证据 / 修复 / 相关文件」由 AnalysisPanel 画，这里按选中的页签画内容。
 * 结论页的三个按钮：把修复建议发回被分析的那个对话、在同一个项目里开新任务修、记成项目教训
 */
export type DiagnosisTab = 'sum' | 'evi' | 'fix' | 'files'

export const diagnosisTabs = (d: Diagnosis): { id: DiagnosisTab; label: string; count?: number }[] => [
  { id: 'sum', label: t('结论') },
  { id: 'evi', label: t('证据'), count: d.evidence.length },
  { id: 'fix', label: t('修复'), count: d.fixes.length },
  { id: 'files', label: t('相关文件'), count: d.files.length },
]

const CONFIDENCE: Record<DiagnosisConfidence, { label: () => string; width: string; bar: string; text: string }> = {
  high: { label: () => t('高'), width: '86%', bar: 'bg-success', text: 'text-success' },
  medium: { label: () => t('中'), width: '55%', bar: 'bg-warning', text: 'text-warning' },
  low: { label: () => t('低'), width: '25%', bar: 'bg-danger', text: 'text-danger' },
}

const SEVERITY: Record<DiagnosisSeverity, string> = {
  high: 'bg-danger',
  medium: 'bg-warning',
  low: 'bg-subtle/60',
  none: 'bg-line-strong',
}

const at = (file: string, line?: number) => (line ? `${file}:${line}` : file)

/**
 * 卡片：照设计稿 AiWindow 是白底 + 1px 细线、圆角 12、不加阴影。
 * 功能面板的底色和卡片只差一点，光靠底色分不出边界，所以这里用描边而不是执行分析报告那种阴影
 */
const CARD = 'rounded-xl border bg-card'

function Card({ label, children, className }: { label?: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn('flex flex-col gap-2 p-3.5', CARD, className)}>
      {label && <span className="text-[0.6875rem] font-semibold tracking-[0.06em] text-subtle">{label}</span>}
      {children}
    </section>
  )
}

/** 文件路径：点开在文件窗口里定位到那一行（对话页的 FileDialog）；不在对话页里时只显示 */
function FileLink({ file, line, className }: { file: string; line?: number; className?: string }) {
  const open = useFileOpen()
  const label = at(file, line)
  if (!open) return <span className={cn('truncate font-mono text-[0.75rem]', className)}>{label}</span>
  return (
    <button
      type="button"
      title={t('打开 {path}', { path: label })}
      onClick={() => open(file, line)}
      className={cn(
        'min-w-0 cursor-pointer truncate text-left font-mono text-[0.75rem] hover:text-accent-text hover:underline',
        className,
      )}
    >
      {label}
    </button>
  )
}

/** 结构化结论读不出来：不静默吞掉，写明原因并把原文摆出来 */
export function DiagnosisError({ parse }: { parse: Extract<DiagnosisParse, { ok: false }> }) {
  return (
    <div className="flex flex-col gap-3 p-4">
      <p className="flex items-start gap-2 text-[0.8125rem] leading-relaxed text-danger">
        <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{t('结论块的格式不对，没能画成结论：{error}', { error: parse.error.split('\n')[0] ?? '' })}</span>
      </p>
      <p className="text-[0.75rem] text-subtle">{t('下面是原文，可以在对话里让它重新输出')}</p>
      <pre className="max-h-[60vh] overflow-auto rounded-lg bg-field px-3 py-2 font-mono text-[0.75rem] leading-[1.6] whitespace-pre-wrap">
        {parse.raw}
      </pre>
    </div>
  )
}

export function DiagnosisReport({
  task,
  project,
  diagnosis: d,
  tab,
  onTask,
}: {
  task: Task
  project?: Project
  diagnosis: Diagnosis
  tab: DiagnosisTab
  onTask: (task: Task) => void
}) {
  const { go } = useNav()
  const { upsertTask } = useData()
  const [busy, setBusy] = useState<'' | 'here' | 'new'>('')
  const [sentTo, setSentTo] = useState('')
  const [lesson, setLesson] = useState(false)
  // 被分析的那个对话：记在 analysisOf 上；和对话无关的排查（设置页、CLI 的报错）就在这个分析对话里修
  const target = task.analysisOf && task.analysisOf !== task.id ? task.analysisOf : ''
  const selfState = target ? 'todo' : fixState(task, d.rootCause.title)
  // 去别的对话：窗口里嵌着时先把窗口收起来，不然跳过去了还被窗口盖着
  const leave = (r: Route) => {
    if (aiWindowState().taskId === task.id) hideAiWindow()
    go(r)
  }

  const fixHere = async () => {
    if (busy) return
    setBusy('here')
    try {
      if (!target) {
        onTask(await api.sendMessage(task.id, `${fixHead(d.rootCause.title)}\n\n${diagnosisFixPrompt(d)}`))
        return
      }
      const tk = await api.sendMessage(target, diagnosisFixPrompt(d))
      setSentTo(tk.title)
      const r = analysisRoute({ taskId: tk.id, projectId: tk.projectId || undefined, parentTaskId: tk.parentTaskId })
      toast.success(t('修复建议已发到「{title}」', { title: tk.title }), {
        action: r ? { label: t('查看'), onClick: () => leave(r) } : undefined,
      })
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  const fixInNew = async () => {
    if (busy) return
    setBusy('new')
    try {
      const created = await api.createTask({
        projectId: task.projectId,
        mode: 'chat',
        workflowId: '',
        // 和新建对话一样用项目默认的对话角色；Chat 里的排查没有项目，就不用角色
        agentId: project?.defaultAgentId ?? '',
        cli: '',
        model: '',
        effort: '',
        params: {},
        prompt: diagnosisFixPrompt(d),
        attachments: [],
        isolate: false,
        askUser: false,
      })
      upsertTask(taskSummary(created))
      leave(
        created.projectId
          ? { page: 'projects', id: created.projectId, sub: created.id }
          : { page: 'chat', id: created.id },
      )
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  const fixButton = (
    <Button
      className="h-[2.375rem] w-full justify-center rounded-[0.5625rem] font-semibold"
      disabled={!!busy || selfState === 'working'}
      title={target ? t('把修复建议作为一条消息发回被分析的那个对话') : t('在这个分析对话里按修复建议动手改')}
      onClick={() => void fixHere()}
    >
      {(busy === 'here' || selfState === 'working') && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      {t('在当前对话里修')}
    </Button>
  )

  if (tab === 'evi')
    return (
      <div className="flex flex-col gap-2.5 p-[1.125rem]">
        {d.evidence.length ? (
          d.evidence.map((e, i) => <EvidenceCard key={i} e={e} />)
        ) : (
          <Empty text={t('没有列出证据')} />
        )}
      </div>
    )
  if (tab === 'fix')
    return (
      <div className="flex flex-col gap-2.5 p-[1.125rem]">
        {d.fixes.length ? d.fixes.map((f, i) => <FixCard key={i} f={f} />) : <Empty text={t('没有给出修复建议')} />}
        {d.fixes.length > 0 && fixButton}
      </div>
    )
  if (tab === 'files')
    return (
      <ul className="flex flex-col gap-1 p-[1.125rem]">
        {d.files.length ? (
          d.files.map((f) => (
            <li key={f}>
              <FileRow file={f} />
            </li>
          ))
        ) : (
          <Empty text={t('没有列出相关文件')} />
        )}
      </ul>
    )

  const conf = d.confidence && CONFIDENCE[d.confidence]
  return (
    <div className="flex flex-col gap-3.5 p-[1.125rem]">
      <Card label={t('根因')}>
        <span className="text-[0.875rem] leading-normal font-semibold">{d.rootCause.title}</span>
        {d.rootCause.detail && <p className="text-[0.8125rem] leading-relaxed text-muted">{d.rootCause.detail}</p>}
        {conf && (
          <div className="mt-0.5 flex items-center gap-2.5 text-[0.75rem] text-subtle">
            <span>{t('把握')}</span>
            <span
              role="meter"
              aria-label={t('把握')}
              aria-valuetext={conf.label()}
              className="h-1.5 flex-1 overflow-hidden rounded-full bg-sel"
            >
              <span className={cn('block h-full rounded-full', conf.bar)} style={{ width: conf.width }} />
            </span>
            <span className={cn('font-semibold', conf.text)}>{conf.label()}</span>
          </div>
        )}
      </Card>
      {d.impacts.length > 0 && (
        <Card label={t('影响')}>
          <ul className="flex flex-col gap-2">
            {d.impacts.map((x, i) => (
              <li key={i} className="flex items-start gap-2 text-[0.8125rem] leading-relaxed">
                <span className={cn('mt-[0.5rem] h-1.5 w-1.5 shrink-0 rounded-full', SEVERITY[x.severity])} />
                {x.text}
              </li>
            ))}
          </ul>
        </Card>
      )}
      <div className="flex flex-col gap-2">
        {fixButton}
        {(sentTo || selfState === 'done') && (
          <p className="truncate text-center text-[0.75rem] text-subtle">
            {sentTo ? t('已发到「{title}」', { title: sentTo }) : t('已在这个对话里修过')}
          </p>
        )}
        <div className="flex gap-2">
          <Button
            variant="secondary"
            className={SECONDARY}
            disabled={!!busy}
            title={t('在同一个项目里新建一个对话，带上修复建议')}
            onClick={() => void fixInNew()}
          >
            {busy === 'new' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <SquarePlus className="h-3.5 w-3.5" />}
            {t('开新任务修')}
          </Button>
          <Button
            variant="secondary"
            className={SECONDARY}
            disabled={!project}
            title={project ? t('把根因和修复要点记成项目教训') : t('只有项目里的分析能记成项目教训')}
            onClick={() => setLesson(true)}
          >
            <GraduationCap className="h-3.5 w-3.5" />
            {t('记成教训')}
          </Button>
        </div>
      </div>
      {lesson && project && (
        <RecordLessonDialog
          project={project}
          text={diagnosisLessonText(d)}
          taskId={target || task.id}
          taskTitle={task.title}
          onClose={() => setLesson(false)}
        />
      )}
    </div>
  )
}

/** 结论页的两个次要按钮：照设计稿是白底 + 深一档的描边、高 34，和上面实心的主按钮分出主次 */
const SECONDARY =
  'h-[2.125rem] flex-1 justify-center rounded-[0.5625rem] border border-line-strong bg-card hover:bg-sel'

/** 相关文件的一行：整行可点（设计稿是一行一个文件、右端写着点了会怎样），不在对话页里时只显示路径 */
function FileRow({ file }: { file: string }) {
  const open = useFileOpen()
  const row = 'flex h-9 w-full min-w-0 items-center gap-2 rounded-lg px-2.5'
  if (!open)
    return (
      <div className={row}>
        <span className="min-w-0 flex-1 truncate font-mono text-[0.75rem]">{file}</span>
      </div>
    )
  return (
    <button
      type="button"
      title={t('打开 {path}', { path: file })}
      onClick={() => open(file)}
      className={cn(row, 'group/file cursor-pointer text-left transition-colors hover:bg-sel')}
    >
      <span className="min-w-0 flex-1 truncate font-mono text-[0.75rem]">{file}</span>
      <span className="shrink-0 text-[0.6875rem] text-subtle group-hover/file:text-fg">{t('打开')}</span>
    </button>
  )
}

function Empty({ text }: { text: string }) {
  return <p className="px-1 py-6 text-center text-[0.8125rem] text-subtle">{text}</p>
}

function EvidenceCard({ e }: { e: DiagnosisEvidence }) {
  return (
    <section className={cn('flex flex-col overflow-hidden', CARD)}>
      {/* 设计稿：路径一行，下面一道细线隔开摘录；只有路径没有摘录和说明时就不画这道线 */}
      {(e.file || e.command) && (
        <header className={cn('flex min-w-0 items-center gap-2 px-3 py-2', (e.excerpt || e.note) && 'border-b')}>
          {e.file ? (
            <FileLink file={e.file} line={e.line} className="flex-1" />
          ) : (
            <span className="flex min-w-0 flex-1 items-center gap-1.5 font-mono text-[0.75rem] text-muted">
              <Terminal className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{e.command}</span>
            </span>
          )}
        </header>
      )}
      {e.excerpt && (
        <pre className="max-h-48 overflow-auto bg-panel px-3 py-2 font-mono text-[0.75rem] leading-[1.7] whitespace-pre">
          {e.excerpt}
        </pre>
      )}
      {e.note && <p className="px-3 py-2 text-[0.75rem] leading-relaxed text-muted">{e.note}</p>}
    </section>
  )
}

function FixCard({ f }: { f: DiagnosisFix }) {
  const rows = [
    ...(f.before ? f.before.split('\n').map((x) => ['del', x] as const) : []),
    ...(f.after ? f.after.split('\n').map((x) => ['add', x] as const) : []),
  ]
  const adds = rows.filter(([k]) => k === 'add').length
  const dels = rows.length - adds
  return (
    <section className={cn('flex flex-col overflow-hidden', CARD)}>
      {/* 设计稿：文件路径 + 改动行数（+n / −n），下面一道细线隔开改法和差异 */}
      <header className="flex min-w-0 items-center gap-2 border-b px-3 py-2">
        {f.file ? (
          <FileLink file={f.file} line={f.line} className="flex-1" />
        ) : (
          <span className="flex-1 text-[0.75rem] text-subtle">{t('不针对具体文件')}</span>
        )}
        {adds > 0 && <span className="shrink-0 font-mono text-[0.6875rem] text-success">+{adds}</span>}
        {dels > 0 && <span className="shrink-0 font-mono text-[0.6875rem] text-danger">−{dels}</span>}
      </header>
      <p className="px-3 py-2.5 text-[0.8125rem] leading-relaxed">{f.change}</p>
      {rows.length > 0 && (
        <div className="overflow-x-auto font-mono text-[0.75rem] leading-5 whitespace-pre">
          {rows.map(([k, x], i) => (
            // 设计稿里删掉、加上的行连字一起染色，不只是行首的 -/+
            <div key={i} className={cn('px-3', DIFF_TONE[k].row, DIFF_TONE[k].sign)}>
              <span className={cn('mr-2 select-none', DIFF_TONE[k].sign)}>{k === 'add' ? '+' : '-'}</span>
              {x}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
