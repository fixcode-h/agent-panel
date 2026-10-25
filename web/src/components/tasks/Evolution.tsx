import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  Bot,
  Box,
  Bug,
  Check,
  ChevronRight,
  Code2,
  Copy,
  Loader2,
  Quote,
  Sparkles,
  TriangleAlert,
  Workflow,
  Wrench,
} from 'lucide-react'
import type { Agent, Project, Task } from '@shared/schema'
import { t } from '@shared/i18n'
import { taskSummary } from '@shared/task'
import {
  applyChanges,
  lineDiff,
  parseEvolution,
  resolveChange,
  type CodeIssue,
  type ResolvedChange,
} from '@shared/task-export'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { openAiWindow } from '@/lib/ai-window'
import { fixHead, fixState } from '@/lib/analysis-report'
import { cn } from '@/lib/utils'
import { quoteFrom } from '@/lib/quote'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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

/** 一条代码问题写成的文字：复制、引用都用它 */
const issueText = (f: CodeIssue) =>
  `## ${f.title}\n${f.detail}${f.files.length ? `\n\n${f.files.map((x) => `- ${x}`).join('\n')}` : ''}`

/** 一条修改建议写成的文字：改哪里、为什么、改成什么 */
const changeText = (r: ResolvedChange) =>
  [`## ${r.field}（${r.scope}）`, r.change.reason, r.after ? `改成：\n${r.after}` : ''].filter(Boolean).join('\n\n')

