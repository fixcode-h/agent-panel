import { useEffect, useRef, useState } from 'react'
import { ReactFlowProvider, useReactFlow } from '@xyflow/react'
import { toast } from '@/lib/toast'
import {
  Bot,
  ChevronRight,
  Crown,
  Hand,
  LayoutGrid,
  ListChecks,
  Maximize2,
  Minimize2,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Plus,
  Redo2,
  Sparkles,
  Trash2,
  TriangleAlert,
  Undo2,
  Workflow as WorkflowIcon,
} from 'lucide-react'
import type { Agent, Flow, FlowNode, WorkflowInput } from '@shared/schema'
import { t } from '@shared/i18n'
import {
  END,
  START,
  autoLayout,
  edge,
  entryFlow,
  flowLabel,
  flowTemplate,
  getFlow,
  newFlow,
  newNode,
} from '@shared/flow'
import { useData } from '@/lib/data'
import { useAgentView } from '@/lib/agent-view'
import { isReady, type Check } from '@/lib/readiness'
import type { SaveStatus } from '@/lib/useAutosave'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/input'
import { ResizeHandle, usePaneWidth } from '@/components/ui/resize'
import { Menu, MenuContent, MenuItem, MenuTrigger, menuItem } from '@/components/ui/menu'
import { SaveIndicator } from '@/components/layout/Detail'
import { RunInProjectDialog } from '@/components/workflows/RunInProjectDialog'
import { AgentAvatar } from '@/components/agents/AgentAvatar'
import { FlowCanvas, smartFit } from './FlowCanvas'
import { nodeViews, parseRef, refOptions } from './views'
import { FlowInspector, Label, NodeInspector, type Team, type W } from './Inspector'
import { useFlowHistory } from './history'

type EditorProps = {
  w: W
  onChange: (p: Partial<WorkflowInput>) => void
  main?: Agent
  team: Team
  checks: Check[]
  /** 自动保存的状态：画布右上角显示，工作流没有手动保存 */
  save: { status: SaveStatus; error: string; invalid?: string }
  /** 「在项目里运行」新建任务之前，先把还没自动保存的改动存下去 */
  prepare?: () => Promise<void>
}

/** 浮动工具条里的图标按钮：和画布上其他浮动面板同一套尺寸 */
const toolBtn = 'h-8 w-8'

