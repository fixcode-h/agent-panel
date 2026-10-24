import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  Bot,
  Box,
  Bug,
  Check,
  ChevronDown,
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
  EVOLUTION_LANG,
  applyChanges,
  lineDiff,
  parseEvolution,
  resolveChange,
  type CodeIssue,
  type ResolvedChange,
} from '@shared/task-export'
import { api } from '@/lib/api'
import { useData, useNav } from '@/lib/data'
import { startAnalysis } from '@/lib/task-transfer'
import { cn } from '@/lib/utils'
import { quoteFrom } from '@/lib/quote'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'
import { useChildOpen } from './child-open'

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

/** 修复子对话的标题：同一条问题再进来时按标题认出已经开过的子对话 */
const fixTitle = (f: CodeIssue) => `修复：${f.title || f.detail.split('\n')[0]}`.slice(0, 80)
const sourceTitle = (r: ResolvedChange) => `写进源代码：${r.scope} · ${r.field}`.slice(0, 80)

/** 交给修复子对话的要求（发给 Agent 的，不翻译） */
function fixPrompt(f: CodeIssue) {
  return [
    `修复 AI 分析执行记录时发现的一个代码问题：${f.title}`,
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
    `AI 分析执行记录后，给${r.scope}的「${r.field}」提了一条优化。把它补充进 agent-panel 源代码里对应的内置${what}定义。`,
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

/** 分析对话下面开出的子对话：只要认出它和它的状态 */
export interface EvolutionChild {
  id: string
  title: string
  working: boolean
}

/**
 * 开子对话的按钮：还没开时点了新建，开过的变成「查看」，在右栏打开那个子对话。
 * 子对话列表每隔几秒才刷新一次，刚开的先按这里记下的 id 显示
 */
function ChildButton({
  title,
  label,
  icon: Icon,
  child,
  disabled,
  tip,
  onStart,
}: {
  title: string
  label: string
  icon: typeof Wrench
  child?: EvolutionChild
  disabled?: boolean
  tip: string
  onStart: () => Promise<void>
}) {
  const openChild = useChildOpen()
  const [busy, setBusy] = useState(false)
  if (child)
    return (
      <Button
        variant="ghost"
        className={rowButton}
        title={t('在右侧打开子对话「{title}」', { title })}
        onClick={() => openChild?.(child.id)}
        disabled={!openChild}
      >
        {child.working ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
        ) : (
          <Check className="h-3.5 w-3.5 text-success" />
        )}
        {child.working ? t('处理中') : t('查看')}
      </Button>
    )
  return (
    <Button
      variant="secondary"
      className={rowButton}
      title={tip}
      disabled={disabled || busy}
      onClick={async () => {
        setBusy(true)
        try {
          await onStart()
        } catch (e) {
          toast.error((e as Error).message)
        } finally {
          setBusy(false)
        }
      }}
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Icon className="h-3.5 w-3.5" />}
      {label}
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

/** 结果卡片里每一段的小标题 */
function SectionHead({
  icon: Icon,
  title,
  count,
  children,
}: {
  icon: typeof Sparkles
  title: string
  count?: number
  children?: React.ReactNode
}) {
  return (
    <h4 className="flex items-center gap-1.5 px-4 pt-3 pb-1 text-xs font-medium text-subtle">
      <Icon className="h-3.5 w-3.5" />
      <span>{title}</span>
      {count !== undefined && <span className="tabular-nums">{count}</span>}
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

/**
 * 「AI 分析」对话的结果下面：代码问题按模块分组，每条可以开一个子对话去修；
 * 角色和工作流的优化画成可以审阅的差异，点了才应用，不会自动改；
 * 项目是 agent-panel 自己的源代码时，优化还能开子对话补进源代码里的内置定义
 */
export function EvolutionCard({
  task,
  project,
  kids = [],
  onSpawned,
}: {
  task: Task
  project?: Project
  /** 这个对话下的子对话：认出哪些问题已经开过修复 */
  kids?: EvolutionChild[]
  /** 开好子对话后：刷新子对话列表再在右栏打开（列表里还没有它时右栏会被当成已删除关掉） */
  onSpawned?: (id: string) => void
}) {
  const { workflows, agents, setWorkflows, setAgents } = useData()
  const openChild = useChildOpen()
  const hit = useMemo(() => {
    if (task.mode !== 'chat') return undefined
    // 分析对话回复完 CLI 往往还连着等下一句：不在处理这一轮就画出来，不等进程结束。
    // 正在回复时只看最后一条用户消息之前的：结果固定在输入框上方，接着追问时还留着（折叠），正在写的那条没写完不解析
    const msgs = task.messages
    let end = msgs.length
    if (task.status === 'running' && task.working) while (end > 0 && msgs[end - 1].role !== 'user') end--
    for (let i = end - 1; i >= 0; i--)
      if (msgs[i].role === 'agent' && msgs[i].text.includes('```' + EVOLUTION_LANG)) return msgs[i]
    return undefined
  }, [task])
  // 用户发了新内容就收起来，把位置让给对话；有了新的分析结果再展开。
  // 打开对话时结果之后已经有用户消息的，一开始就是收起的
  const userCount = task.messages.filter((m) => m.role === 'user').length
  const hitId = hit?.id ?? ''
  const [open, setOpen] = useState(
    () => !hit || !task.messages.slice(task.messages.indexOf(hit) + 1).some((m) => m.role === 'user'),
  )
  const seen = useRef({ userCount, hitId })
  useEffect(() => {
    const prev = seen.current
    seen.current = { userCount, hitId }
    if (hitId && hitId !== prev.hitId && prev.hitId) setOpen(true)
    else if (userCount > prev.userCount) setOpen(false)
  }, [userCount, hitId])
  const evo = useMemo(() => (hit ? parseEvolution(hit.text) : null), [hit])
  const rows = useMemo(
    () => evo?.changes.map((c) => resolveChange(c, workflows, agents)) ?? [],
    [evo, workflows, agents],
  )
  const [busy, setBusy] = useState(false)
  // 刚开的子对话：列表还没刷新到时先按标题记着
  const [started, setStarted] = useState<Record<string, string>>({})
  // 能开子对话：项目里的顶层对话，不是导入的只读记录
  const canSpawn = !!project && !!task.projectId && !task.parentTaskId && !task.imported
  const [panelSource, setPanelSource] = useState(false)
  const hasEvo = !!evo
  const projectId = project?.id ?? ''
  useEffect(() => {
    setPanelSource(false)
    if (!canSpawn || !hasEvo || !projectId) return
    let alive = true
    api
      .panelSource(projectId)
      .then((r) => alive && setPanelSource(r.panelSource))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [canSpawn, hasEvo, projectId])
  if (!evo || (!evo.changes.length && !evo.issues.length)) return null

  const childOf = (title: string): EvolutionChild | undefined =>
    kids.find((k) => k.title === title) ?? (started[title] ? { id: started[title], title, working: true } : undefined)

  /** 在这个分析对话下面开一个子对话，用「执行」角色去做，开好后在右栏打开 */
  const spawn = async (title: string, prompt: string) => {
    const worker = agents.find((a) => a.origin === 'builtin:worker')
    const created = await api.createTask({
      projectId: task.projectId,
      mode: 'chat',
      parentTaskId: task.id,
      workflowId: '',
      agentId: worker?.id ?? project?.defaultAgentId ?? '',
      cli: '',
      model: '',
      effort: '',
      params: {},
      prompt,
      attachments: [],
      isolate: false,
      askUser: task.askUser,
    })
    // 标题由这里定：之后按标题认出这条已经开过
    await api.renameTask(created.id, title).catch(() => {})
    setStarted((s) => ({ ...s, [title]: created.id }))
    if (onSpawned) onSpawned(created.id)
    else openChild?.(created.id)
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
    panelSource ? (
      <ChildButton
        title={sourceTitle(r)}
        label={t('写进源代码')}
        icon={Code2}
        child={childOf(sourceTitle(r))}
        tip={t('开一个子对话，把这条优化补进 agent-panel 源代码里的内置定义')}
        onStart={() => spawn(sourceTitle(r), sourcePrompt(r, agents))}
      />
    ) : undefined
  const changeList = (list: ResolvedChange[]) => (
    <ul className="flex flex-col divide-y">
      {list.map((r, i) => (
        <ChangeRow key={i} r={r} busy={busy} onApply={() => apply([r])} source={sourceButton(r)} />
      ))}
    </ul>
  )
  const roleRows = rows.filter((r) => r.change.target === 'agent')
  const flowRows = rows.filter((r) => r.change.target !== 'agent')
  const allIssues = () => evo.issues.map(issueText).join('\n\n')

  const quote = (e: React.MouseEvent<HTMLElement>, text: string) => {
    e.stopPropagation()
    if (!quoteFrom(e.currentTarget, text)) toast(t('这里没有可以引用到的输入框'))
  }
  const copy = (e: React.MouseEvent<HTMLElement>, text: string) => {
    e.stopPropagation()
    copyText(text)
  }
  const sectionActions = (text: () => string) => (
    <>
      <button type="button" onClick={(e) => quote(e, text())} className={headButton}>
        <Quote className="h-3.5 w-3.5" />
        {t('全部引用')}
      </button>
      <button type="button" onClick={(e) => copy(e, text())} className={headButton}>
        <Copy className="h-3.5 w-3.5" />
        {t('复制')}
      </button>
    </>
  )

  return (
    <section
      aria-label={t('分析结果')}
      className="mx-auto mb-2 flex max-h-[50vh] max-w-(--content-w) flex-col overflow-hidden rounded-xl border border-line-strong bg-card shadow-card"
    >
      {/* 固定在输入框上方：标题行点一下展开收起；收起时只剩这一行，摘要截成一行 */}
      <header
        className={cn('flex shrink-0 cursor-pointer items-start gap-3 px-4', open ? 'py-3.5' : 'py-2')}
        onClick={() => setOpen(!open)}
      >
        <span
          className={cn(
            'grid shrink-0 place-items-center rounded-lg bg-accent-soft text-accent',
            open ? 'h-8 w-8' : 'h-6 w-6',
          )}
        >
          <Sparkles className={open ? 'h-4 w-4' : 'h-3.5 w-3.5'} />
        </span>
        <div className={cn('flex min-w-0 flex-1 gap-1', open ? 'flex-col' : 'items-center self-center')}>
          <div className={cn('flex items-center gap-x-2 gap-y-1', open ? 'flex-wrap' : 'shrink-0')}>
            <h3 className="text-[0.875rem] font-semibold">{t('分析结果')}</h3>
            {evo.issues.length > 0 && <Badge tone="warning">{t('{n} 个代码问题', { n: evo.issues.length })}</Badge>}
            {evo.changes.length > 0 && <Badge tone="accent">{t('{n} 项优化建议', { n: evo.changes.length })}</Badge>}
          </div>
          {evo.summary &&
            (open ? (
              <p className="text-[0.8125rem] leading-relaxed text-muted">{evo.summary}</p>
            ) : (
              <span className="ml-1 min-w-0 truncate text-[0.8125rem] text-subtle">{evo.summary}</span>
            ))}
        </div>
        <span className={cn('flex shrink-0 items-center text-xs text-subtle', open ? '' : 'self-center')}>
          <ItemActions text={() => resultText(evo, rows)} stop />
          <button
            type="button"
            aria-expanded={open}
            aria-label={open ? t('收起分析结果') : t('展开分析结果')}
            title={open ? t('收起分析结果') : t('展开分析结果')}
            className={itemAction}
            onClick={(e) => {
              e.stopPropagation()
              setOpen(!open)
            }}
          >
            <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', !open && 'rotate-180')} />
          </button>
        </span>
      </header>
      {open && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {evo.issues.length > 0 && (
            <div className="border-t">
              <SectionHead icon={Bug} title={t('代码问题')} count={evo.issues.length}>
                {sectionActions(allIssues)}
              </SectionHead>
              {issueGroups(evo.issues).map((g) => (
                <div key={`${g.scope}:${g.name}`} className="pb-1">
                  <div className="flex items-center gap-2 px-4 pt-2 pb-1">
                    <span className="text-[0.78125rem] font-medium">{g.name}</span>
                    {g.scope === 'panel' && <Badge>{t('面板框架')}</Badge>}
                    <span className="text-xs text-subtle tabular-nums">{g.items.length}</span>
                  </div>
                  <ul className="mx-3 flex flex-col divide-y overflow-hidden rounded-lg border bg-field/40">
                    {g.items.map((f, i) => {
                      // 面板框架的问题只能在面板自己的源代码里修
                      const blocked = f.scope === 'panel' && !panelSource
                      return (
                        <li key={i} className="flex items-start gap-3 px-3 py-2.5">
                          <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />
                          <div className="flex min-w-0 flex-1 flex-col gap-1">
                            {f.title && <span className="text-[0.84375rem] font-medium">{f.title}</span>}
                            {f.detail && (
                              <span className="text-[0.78125rem] leading-relaxed whitespace-pre-wrap text-muted">
                                {f.detail}
                              </span>
                            )}
                            {f.files.length > 0 && (
                              <span className="mt-0.5 flex flex-wrap gap-1.5">
                                {f.files.map((x) => (
                                  <code
                                    key={x}
                                    className="rounded-md border bg-card px-1.5 py-0.5 font-mono text-[0.71875rem] text-subtle"
                                  >
                                    {x}
                                  </code>
                                ))}
                              </span>
                            )}
                          </div>
                          <span className="flex shrink-0 items-center gap-1.5">
                            <ItemActions text={() => issueText(f)} />
                            {canSpawn && (
                              <ChildButton
                                title={fixTitle(f)}
                                label={t('修复')}
                                icon={Wrench}
                                child={childOf(fixTitle(f))}
                                disabled={blocked}
                                tip={
                                  blocked
                                    ? t('面板框架的问题要在 agent-panel 源代码项目里修')
                                    : t('开一个子对话来修这个问题')
                                }
                                onStart={() => spawn(fixTitle(f), fixPrompt(f))}
                              />
                            )}
                          </span>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              ))}
            </div>
          )}
          {roleRows.length > 0 && (
            <div className="border-t">
              <SectionHead icon={Bot} title={t('角色优化')} count={roleRows.length}>
                {sectionActions(() => roleRows.map(changeText).join('\n\n'))}
              </SectionHead>
              {changeList(roleRows)}
            </div>
          )}
          {flowRows.length > 0 && (
            <div className="border-t">
              <SectionHead icon={Workflow} title={t('工作流优化')} count={flowRows.length}>
                {sectionActions(() => flowRows.map(changeText).join('\n\n'))}
              </SectionHead>
              {changeList(flowRows)}
            </div>
          )}
          {pending.length > 1 && (
            <div className="flex items-center gap-3 border-t bg-field/50 px-4 py-2.5">
              <span className="min-w-0 flex-1 text-xs text-subtle">
                {t('看过差异再应用；应用后工作流和角色马上按新的内容执行')}
              </span>
              <Button size="sm" disabled={busy} onClick={() => apply(pending)}>
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {t('全部应用（{n} 项）', { n: pending.length })}
              </Button>
            </div>
          )}
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