/** 整份分析结果写成的文字：摘要、代码问题、优化建议，标题行的复制和引用用它 */
const resultText = (evo: { summary?: string; issues: CodeIssue[] }, rows: ResolvedChange[]) =>
  [
    evo.summary ?? '',
    evo.issues.length ? `# 代码问题\n\n${evo.issues.map(issueText).join('\n\n')}` : '',
    rows.length ? `# 优化建议\n\n${rows.map(changeText).join('\n\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')

/** 修复的标题：发进对话的消息以它开头，之后按它认出这一项修过没有 */
const fixTitle = (f: CodeIssue) => (f.title || f.detail.split('\n')[0]).slice(0, 80)
const sourceTitle = (r: ResolvedChange) => `写进源代码：${r.scope} · ${r.field}`.slice(0, 80)

/** 用户在报告里点了「修复」：在当前分析对话里要它直接动手（发给 Agent 的，不翻译） */
function fixPrompt(f: CodeIssue) {
  return [
    `用户在分析报告里点了这一项的「修复」：请现在直接动手修好它（这是分析角色允许的例外，只修这一项，不改报告里的其他项）。`,
    `问题：${f.title}`,
    f.detail,
    f.files.length ? `相关位置：\n${f.files.map((x) => `- ${x}`).join('\n')}` : '',
    f.scope === 'panel'
      ? '这是 agent-panel 面板框架本身的问题，当前项目就是面板的源代码，按仓库里 AGENTS.md 的约定改。'
      : '',
    '先读相关代码确认问题确实存在，再做最小的修改；确认不了就写清依据后结束，不要猜着改。改完说明改了什么、怎么验证的。',
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** 把一条角色、工作流的优化补进面板源代码里内置定义的要求（发给 Agent 的，不翻译） */
function sourcePrompt(r: ResolvedChange, agents: Agent[]) {
  const c = r.change
  const origin = c.target === 'agent' ? (agents.find((a) => a.id === c.agentId)?.origin ?? '') : ''
  const what = c.target === 'agent' ? '角色' : '工作流'
  return [
    `用户在分析报告里点了「写进源代码」：请现在直接动手，把你给${r.scope}的「${r.field}」提的这条优化补充进 agent-panel 源代码里对应的内置${what}定义（只做这一件事）。`,
    c.reason ? `原因：${c.reason}` : '',
    `现在的内容：\n${r.before || '（空）'}`,
    `建议改成：\n${r.after}`,
    origin.startsWith('builtin:')
      ? `它对应源代码里 origin 为 ${origin} 的内置角色。`
      : `内置角色在 shared/builtin/（agents.ts、core.ts），内置工作流模板在 shared/builtin/workflows.ts。这个${what}可能是用户自建的：先判断这条改进该归到哪个内置定义，哪个都不合适就说明理由后结束。`,
    '只吸收通用的改进，不要把只对这次任务成立的内容写进去。按仓库 AGENTS.md 和 docs/agent-catalog.md 的约定改。',
  ]
    .filter(Boolean)
    .join('\n\n')
}

function copyText(text: string) {
  void navigator.clipboard.writeText(text).then(
    () => toast.success(t('已复制')),
    () => toast.error(t('复制失败')),
  )
}

const itemAction =
  'grid h-6 w-6 shrink-0 cursor-pointer place-items-center rounded-md text-subtle transition-colors hover:bg-sel hover:text-fg'
/** 每条结果右边的文字按钮（修复、应用、写进源代码）：比卡片底部的主按钮小一号 */
const rowButton = 'h-7 px-2 text-xs'

/** 每条结果后面的两个小按钮：引用到输入框（接着和 AI 讨论这一条）、复制 */
function ItemActions({ text, stop }: { text: () => string; stop?: boolean }) {
  return (
    <span className="flex shrink-0 items-center">
      <button
        type="button"
        className={itemAction}
        title={t('引用到输入框')}
        aria-label={t('引用')}
        onClick={(e) => {
          // 放在能点开收起的标题行里时不要顺带切换
          if (stop) e.stopPropagation()
          if (!quoteFrom(e.currentTarget, text())) toast(t('这里没有可以引用到的输入框'))
        }}
      >
        <Quote className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        className={itemAction}
        title={t('复制')}
        aria-label={t('复制')}
        onClick={(e) => {
          if (stop) e.stopPropagation()
          copyText(text())
        }}
      >
        <Copy className="h-3.5 w-3.5" />
      </button>
    </span>
  )
}

/**
 * 报告里一项的「修复」类按钮：在当前分析对话里发一条明确要它动手的消息（用户 2026-10-25 要求，不再开子对话）。
 * 发过的按对话里的消息认出来：正在修时转圈，修完显示「已处理」，还能再点一次重修
 */
function FixButton({
  task,
  title,
  label,
  icon: Icon,
  disabled,
  tip,
  onSend,
}: {
  task: Task
  /** 这一项的标题：消息开头带上它，之后按它认出修过没有 */
  title: string
  label: string
  icon: typeof Wrench
  disabled?: boolean
  tip: string
  onSend: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const state = fixState(task, title)
  // 对话正在回复别的：等这一轮结束再发，免得两件事搅在一起
  const occupied = task.status === 'running' && !!task.working
  const send = async () => {
    setBusy(true)
    try {
      await onSend()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  if (state === 'working' || busy)
    return (
      <span className="inline-flex h-7 items-center gap-1 px-2 text-xs text-accent">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t('处理中')}
      </span>
    )
  return (
    <Button
      variant={state === 'done' ? 'ghost' : 'secondary'}
      className={rowButton}
      title={
        occupied
          ? t('对话正在回复，这一轮结束后再点')
          : state === 'done'
            ? t('已经在这个对话里处理过，点了再处理一次')
            : tip
      }
      disabled={disabled || occupied}
      onClick={() => void send()}
    >
      {state === 'done' ? <Check className="h-3.5 w-3.5 text-success" /> : <Icon className="h-3.5 w-3.5" />}
      {state === 'done' ? t('已处理') : label}
    </Button>
  )
}

function ChangeRow({
  r,
  busy,
  onApply,
  source,
}: {
  r: ResolvedChange
  busy: boolean
  onApply: () => void
  /** 是 agent-panel 源代码项目时：把这条写进源代码的按钮 */
  source?: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const same = r.before === r.after
  const Icon = TARGET[r.change.target]
  return (
    <li className="flex flex-col gap-2.5 px-4 py-3">
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[0.84375rem] font-medium">{r.field}</span>
            <span className="inline-flex min-w-0 items-center gap-1 text-xs text-subtle">
              <Icon className="h-3 w-3 shrink-0" aria-label={targetName(r.change.target)} />
              <span className="truncate">{r.scope}</span>
            </span>
          </span>
          {r.change.reason && <span className="text-[0.78125rem] leading-relaxed text-muted">{r.change.reason}</span>}
          {!same && !r.error && (
            <button
              type="button"
              onClick={() => setOpen(!open)}
              aria-expanded={open}
              className="-ml-1.5 flex w-fit cursor-pointer items-center gap-0.5 rounded-md px-1.5 py-0.5 text-xs text-subtle hover:bg-sel hover:text-fg"
            >
              <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-90')} />
              {t('看差异')}
            </button>
          )}
        </div>
        <span className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          <ItemActions text={() => changeText(r)} />
          {same ? (
            <Badge tone="success" className="h-7 px-2.5">
              <Check className="h-3 w-3" />
              {t('已应用')}
            </Badge>
          ) : r.error ? (
            <Badge tone="warning" className="h-7 max-w-48 px-2.5" title={r.error}>
              <TriangleAlert className="h-3 w-3 shrink-0" />
              <span className="truncate">{r.error}</span>
            </Badge>
          ) : (
            <Button
              variant="secondary"
              className={rowButton}
              disabled={busy}
              onClick={onApply}
              title={
                r.change.target === 'agent'
                  ? t('改进本机的这个角色，之后用它的对话和节点按新的内容执行')
                  : t('改进本机的这个工作流，之后的执行按新的内容走')
              }
            >
              <Check className="h-3.5 w-3.5" />
              {r.change.target === 'agent' ? t('应用到角色') : t('应用到工作流')}
            </Button>
          )}
          {source}
        </span>
      </div>
      {open && !same && <DiffView before={r.before} after={r.after} />}
    </li>
  )
}

/** 报告里每一段的小标题：点一下折叠 / 展开这一段 */
function SectionHead({
  icon: Icon,
  title,
  count,
  open,
  onToggle,
  children,
}: {
  icon: typeof Sparkles
  title: string
  count?: number
  open: boolean
  onToggle: () => void
  children?: React.ReactNode
}) {
  return (
    <h4 className="flex items-center gap-1 px-3 pt-3 pb-1 text-xs font-medium text-subtle">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1 py-0.5 hover:bg-sel hover:text-fg"
      >
        <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 transition-transform', open && 'rotate-90')} />
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span>{title}</span>
        {count !== undefined && <span className="tabular-nums">{count}</span>}
      </button>
      <span className="flex-1" />
      {children}
    </h4>
  )
}

const headButton =
  'flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 font-normal hover:bg-sel hover:text-fg'

/** 代码问题按模块分组：项目代码的在前（是这次交付的东西），面板框架的在后；同组按 AI 给的顺序 */
function issueGroups(list: CodeIssue[]) {
  const groups = new Map<string, { scope: CodeIssue['scope']; name: string; items: CodeIssue[] }>()
  for (const f of [...list.filter((x) => x.scope === 'project'), ...list.filter((x) => x.scope === 'panel')]) {
    const name = f.category || (f.scope === 'project' ? t('项目代码') : t('面板框架'))
    const key = `${f.scope}:${name}`
    const g = groups.get(key) ?? { scope: f.scope, name, items: [] }
    g.items.push(f)
    groups.set(key, g)
  }
  return [...groups.values()]
}

/** 执行分析的报告：有没有内容（右侧功能面板据此决定画不画） */
export function evolutionOf(text: string) {
  const evo = parseEvolution(text)
  return evo && (evo.changes.length || evo.issues.length || evo.summary) ? evo : null
}

/**
 * 执行分析的报告，画在分析对话右侧的功能面板里（不再固定在输入框上方，见 ADR 0016）：
 * 代码问题按模块分组，每段能折叠，每条能单独「修复」——在当前这个分析对话里直接修；
 * 角色和工作流的优化画成可以审阅的差异，点了才应用，不会自动改；
 * 项目是 agent-panel 自己的源代码时，优化还能「写进源代码」，同样在当前对话里做
 */
export function EvolutionReport({
  task,
  project,
  text,
  onTask,
}: {
  task: Task
  project?: Project
  /** 报告所在的那条回复 */
  text: string
  /** 发出修复后换上服务端返回的对话 */
  onTask: (task: Task) => void
}) {
  const { workflows, agents, setWorkflows, setAgents } = useData()
  const evo = useMemo(() => evolutionOf(text), [text])
  const rows = useMemo(
    () => evo?.changes.map((c) => resolveChange(c, workflows, agents)) ?? [],
    [evo, workflows, agents],
  )
  const [busy, setBusy] = useState(false)
  // 折起来的段：默认全展开，用户点小标题折起
  const [folded, setFolded] = useState<Set<string>>(new Set())
  const toggle = (id: string) =>
    setFolded((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  // 能在这个对话里动手：项目里的对话，不是导入的只读记录
  const canFix = !!project && !!task.projectId && !task.imported && task.mode === 'chat'
  const [panelSource, setPanelSource] = useState(false)
  const hasEvo = !!evo
  const projectId = project?.id ?? ''
  useEffect(() => {
    setPanelSource(false)
    if (!canFix || !hasEvo || !projectId) return
    let alive = true
    api
      .panelSource(projectId)
      .then((r) => alive && setPanelSource(r.panelSource))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [canFix, hasEvo, projectId])
  if (!evo) return null

  /** 在当前分析对话里发一条要它动手的消息：开头是这一项的标题，之后按它认出修过没有 */
  const send = async (title: string, body: string) => {
    onTask(await api.sendMessage(task.id, `${fixHead(title)}\n\n${body}`))
  }

  const pending = rows.filter((r) => !r.error && r.before !== r.after)
  const apply = async (list: ResolvedChange[]) => {
    setBusy(true)
    try {
      const next = applyChanges(
        list.map((r) => r.change),
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
      toast.success(t('已应用 {n} 项修改', { n: list.length }))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const sourceButton = (r: ResolvedChange) =>
    panelSource && canFix ? (
      <FixButton
        task={task}
        title={sourceTitle(r)}
        label={t('写进源代码')}
        icon={Code2}
        tip={t('在这个分析对话里，把这条优化补进 agent-panel 源代码里的内置定义')}
        onSend={() => send(sourceTitle(r), sourcePrompt(r, agents))}
      />
    ) : undefined
  const changeList = (list: ResolvedChange[]) => (
    <ul className="mx-3 flex flex-col divide-y overflow-hidden rounded-lg border bg-card">
      {list.map((r, i) => (
        <ChangeRow key={i} r={r} busy={busy} onApply={() => apply([r])} source={sourceButton(r)} />
      ))}
    </ul>
  )
  const roleRows = rows.filter((r) => r.change.target === 'agent')
  const flowRows = rows.filter((r) => r.change.target !== 'agent')
  const allIssues = () => evo.issues.map(issueText).join('\n\n')

  const quote = (e: React.MouseEvent<HTMLElement>, text: string) => {
    if (!quoteFrom(e.currentTarget, text)) toast(t('这里没有可以引用到的输入框'))
  }
  const sectionActions = (text: () => string) => (
    <>
      <button type="button" onClick={(e) => quote(e, text())} className={headButton}>
        <Quote className="h-3.5 w-3.5" />
        {t('全部引用')}
      </button>
      <button type="button" onClick={() => copyText(text())} className={headButton}>
        <Copy className="h-3.5 w-3.5" />
        {t('复制')}
      </button>
    </>
  )

  return (
    <section aria-label={t('分析报告')} className="flex flex-col pb-3">
      <div className="flex flex-col gap-2 px-4 pt-3">
        <div className="flex flex-wrap items-center gap-2">
          {evo.issues.length > 0 && <Badge tone="warning">{t('{n} 个代码问题', { n: evo.issues.length })}</Badge>}
          {evo.changes.length > 0 && <Badge tone="accent">{t('{n} 项优化建议', { n: evo.changes.length })}</Badge>}
          <span className="flex-1" />
          <ItemActions text={() => resultText(evo, rows)} />
        </div>
        {evo.summary && <p className="text-[0.8125rem] leading-relaxed text-muted">{evo.summary}</p>}
      </div>
      {evo.issues.length > 0 && (
        <div className="mt-2 border-t">
          <SectionHead
            icon={Bug}
            title={t('代码问题')}
            count={evo.issues.length}
            open={!folded.has('issues')}
            onToggle={() => toggle('issues')}
          >
            {sectionActions(allIssues)}
          </SectionHead>
          {!folded.has('issues') &&
            issueGroups(evo.issues).map((g) => (
              <div key={`${g.scope}:${g.name}`} className="pb-1">
                <div className="flex items-center gap-2 px-4 pt-2 pb-1">
                  <span className="text-[0.78125rem] font-medium">{g.name}</span>
                  {g.scope === 'panel' && <Badge>{t('面板框架')}</Badge>}
                  <span className="text-xs text-subtle tabular-nums">{g.items.length}</span>
                </div>
                <ul className="mx-3 flex flex-col divide-y overflow-hidden rounded-lg border bg-card">
                  {g.items.map((f, i) => (
                    <IssueRow
                      key={i}
                      f={f}
                      action={
                        canFix && (
                          <FixButton
                            task={task}
                            title={fixTitle(f)}
                            label={t('修复')}
                            icon={Wrench}
                            // 面板框架的问题只能在面板自己的源代码里修
                            disabled={f.scope === 'panel' && !panelSource}
                            tip={
                              f.scope === 'panel' && !panelSource
                                ? t('面板框架的问题要在 agent-panel 源代码项目里修')
                                : t('在这个分析对话里直接修这个问题')
                            }
                            onSend={() => send(fixTitle(f), fixPrompt(f))}
                          />
                        )
                      }
                    />
                  ))}
                </ul>
              </div>
            ))}
        </div>
      )}
      {roleRows.length > 0 && (
        <div className="mt-2 border-t">
          <SectionHead
            icon={Bot}
            title={t('角色优化')}
            count={roleRows.length}
            open={!folded.has('roles')}
            onToggle={() => toggle('roles')}
          >
            {sectionActions(() => roleRows.map(changeText).join('\n\n'))}
          </SectionHead>
          {!folded.has('roles') && changeList(roleRows)}
        </div>
      )}
      {flowRows.length > 0 && (
        <div className="mt-2 border-t">
          <SectionHead
            icon={Workflow}
            title={t('工作流优化')}
            count={flowRows.length}
            open={!folded.has('flows')}
            onToggle={() => toggle('flows')}
          >
            {sectionActions(() => flowRows.map(changeText).join('\n\n'))}
          </SectionHead>
          {!folded.has('flows') && changeList(flowRows)}
        </div>
      )}
      {pending.length > 1 && (
        <div className="mx-3 mt-3 flex items-center gap-3 rounded-lg border bg-field/50 px-3 py-2.5">
          <span className="min-w-0 flex-1 text-xs text-subtle">
            {t('看过差异再应用；应用后工作流和角色马上按新的内容执行')}
          </span>
          <Button size="sm" disabled={busy} onClick={() => apply(pending)}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t('全部应用（{n} 项）', { n: pending.length })}
          </Button>
        </div>
      )}
    </section>
  )
}

/** 一条代码问题：标题、说明、相关位置；右边是引用、复制和「修复」 */
function IssueRow({ f, action }: { f: CodeIssue; action?: React.ReactNode }) {
  return (
    <li className="flex flex-col gap-2 px-3 py-2.5">
      <div className="flex items-start gap-2.5">
        <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />
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
                  className="rounded-md border bg-field px-1.5 py-0.5 font-mono text-[0.71875rem] break-all text-subtle"
                >
                  {x}
                </code>
              ))}
            </span>
          )}
        </div>
      </div>
      <span className="flex items-center justify-end gap-1.5">
        <ItemActions text={() => issueText(f)} />
        {action}
      </span>
    </li>
  )
}

/**
 * AI 分析的弹窗：可以写想重点看什么，开始后按归属规则新建分析对话（见 shared/analysis-home.ts），
 * 在统一的 AI 分析窗口里看。对话执行、子任务、几次工作流执行都用它，只是 start 不同
 */
export function AnalyzeDialog({
  open,
  onOpenChange,
  title,
  intro,
  placeholder,
  subject,
  start,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  /** 弹窗标题，例如「AI 分析执行结果」「AI 分析子任务」 */
  title?: string
  /** 弹窗里说明会分析什么；不写是执行结果的那段 */
  intro?: string
  /** 「想重点看什么」的示例；不写是执行结果的那句 */
  placeholder?: string
  /** 分析对象：窗口和浮条上显示 */
  subject: string
  /** 带上用户写的重点，新建分析对话 */
  start: (focus: string) => Promise<Task>
}) {
  const { upsertTask } = useData()
  const [focus, setFocus] = useState('')
  const run = () => {
    const f = focus
    onOpenChange(false)
    setFocus('')
    openAiWindow({
      label: t('AI 分析'),
      title: subject,
      create: async () => {
        const created = await start(f)
        upsertTask(taskSummary(created))
        return created
      },
    })
  }
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={title ?? t('AI 分析执行结果')}
      footer={
        <>
          <span className="min-w-0 flex-1 text-xs text-subtle">
            {t('用「分析」角色新建对话来分析，只分析不改文件；对话里的分析开在它的父对话下')}
          </span>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t('取消')}
          </Button>
          <Button onClick={run}>
            <Sparkles className="h-4 w-4" />
            {t('开始分析')}
          </Button>
        </>
      }
    >
      <p className="text-[0.8125rem] leading-relaxed text-muted">
        {intro ??
          t(
            'AI 会读完整的执行记录（消息、每个节点的结果、耗时、token 和缓存命中），判断结果质量、哪里需要优化、面板框架有没有问题，并给出可以直接应用的修改建议。建议要你看过差异后才会应用。',
          )}
      </p>
      <label className="flex flex-col gap-1.5 text-[0.8125rem]">
        <span className="font-medium">{t('想重点看什么（可选）')}</span>
        <textarea
          value={focus}
          onChange={(e) => setFocus(e.target.value)}
          maxLength={1000}
          rows={3}
          placeholder={placeholder ?? t('例如：为什么验收总是不通过、哪些节点最费 token')}
          className="resize-none rounded-lg border bg-field px-3 py-2 outline-none focus:border-accent"
        />
      </label>
    </Modal>
  )
}