function Editor({ w, onChange, main, team, checks, save, prepare }: EditorProps) {
  const { agents, workflows } = useData()
  const { modelOf } = useAgentView()
  const [flowId, setFlowId] = useState(() => entryFlow(w).id)
  const [selected, setSelected] = useState('')
  // 右边的属性栏默认展开：流程的说明、就绪检查和节点配置都在这里，打开工作流就能看到；可以手动收起
  const [inspector, setInspector] = useState(true)
  // 属性栏可以拖宽：节点的字段和说明比较长，默认比原来的 320 宽一些；拖动时至少给画布留 480
  const pane = usePaneWidth('flow-inspector', 380, 280, () => Math.min(720, Math.max(280, window.innerWidth - 480)))
  useEffect(() => {
    if (selected && selected !== START && selected !== END) setInspector(true)
  }, [selected])
  // 全屏编辑：画布占满窗口
  const [full, setFull] = useState(false)
  useEffect(() => {
    if (!full) return
    // Esc 先交给打开着的下拉、菜单关闭，没有弹出层时才退出全屏
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (
        document.querySelector('[data-radix-popper-content-wrapper], [role=menu], [role=listbox], [role=alertdialog]')
      )
        return
      setFull(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [full])
  const box = useRef<HTMLDivElement>(null)
  const rf = useReactFlow()
  const flow = getFlow(w, flowId) ?? entryFlow(w)
  const isEntry = flow.id === entryFlow(w).id

  // 撤销 / 重做：改 flows 的都经过 change，先把改动前的 flows 记进历史（每个工作流一份，只在内存里）
  const hist = useFlowHistory(w.id)
  // 撤销后属性栏重新挂载，输入框里不留撤销前的内容
  const [rev, setRev] = useState(0)
  const change = (p: Partial<WorkflowInput>, key?: string) => {
    if (p.flows) hist.record(w.flows, key)
    onChange(p)
  }
  const setFlow = (f: Flow, key?: string) => change({ flows: w.flows.map((x) => (x.id === f.id ? f : x)) }, key)
  // 属性栏里打字时（焦点在输入框里）连续的改动合成一步；点按钮、开关这类改动各算一步
  const typing = (id: string) => {
    const el = document.activeElement
    return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? `edit:${id}` : undefined
  }
  const step = (dir: 'undo' | 'redo') => {
    const flows = dir === 'undo' ? hist.undo(w.flows) : hist.redo(w.flows)
    if (!flows) return
    // 撤销到别的流程里的改动（例如新建子流程）：当前流程没了就回到主流程，getFlow 找不到时自己会退回
    onChange({ flows })
    setRev((r) => r + 1)
  }
  // 快捷键 Ctrl/⌘+Z 撤销、Ctrl/⌘+Shift+Z（或 Ctrl+Y）重做；输入框里留给浏览器自己的撤销，弹窗开着时不处理
  const keys = useRef(step)
  keys.current = step
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.defaultPrevented) return
      const k = e.key.toLowerCase()
      if (k !== 'z' && k !== 'y') return
      const el = e.target as HTMLElement | null
      if (el?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return
      if (document.querySelector('[role=dialog], [role=alertdialog], [role=menu]')) return
      e.preventDefault()
      keys.current(k === 'y' || e.shiftKey ? 'redo' : 'undo')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  // 平移模式：左键在空白处拖动画布（默认左键拉选框、右键拖画布）
  const [pan, setPan] = useState(false)
  const [running, setRunning] = useState(false)
  const ready = isReady(checks)
  // 就绪检查在属性栏「流程」那一页的最下面：回到那一页、展开属性栏，再滚过去
  const showChecks = () => {
    setSelected('')
    setInspector(true)
    setTimeout(
      () => document.querySelector('[data-flow-readiness]')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }),
      60,
    )
  }
  const switchFlow = (id: string) => {
    setFlowId(id)
    setSelected('')
  }
  const fit = () => setTimeout(() => smartFit(rf, box.current, 300), 50)

  // 新节点放在画布中间，不自动连线
  const add = (kind: 'agent' | 'flow') => {
    const r = box.current?.getBoundingClientRect()
    const c = r ? rf.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 }) : { x: 300, y: 0 }
    const p = freeSpot(flow, c.x - 124, c.y - 40)
    const n = newNode({ kind, title: kind === 'flow' ? t('调用流程') : t('新节点'), x: p.x, y: p.y })
    setFlow({ ...flow, nodes: [...flow.nodes, n] })
    setSelected(n.id)
  }

  // 从节点拖线到空白处松手：弹出菜单，新建的节点自动连上
  const [drop, setDrop] = useState<{
    from: string
    reverse: boolean
    x: number
    y: number
    fx: number
    fy: number
  } | null>(null)
  const createFrom = (o: Partial<FlowNode>) => {
    if (!drop) return
    const n = newNode({ title: t('新节点'), ...o, x: Math.round(drop.fx), y: Math.round(drop.fy - 40) })
    const e = drop.reverse ? edge(n.id, drop.from) : edge(drop.from, n.id)
    setFlow({ ...flow, nodes: [...flow.nodes, n], edges: [...flow.edges, e] })
    setSelected(n.id)
    setDrop(null)
  }
  const linkTerm = () => {
    if (!drop) return
    const e = drop.reverse ? edge(START, drop.from) : edge(drop.from, END)
    if (!flow.edges.some((x) => x.from === e.from && x.to === e.to)) setFlow({ ...flow, edges: [...flow.edges, e] })
    setDrop(null)
  }
  useEffect(() => {
    if (!drop) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setDrop(null)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drop])

  const addFlow = () => {
    const names = new Set(w.flows.map((f) => f.name))
    let i = 1
    while (names.has(t('子流程 {n}', { n: i }))) i++
    const f = newFlow(t('子流程 {n}', { n: i }))
    change({ flows: [...w.flows, f] })
    setFlowId(f.id)
    setSelected(START)
  }

  const views = nodeViews(flow, w, workflows, agents, modelOf)
  const node = flow.nodes.find((n) => n.id === selected)
  const selEdge = selected.startsWith('edge:') ? flow.edges.find((e) => `edge:${e.id}` === selected) : undefined
  const name = (id: string) =>
    id === START ? t('开始') : id === END ? t('结束') : flow.nodes.find((n) => n.id === id)?.title || t('未命名节点')

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col lg:flex-row', full && 'fixed inset-0 z-30 bg-bg')}>
      <div className="flex min-w-0 flex-1 flex-col">
        <div ref={box} className="@container relative flex h-[520px] min-h-0 bg-panel lg:h-auto lg:flex-1">
          <FlowCanvas
            key={flow.id}
            flow={flow}
            views={views}
            startSub={isEntry ? t('主流程') : t('子流程')}
            editable
            panMode={pan}
            selected={selected}
            onSelect={setSelected}
            onChange={setFlow}
            onReject={(m) => toast.warning(m)}
            onDropOnPane={(d) => {
              const r = box.current!.getBoundingClientRect()
              const f = rf.screenToFlowPosition(d.client)
              setDrop({
                from: d.from,
                reverse: d.reverse,
                x: Math.min(d.client.x - r.left, Math.min(r.width, window.innerWidth - r.left) - 250),
                y: Math.min(d.client.y - r.top, Math.min(r.height, window.innerHeight - r.top) - 330),
                fx: d.reverse ? f.x - 248 : f.x,
                fy: f.y,
              })
            }}
            className="flex-1"
          />
          {/* 画布上的浮动面板（照设计稿）：左上是位置和撤销重做、流程切换，右上是保存状态和「在项目里运行」，
              底部中间是画布工具条；容器本身不吃点击，空白处照常拖画布 */}
          <div className="pointer-events-none absolute inset-x-3 top-3 z-10 flex flex-wrap items-start justify-between gap-2 md:inset-x-4 md:top-4">
            <div className="flex min-w-0 flex-wrap items-start gap-2">
              <div className="pointer-events-auto flex h-10 max-w-full min-w-0 items-center gap-1 rounded-[10px] bg-card py-1 pr-1 pl-3 shadow-pop">
                <WorkflowIcon className="h-[15px] w-[15px] shrink-0 text-subtle" aria-hidden />
                {/* 画布窄时（属性栏拉宽、小屏）省掉「工作流 ›」，几块浮动面板尽量排在一行 */}
                <span className="ml-1 hidden shrink-0 text-[0.8125rem] text-subtle @4xl:inline">{t('工作流')}</span>
                <ChevronRight className="hidden h-3 w-3 shrink-0 text-subtle @4xl:block" aria-hidden />
                <span className="mr-1.5 min-w-0 truncate text-[0.8125rem] font-semibold">
                  {w.name || t('未命名工作流')}
                </span>
                <span aria-hidden className="h-5 w-px shrink-0 bg-line" />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className={toolBtn}
                  disabled={!hist.canUndo}
                  onClick={() => step('undo')}
                  aria-label={t('撤销')}
                  title={t('撤销（Ctrl+Z）')}
                >
                  <Undo2 className="h-[15px] w-[15px]" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className={toolBtn}
                  disabled={!hist.canRedo}
                  onClick={() => step('redo')}
                  aria-label={t('重做')}
                  title={t('重做（Ctrl+Shift+Z）')}
                >
                  <Redo2 className="h-[15px] w-[15px]" />
                </Button>
              </div>
              <div
                role="tablist"
                aria-label={t('流程')}
                className="pointer-events-auto flex min-h-10 max-w-full min-w-0 flex-wrap items-center gap-0.5 rounded-[10px] bg-card p-1 shadow-pop"
              >
                <WorkflowIcon className="mx-1.5 h-[15px] w-[15px] shrink-0 text-subtle" aria-hidden />
                {w.flows.map((f) => {
                  const on = f.id === flow.id
                  const entry = f.id === entryFlow(w).id
                  return (
                    <button
                      key={f.id}
                      role="tab"
                      aria-selected={on}
                      onClick={() => switchFlow(f.id)}
                      className={cn(
                        'inline-flex h-8 max-w-[200px] cursor-pointer items-center gap-1.5 rounded-[7px] px-2.5 text-[0.8125rem] transition-colors',
                        on ? 'bg-sel font-semibold text-fg' : 'text-muted hover:bg-sel/70 hover:text-fg',
                      )}
                    >
                      {entry && <Crown className="h-3.5 w-3.5 shrink-0 text-accent-text" />}
                      <span className="truncate">{flowLabel(f, w)}</span>
                      <span className="font-mono text-[0.6875rem] font-normal text-subtle">{f.nodes.length}</span>
                    </button>
                  )
                })}
                <span aria-hidden className="mx-1 h-5 w-px bg-line" />
                <button
                  onClick={addFlow}
                  disabled={w.flows.length >= 20}
                  className="inline-flex h-8 cursor-pointer items-center gap-1 rounded-[7px] px-2 text-[0.8125rem] text-muted hover:bg-sel/70 hover:text-fg disabled:opacity-40"
                  title={t('新建子流程，可以挂到节点的开始、验收、结束上')}
                >
                  <Plus className="h-3.5 w-3.5" />
                  {t('子流程')}
                </button>
              </div>
            </div>
            <div className="ml-auto flex items-center gap-2">
              {/* 工作流是自动保存的，这里只显示状态，不放假的「保存」按钮 */}
              <div className="pointer-events-auto hidden h-8 items-center rounded-[8px] bg-card px-2.5 shadow-pop @3xl:flex">
                <SaveIndicator {...save} />
              </div>
              <Button size="sm" className="pointer-events-auto shadow-pop" onClick={() => setRunning(true)}>
                <Play className="h-3 w-3" fill="currentColor" />
                {t('在项目里运行')}
              </Button>
            </div>
          </div>
          {/* 底部工具条：只放有真实功能的按钮（平移、加节点、自动排列、就绪检查、全屏、属性栏、运行） */}
          <div
            role="toolbar"
            aria-label={t('画布工具')}
            className="absolute bottom-3 left-16 z-10 flex h-11 items-center @3xl:left-1/2 @3xl:-translate-x-1/2 gap-0.5 rounded-[12px] bg-card px-1.5 shadow-pop md:bottom-4"
          >
            <Button
              variant="ghost"
              size="icon-sm"
              className={cn(toolBtn, pan && 'bg-sel text-fg')}
              aria-pressed={pan}
              onClick={() => setPan(!pan)}
              aria-label={t('平移')}
              title={pan ? t('平移模式：左键拖动画布（再点一下回到框选）') : t('平移模式：左键拖动画布')}
            >
              <Hand className="h-4 w-4" />
            </Button>
            <Menu>
              <MenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className={toolBtn}
                  aria-label={t('添加节点')}
                  title={t('添加节点')}
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </MenuTrigger>
              <MenuContent align="start">
                <MenuItem onSelect={() => add('agent')}>
                  <Bot className="h-4 w-4" />
                  {t('角色节点')}
                </MenuItem>
                <MenuItem onSelect={() => add('flow')} title={t('执行另一个流程的节点')}>
                  <WorkflowIcon className="h-4 w-4" />
                  {t('流程节点')}
                </MenuItem>
              </MenuContent>
            </Menu>
            <Button
              variant="ghost"
              size="icon-sm"
              className={toolBtn}
              onClick={() => {
                setFlow(autoLayout(flow))
                fit()
              }}
              aria-label={t('自动排列')}
              title={t('自动排列')}
            >
              <LayoutGrid className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              className={cn(toolBtn, !ready && 'text-warning hover:text-warning')}
              onClick={showChecks}
              aria-label={t('就绪检查')}
              title={ready ? t('就绪检查：全部通过') : t('就绪检查：有没通过的项')}
            >
              {ready ? <ListChecks className="h-4 w-4" /> : <TriangleAlert className="h-4 w-4" />}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              className={toolBtn}
              onClick={() => {
                setFull(!full)
                fit()
              }}
              aria-label={full ? t('退出全屏') : t('全屏编辑')}
              title={full ? t('退出全屏（Esc）') : t('全屏编辑')}
            >
              {full ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              className={cn(toolBtn, 'hidden lg:inline-flex')}
              onClick={() => {
                setInspector(!inspector)
                fit()
              }}
              aria-label={inspector ? t('收起属性栏') : t('显示属性栏')}
              title={inspector ? t('收起属性栏') : t('显示属性栏')}
            >
              {inspector ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
            </Button>
            <span aria-hidden className="mx-1 h-5 w-px bg-line" />
            <Button
              size="icon-sm"
              className="h-8 w-9"
              onClick={() => setRunning(true)}
              aria-label={t('运行')}
              title={t('在项目里运行')}
            >
              <Play className="h-3.5 w-3.5" fill="currentColor" />
            </Button>
          </div>
          {drop && (
            <div className="absolute inset-0 z-20" onPointerDown={() => setDrop(null)}>
              <div
                role="menu"
                aria-label={t('新建节点')}
                onPointerDown={(e) => e.stopPropagation()}
                className="absolute flex max-h-[320px] w-[240px] flex-col overflow-y-auto rounded-xl border border-line-strong bg-card p-1 shadow-pop animate-[fade-in_120ms_ease-out]"
                style={{ left: Math.max(8, drop.x), top: Math.max(8, drop.y) }}
              >
                <span className="px-2.5 pt-1.5 pb-1 text-[0.6875rem] text-subtle">
                  {drop.reverse
                    ? t('新建节点，连到「{name}」前面', { name: name(drop.from) })
                    : t('新建节点，接在「{name}」后面', { name: name(drop.from) })}
                </span>
                <button role="menuitem" className={menuItem} onClick={() => createFrom({ agentId: '' })}>
                  <Bot className="h-4 w-4 shrink-0 text-subtle" />
                  <span className="truncate">
                    {t('主角色')}
                    {main ? ` · ${main.name}` : ''}
                  </span>
                </button>
                {team.map((m) => (
                  <button
                    key={m.agent.id}
                    role="menuitem"
                    className={menuItem}
                    onClick={() =>
                      createFrom({ agentId: m.agent.id, title: m.responsibility.slice(0, 60) || t('新节点') })
                    }
                  >
                    <AgentAvatar icon={m.agent.icon} cli={m.agent.cli} size="xs" />
                    <span className="truncate">{m.agent.name}</span>
                  </button>
                ))}
                {refOptions(w, workflows, flow.id).filter((o) => o.value).length > 0 && (
                  <>
                    <span className="mt-1 border-t px-2.5 pt-2 pb-1 text-[0.6875rem] text-subtle">{t('调用流程')}</span>
                    {refOptions(w, workflows, flow.id)
                      .filter((o) => o.value)
                      .map((o) => (
                        <button
                          key={o.value}
                          role="menuitem"
                          className={menuItem}
                          onClick={() =>
                            createFrom({ kind: 'flow', flow: parseRef(o.value), title: o.label.slice(0, 60) })
                          }
                        >
                          <WorkflowIcon className="h-4 w-4 shrink-0 text-subtle" />
                          <span className="truncate">{o.label}</span>
                        </button>
                      ))}
                  </>
                )}
                {drop.from !== START && (
                  <>
                    <span className="mt-1 border-t" />
                    <button role="menuitem" className={menuItem} onClick={linkTerm}>
                      {drop.reverse ? t('从「开始」连过来') : t('连到「结束」')}
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
          {flow.nodes.length === 0 && (
            <div className="pointer-events-none absolute inset-0 grid place-items-center p-6">
              <div className="pointer-events-auto flex max-w-[360px] flex-col items-center gap-3 rounded-2xl bg-card p-5 text-center shadow-pop">
                <p className="font-serif text-[1rem] font-semibold">
                  {isEntry ? t('从这里设计工作流') : t('这个子流程还是空的')}
                </p>
                <p className="text-[0.8125rem] leading-relaxed text-subtle">
                  {t(
                    '添加节点后，从「开始」拖一条线到第一个节点。节点可以随意摆放，连线决定先后，没有先后关系的节点会同时执行。',
                  )}
                </p>
                <div className="flex flex-wrap justify-center gap-2">
                  <Button size="sm" onClick={() => add('agent')}>
                    <Plus className="h-3.5 w-3.5" />
                    {t('添加节点')}
                  </Button>
                  {isEntry && !!main && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setFlow(flowTemplate(team, flow))
                        fit()
                      }}
                    >
                      <Sparkles className="h-3.5 w-3.5 text-accent-text" />
                      {t('按团队生成')}
                    </Button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
      <aside
        aria-label={t('属性')}
        style={{ '--flow-inspector-w': `${pane.width}px` } as React.CSSProperties}
        className={cn(
          'relative shrink-0 overflow-y-auto border-t bg-bg lg:flex lg:flex-col lg:overflow-hidden lg:w-[var(--flow-inspector-w)] lg:border-t-0 lg:border-l',
          !inspector && 'lg:hidden',
        )}
      >
        <ResizeHandle pane={pane} label={t('拖动调整属性栏的宽度')} className="hidden lg:block" />
        <div className="min-h-0 lg:flex-1 lg:overflow-y-auto">
          {node ? (
            <NodeInspector
              key={`${node.id}:${rev}`}
              w={w}
              flow={flow}
              node={node}
              main={main}
              team={team}
              setFlow={(f) => setFlow(f, typing(node.id))}
              onSelect={setSelected}
            />
          ) : selEdge ? (
            <div className="flex flex-col gap-4 p-5">
              <h3 className="font-serif text-[1.0625rem] font-semibold">{t('连线')}</h3>
              <p className="text-[0.8125rem] leading-relaxed text-muted">
                {t('「{from}」完成后才会开始「{to}」。', { from: name(selEdge.from), to: name(selEdge.to) })}
              </p>
              {selEdge.from !== START && flow.nodes.find((n) => n.id === selEdge.from)?.kind === 'agent' && (
                <div className="flex flex-col gap-1.5">
                  <Label
                    hint={t(
                      '有条件时，「{from}」做完要给出结论（通过 / 不通过），只走对应的线；没走到的节点整段跳过。例如测试不通过时接到修复节点。',
                      { from: name(selEdge.from) },
                    )}
                  >
                    {t('条件')}
                  </Label>
                  <Select
                    aria-label={t('条件')}
                    value={selEdge.when ?? ''}
                    onChange={(e) =>
                      setFlow({
                        ...flow,
                        edges: flow.edges.map((x) =>
                          x.id === selEdge.id ? { ...x, when: e.target.value as 'pass' | 'fail' | '' } : x,
                        ),
                      })
                    }
                    options={[
                      { value: '', label: t('总是') },
                      { value: 'pass', label: t('结论是「通过」时') },
                      { value: 'fail', label: t('结论是「不通过」时') },
                    ]}
                  />
                </div>
              )}
              <Button
                variant="danger-outline"
                className="self-start"
                onClick={() => {
                  setFlow({ ...flow, edges: flow.edges.filter((e) => e.id !== selEdge.id) })
                  setSelected('')
                }}
              >
                <Trash2 className="h-4 w-4" />
                {t('删除连线')}
              </Button>
            </div>
          ) : (
            <FlowInspector
              key={rev}
              w={w}
              flow={flow}
              atEnd={selected === END}
              checks={checks}
              setFlow={(f) => setFlow(f, typing(`flow:${f.id}`))}
              patch={change}
              onSwitchFlow={switchFlow}
            />
          )}
        </div>
      </aside>
      <RunInProjectDialog
        open={running}
        onOpenChange={setRunning}
        workflow={{ id: w.id, name: w.name }}
        notReady={ready ? undefined : t('就绪检查还有没通过的项，运行时可能出错')}
        prepare={prepare}
      />
    </div>
  )
}

/**
 * 工作流的流程图编辑器：自由摆放节点，拖动连线决定先后；一个工作流可以有多个流程（主流程 + 子流程），
 * 节点可以在开始、验收、结束三个位置挂载其他流程。
 */
/** 新节点的位置：从画布中间开始，向外找一个不压住已有节点的空位 */
function freeSpot(flow: Flow, x0: number, y0: number) {
  const W = 260
  const H = 130
  const boxes = [
    ...flow.nodes.map((n) => ({ x: n.x, y: n.y })),
    ...(flow.startPos ? [flow.startPos] : []),
    ...(flow.endPos ? [flow.endPos] : []),
  ]
  const free = (x: number, y: number) => boxes.every((b) => Math.abs(b.x - x) >= W || Math.abs(b.y - y) >= H)
  for (let r = 0; r < 8; r++)
    for (let dx = -r; dx <= r; dx++)
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue
        const x = Math.round(x0 + dx * W)
        const y = Math.round(y0 + dy * H)
        if (free(x, y)) return { x, y }
      }
  return { x: Math.round(x0), y: Math.round(y0) }
}

export function FlowEditor(props: EditorProps) {
  return (
    <ReactFlowProvider>
      <Editor {...props} />
    </ReactFlowProvider>
  )
}
