import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  Bot,
  Box,
  Check,
  ChevronRight,
  Copy,
  FileCode2,
  Loader2,
  Sparkles,
  TriangleAlert,
  Workflow,
} from 'lucide-react'
import type { Task } from '@shared/schema'
import { t } from '@shared/i18n'
import { taskSummary } from '@shared/task'
import {
  EVOLUTION_LANG,
  applyChanges,
  lineDiff,
  parseEvolution,
  resolveChange,
  type ResolvedChange,
} from '@shared/task-export'
import { api } from '@/lib/api'
import { useData, useNav } from '@/lib/data'
import { startAnalysis } from '@/lib/task-transfer'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Modal } from '@/components/ui/modal'

/** 一条建议改前改后的对比：按行标出删掉和加上的 */
function DiffView({ before, after }: { before: string; after: string }) {
  const rows = useMemo(() => lineDiff(before, after), [before, after])
  return (
    <pre className="max-h-80 overflow-auto rounded-lg border bg-field py-1.5 font-mono text-[0.75rem] leading-[1.6]">
      {rows.map((r, i) => (
        <div
          key={i}
          className={cn(
            'px-3 whitespace-pre-wrap break-words',
            r.kind === 'add' && 'bg-success/12 text-success',
            r.kind === 'del' && 'bg-danger/10 text-danger line-through decoration-danger/40',
          )}
        >
          <span className="mr-2 inline-block w-3 text-subtle select-none">
            {r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : ' '}
          </span>
          {r.text || ' '}
        </div>
      ))}
    </pre>
  )
}

/** 建议改的是哪类对象：工作流、节点还是角色 */
const TARGET = { workflow: Workflow, node: Box, agent: Bot } as const
const targetName = (k: keyof typeof TARGET) => ({ workflow: t('工作流'), node: t('节点'), agent: t('角色') })[k]

function ChangeRow({ r, checked, onCheck }: { r: ResolvedChange; checked: boolean; onCheck: (v: boolean) => void }) {
  const [open, setOpen] = useState(false)
  const same = r.before === r.after
  const Icon = TARGET[r.change.target]
  return (
    <li className="flex flex-col gap-2.5 px-4 py-3">
      <div className="flex items-start gap-2">
        <Checkbox
          checked={checked && !same && !r.error}
          disabled={same || !!r.error}
          onChange={onCheck}
          label={
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-medium">{r.field}</span>
              <span className="inline-flex min-w-0 items-center gap-1 text-xs text-subtle">
                <Icon className="h-3 w-3 shrink-0" aria-label={targetName(r.change.target)} />
                <span className="truncate">{r.scope}</span>
              </span>
            </span>
          }
          hint={r.change.reason ? <span className="text-muted">{r.change.reason}</span> : undefined}
          className="min-w-0 flex-1"
        />
        {same ? (
          <Badge tone="success" className="shrink-0">
            <Check className="h-3 w-3" />
            {t('已应用')}
          </Badge>
        ) : r.error ? (
          <Badge tone="warning" className="max-w-[45%] shrink-0" title={r.error}>
            <TriangleAlert className="h-3 w-3 shrink-0" />
            <span className="truncate">{r.error}</span>
          </Badge>
        ) : (
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            className="flex shrink-0 cursor-pointer items-center gap-0.5 rounded-md px-1.5 py-0.5 text-xs text-muted hover:bg-sel hover:text-fg"
          >
            {t('看差异')}
            <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-90')} />
          </button>
        )}
      </div>
      {open && !same && (
        <div className="pl-[28px]">
          <DiffView before={r.before} after={r.after} />
        </div>
      )}
    </li>
  )
}

/** 结果卡片里每一段的小标题 */
function SectionHead({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof Sparkles
  title: string
  children?: React.ReactNode
}) {
  return (
    <h4 className="flex items-center gap-1.5 px-4 pt-3 pb-1 text-xs font-medium text-subtle">
      <Icon className="h-3.5 w-3.5" />
      <span className="flex-1">{title}</span>
      {children}
    </h4>
  )
}

/**
 * 「AI 分析」对话的结果下面：Agent 给的修改建议画成可以审阅的差异，勾选后才应用到工作流和 Agent，
 * 不会自动改；面板框架本身的问题列成发现，带文件位置，可以复制出去
 */
export function EvolutionCard({ task }: { task: Task }) {
  const { workflows, agents, setWorkflows, setAgents } = useData()
  const hit = useMemo(
    () =>
      // 分析对话回复完 CLI 往往还连着等下一句：不在处理这一轮就画出来，不等进程结束
      task.mode === 'chat' && !(task.status === 'running' && task.working)
        ? [...task.messages].reverse().find((m) => m.role === 'agent' && m.text.includes('```' + EVOLUTION_LANG))
        : undefined,
    [task],
  )
  const evo = useMemo(() => (hit ? parseEvolution(hit.text) : null), [hit])
  const rows = useMemo(
    () => evo?.changes.map((c) => resolveChange(c, workflows, agents)) ?? [],
    [evo, workflows, agents],
  )
  // 默认全选能应用的；取消勾选的记下来
  const [off, setOff] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)
  if (!evo || (!evo.changes.length && !evo.framework.length)) return null

  const picked = rows.map((r, i) => ({ r, i })).filter(({ r, i }) => !off.has(i) && !r.error && r.before !== r.after)
  const apply = async () => {
    setBusy(true)
    try {
      const next = applyChanges(
        picked.map((p) => p.r.change),
        workflows,
        agents,
      )
      for (const w of next.workflows) {
        const { id, createdAt: _c, updatedAt: _u, ...input } = w
        const saved = await api.updateWorkflow(id, input)
        setWorkflows((ws) => ws.map((x) => (x.id === id ? saved : x)))
      }
      for (const a of next.agents) {
        const { id, createdAt: _c, updatedAt: _u, ...input } = a
        const saved = await api.updateAgent(id, input)
        setAgents((as) => as.map((x) => (x.id === id ? saved : x)))
      }
      toast.success(t('已应用 {n} 项修改', { n: picked.length }))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const copyFindings = () => {
    const md = evo.framework
      .map((f) => `## ${f.title}\n${f.detail}${f.files.length ? `\n\n${f.files.map((x) => `- ${x}`).join('\n')}` : ''}`)
      .join('\n\n')
    void navigator.clipboard.writeText(md).then(
      () => toast.success(t('已复制')),
      () => toast.error(t('复制失败')),
    )
  }

  return (
    <section
      aria-label={t('分析结果')}
      className="overflow-hidden rounded-xl border border-line-strong bg-card shadow-card"
    >
      <header className="flex items-start gap-3 px-4 py-3.5">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
          <Sparkles className="h-4 w-4" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="text-[0.875rem] font-semibold">{t('分析结果')}</h3>
            {evo.changes.length > 0 && <Badge tone="accent">{t('{n} 项修改建议', { n: evo.changes.length })}</Badge>}
            {evo.framework.length > 0 && (
              <Badge tone="warning">{t('{n} 个框架问题', { n: evo.framework.length })}</Badge>
            )}
          </div>
          {evo.summary && <p className="text-[0.8125rem] leading-relaxed text-muted">{evo.summary}</p>}
        </div>
      </header>
      {evo.changes.length > 0 && (
        <div className="border-t">
          <SectionHead icon={Workflow} title={t('工作流优化建议')} />
          <ul className="flex flex-col divide-y">
            {rows.map((r, i) => (
              <ChangeRow
                key={i}
                r={r}
                checked={!off.has(i)}
                onCheck={(v) =>
                  setOff((s) => {
                    const n = new Set(s)
                    if (v) n.delete(i)
                    else n.add(i)
                    return n
                  })
                }
              />
            ))}
          </ul>
          <div className="flex items-center gap-3 border-t bg-field/50 px-4 py-2.5">
            <span className="min-w-0 flex-1 text-xs text-subtle">
              {t('看过差异再应用；应用后工作流和角色马上按新的内容执行')}
            </span>
            <Button size="sm" disabled={!picked.length || busy} onClick={apply}>
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t('应用选中的 {n} 项', { n: picked.length })}
            </Button>
          </div>
        </div>
      )}
      {evo.framework.length > 0 && (
        <div className="border-t">
          <SectionHead icon={FileCode2} title={t('面板框架的问题')}>
            <button
              type="button"
              onClick={copyFindings}
              className="flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 font-normal hover:bg-sel hover:text-fg"
            >
              <Copy className="h-3.5 w-3.5" />
              {t('复制')}
            </button>
          </SectionHead>
          <ol className="flex flex-col divide-y">
            {evo.framework.map((f, i) => (
              <li key={i} className="flex items-start gap-2.5 px-4 py-3">
                <span className="mt-px grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full bg-warning/12 text-[0.6875rem] font-medium text-warning tabular-nums">
                  {i + 1}
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  {f.title && <span className="text-[0.84375rem] font-medium">{f.title}</span>}
                  {f.detail && (
                    <span className="text-[0.78125rem] leading-relaxed whitespace-pre-wrap text-muted">{f.detail}</span>
                  )}
                  {f.files.length > 0 && (
                    <span className="mt-0.5 flex flex-wrap gap-1.5">
                      {f.files.map((x) => (
                        <code
                          key={x}
                          className="rounded-md border bg-field px-1.5 py-0.5 font-mono text-[0.71875rem] text-subtle"
                        >
                          {x}
                        </code>
                      ))}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  )
}

/** AI 分析的弹窗：可以写想重点看什么，开始后新建一个分析对话并打开它 */
export function AnalyzeDialog({
  open,
  onOpenChange,
  tasks,
  projectId,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  /** 要分析的执行（完整内容）；为空时弹窗里取 */
  tasks: () => Promise<Task[]>
  projectId: string
}) {
  const { agents, upsertTask } = useData()
  const { go } = useNav()
  const [focus, setFocus] = useState('')
  const [busy, setBusy] = useState(false)
  const run = async () => {
    setBusy(true)
    try {
      const list = await tasks()
      if (!list.length) throw new Error(t('还没有可以分析的执行记录'))
      const created = await startAnalysis({ tasks: list, agents, projectId, focus })
      upsertTask(taskSummary(created))
      onOpenChange(false)
      setFocus('')
      go(
        created.projectId
          ? { page: 'projects', id: created.projectId, sub: created.id }
          : { page: 'chat', id: created.id },
      )
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t('AI 分析执行结果')}
      footer={
        <>
          <span className="min-w-0 flex-1 text-xs text-subtle">
            {t('用默认角色新建一个对话来分析，只分析不改文件')}
          </span>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t('取消')}
          </Button>
          <Button disabled={busy} onClick={run}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {t('开始分析')}
          </Button>
        </>
      }
    >
      <p className="text-[0.8125rem] leading-relaxed text-muted">
        {t(
          'AI 会读完整的执行记录（消息、每个节点的结果、耗时、token 和缓存命中），判断结果质量、工作流哪里需要优化、面板框架有没有问题，并给出可以直接应用的修改建议。建议要你看过差异后才会应用。',
        )}
      </p>
      <label className="flex flex-col gap-1.5 text-[0.8125rem]">
        <span className="font-medium">{t('想重点看什么（可选）')}</span>
        <textarea
          value={focus}
          onChange={(e) => setFocus(e.target.value)}
          maxLength={1000}
          rows={3}
          placeholder={t('例如：为什么验收总是不通过、哪些节点最费 token')}
          className="resize-none rounded-lg border bg-field px-3 py-2 outline-none focus:border-accent"
        />
      </label>
    </Modal>
  )
}
