import { useEffect, useRef, useState } from 'react'
import { ReactFlowProvider, useReactFlow } from '@xyflow/react'
import { toast } from 'sonner'
import {
  Bot,
  Crown,
  LayoutGrid,
  Maximize2,
  Minimize2,
  MousePointerClick,
  Plus,
  Sparkles,
  Trash2,
  Workflow as WorkflowIcon,
} from 'lucide-react'
import type { Agent, Flow, FlowNode, FlowRef, WorkflowInput } from '@shared/schema'
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
  preds,
  succs,
} from '@shared/flow'
import { useData } from '@/lib/data'
import { useAgentView } from '@/lib/agent-view'
import type { Check } from '@/lib/readiness'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input, Select, Textarea } from '@/components/ui/input'
import { menuItem } from '@/components/ui/menu'
import { Switch } from '@/components/ui/switch'
import { AgentAvatar } from '@/components/agents/AgentAvatar'
import { ReadinessCard } from '@/components/layout/ReadinessCard'
import { FlowCanvas, HOOK_LABEL, smartFit, type HookSlot } from './FlowCanvas'
import { nodeViews, parseRef, refOptions, refValue } from './views'

type W = WorkflowInput & { id: string }
type Team = { agent: Agent; responsibility: string }[]

const HOOK_HINT: Record<HookSlot, string> = {
  start: t('先执行这个流程，结果作为本节点的初始资料'),
  review: t('本节点完成后执行验收；不通过就把意见交回本节点继续完善'),
  end: t('验收通过后执行，结果并入本节点的输出'),
}

const usesFlow = (n: FlowNode, id: string) =>
  [n.kind === 'flow' ? n.flow : null, n.hooks.start, n.hooks.review, n.hooks.end].some(
    (r) => r?.kind === 'sub' && r.id === id,
  )

function Label({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <span className="flex flex-col gap-0.5">
      <span className="text-xs font-medium text-muted">{children}</span>
      {hint && <span className="text-[11.5px] leading-relaxed text-subtle">{hint}</span>}
    </span>
  )
}

function NodeInspector({
  w,
  flow,
  node,
  main,
  team,
  setFlow,
  onSelect,
}: {
  w: W
  flow: Flow
  node: FlowNode
  main?: Agent
  team: Team
  setFlow: (f: Flow) => void
  onSelect: (id: string) => void
}) {
  const { workflows } = useData()
  const name = (id: string) =>
    id === START ? t('开始') : id === END ? t('结束') : flow.nodes.find((n) => n.id === id)?.title || t('未命名节点')
  const setNode = (p: Partial<FlowNode>) =>
    setFlow({ ...flow, nodes: flow.nodes.map((n) => (n.id === node.id ? { ...n, ...p } : n)) })
  const up = preds(flow, node.id).map(name)
  const down = succs(flow, node.id).map(name)
  const opts = refOptions(w, workflows, flow.id)
  const outside = node.agentId && node.agentId !== main?.id && !team.some((m) => m.agent.id === node.agentId)

  return (
    <div className="flex flex-col gap-5 p-5">
      <div className="flex items-center gap-2">
        <h3 className="flex-1 font-serif text-[17px] font-semibold">{t('节点')}</h3>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('删除节点')}
          title={t('删除节点（Delete）')}
          onClick={() => {
            setFlow({
              ...flow,
              nodes: flow.nodes.filter((n) => n.id !== node.id),
              edges: flow.edges.filter((e) => e.from !== node.id && e.to !== node.id),
            })
            onSelect('')
          }}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      <label className="flex flex-col gap-1.5">
        <Label>{t('标题')}</Label>
        <Input
          value={node.title}
          maxLength={60}
          onChange={(e) => setNode({ title: e.target.value })}
          placeholder={t('这个节点做什么')}
          className="h-9"
        />
      </label>
      <div className="flex flex-col gap-1.5">
        <Label>{t('由谁执行')}</Label>
        <div role="radiogroup" aria-label={t('执行方式')} className="grid grid-cols-2 rounded-lg bg-field p-0.5">
          {(
            [
              { id: 'agent', label: 'Agent', icon: Bot },
              { id: 'flow', label: t('调用流程'), icon: WorkflowIcon },
            ] as const
          ).map((k) => (
            <button
              key={k.id}
              role="radio"
              aria-checked={node.kind === k.id}
              onClick={() => setNode({ kind: k.id })}
              className={cn(
                'flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-md text-[13px] transition-colors',
                node.kind === k.id ? 'bg-card font-medium text-fg shadow-card' : 'text-muted hover:text-fg',
              )}
            >
              <k.icon className="h-3.5 w-3.5" />
              {k.label}
            </button>
          ))}
        </div>
        {node.kind === 'agent' ? (
          <Select
            aria-label={t('执行的 Agent')}
            value={node.agentId}
            onChange={(e) => setNode({ agentId: e.target.value })}
            options={[
              { value: '', label: main ? t('主 Agent · {name}', { name: main.name }) : t('主 Agent（还没有选择）') },
              ...team.map((m) => ({ value: m.agent.id, label: m.agent.name, group: t('子 Agent') })),
              ...(outside ? [{ value: node.agentId, label: t('（不在团队里）') }] : []),
            ]}
          />
        ) : (
          <Select
            aria-label={t('调用的流程')}
            value={refValue(node.flow)}
            onChange={(e) => setNode({ flow: parseRef(e.target.value) })}
            options={refOptions(w, workflows, flow.id, t('选择流程'))}
          />
        )}
      </div>
      <label className="flex flex-col gap-1.5">
        <Label hint={t('会和工作流说明、上游节点的结果一起发给执行者')}>{t('要做的事')}</Label>
        <Textarea
          rows={6}
          value={node.instructions}
          onChange={(e) => setNode({ instructions: e.target.value })}
          placeholder={t('例如：\n按分析结论实现接口，补充单元测试，完成后列出改动的文件。')}
          className="text-[13px]"
        />
      </label>

      <section className="flex flex-col gap-4 rounded-xl border p-3.5">
        <h4 className="text-[13px] font-semibold">{t('挂载流程')}</h4>
        {(['start', 'review', 'end'] as HookSlot[]).map((s) => (
          <div key={s} className="flex flex-col gap-1.5">
            <Label hint={HOOK_HINT[s]}>{HOOK_LABEL[s]}</Label>
            <Select
              aria-label={t('{slot}流程', { slot: HOOK_LABEL[s] })}
              value={refValue(node.hooks[s])}
              onChange={(e) => setNode({ hooks: { ...node.hooks, [s]: parseRef(e.target.value) } })}
              options={opts}
            />
            {s === 'review' && node.hooks.review && (
              <label className="flex flex-wrap items-center gap-2 text-xs text-muted">
                {t('最多验收')}
                <Input
                  type="number"
                  min={1}
                  max={10}
                  value={node.hooks.maxRounds}
                  onChange={(e) =>
                    setNode({
                      hooks: {
                        ...node.hooks,
                        maxRounds: Math.min(10, Math.max(1, Math.round(Number(e.target.value) || 1))),
                      },
                    })
                  }
                  className="h-8 w-16 text-center"
                />
                {t('轮，仍不通过时节点失败')}
              </label>
            )}
          </div>
        ))}
        {opts.length === 1 && (
          <p className="text-[11.5px] text-subtle">
            {t('还没有可选的流程。可以在上方新建子流程，或者先创建别的工作流。')}
          </p>
        )}
      </section>

      <label className="flex cursor-pointer items-start gap-3 rounded-xl border p-3.5">
        <span className="flex flex-1 flex-col gap-0.5">
          <span className="text-[13px] font-semibold">{t('完成后等我确认')}</span>
          <span className="text-[11.5px] leading-relaxed text-subtle">
            {t(
              '节点做完（验收通过）后暂停，在任务页上看过结果点「通过」才往下走；退回时写上意见，节点按意见继续完善。',
            )}
          </span>
        </span>
        <Switch
          checked={!!node.hooks.confirm}
          onCheckedChange={(v) => setNode({ hooks: { ...node.hooks, confirm: v } })}
          aria-label={t('完成后等我确认')}
        />
      </label>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
        <dt className="text-subtle">{t('上游')}</dt>
        <dd className="truncate">{up.join(t('、')) || t('没有，不会执行')}</dd>
        <dt className="text-subtle">{t('下游')}</dt>
        <dd className="truncate">{down.join(t('、')) || t('没有')}</dd>
      </dl>
    </div>
  )
}

function FlowInspector({
  w,
  flow,
  atEnd,
  checks,
  setFlow,
  patch,
  onSwitchFlow,
}: {
  w: W
  flow: Flow
  atEnd: boolean
  checks: Check[]
  setFlow: (f: Flow) => void
  patch: (p: Partial<WorkflowInput>) => void
  onSwitchFlow: (id: string) => void
}) {
  const isEntry = flow.id === entryFlow(w).id
  const users = w.flows.flatMap((f) => f.nodes.filter((n) => usesFlow(n, flow.id)).map((n) => ({ f, n })))
  const remove = () => {
    const drop = (r: FlowRef | null) => (r?.kind === 'sub' && r.id === flow.id ? null : r)
    patch({
      flows: w.flows
        .filter((f) => f.id !== flow.id)
        .map((f) => ({
          ...f,
          nodes: f.nodes.map((n) => ({
            ...n,
            flow: drop(n.flow),
            hooks: { ...n.hooks, start: drop(n.hooks.start), review: drop(n.hooks.review), end: drop(n.hooks.end) },
          })),
        })),
    })
    onSwitchFlow(w.entryFlowId)
  }
  return (
    <div className="flex flex-col gap-5 p-5">
      <div className="flex items-center gap-2">
        <h3 className="flex-1 font-serif text-[17px] font-semibold">{atEnd ? t('结束') : t('流程')}</h3>
        {isEntry ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-[11px] text-accent">
            <Crown className="h-3 w-3" />
            {t('主流程')}
          </span>
        ) : (
          <span className="rounded-full bg-field px-2 py-0.5 text-[11px] text-muted">{t('子流程')}</span>
        )}
      </div>
      {atEnd && (
        <p className="-mt-2 text-[13px] leading-relaxed text-muted">
          {t('连到「结束」的节点的结果就是这个流程的结果。其他节点调用这个流程时，拿到的就是这些结果。')}
        </p>
      )}
      <label className="flex flex-col gap-1.5">
        <Label>{t('名称')}</Label>
        <Input
          value={flow.name}
          maxLength={40}
          onChange={(e) => setFlow({ ...flow, name: e.target.value })}
          placeholder={isEntry ? t('主流程') : t('例如：代码审查')}
          className="h-9"
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <Label hint={t('被别的节点调用时，告诉执行者这个流程做什么')}>{t('说明')}</Label>
        <Textarea
          rows={3}
          value={flow.description}
          onChange={(e) => setFlow({ ...flow, description: e.target.value })}
          placeholder={t('例如：检查代码质量、测试覆盖和安全问题，给出通过或不通过')}
          className="text-[13px]"
        />
      </label>
      <div className="flex flex-col gap-2.5 rounded-xl border p-3.5">
        <Label
          hint={
            isEntry
              ? t('任务从主流程的「开始」出发。子流程不会单独执行，只在节点的挂载点或流程节点里被调用。')
              : t('设为主流程后，任务从这个流程的「开始」出发，原来的主流程变成子流程。')
          }
        >
          {t('入口')}
        </Label>
        {!isEntry && (
          <>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={() => patch({ entryFlowId: flow.id })}>
                <Crown className="h-3.5 w-3.5" />
                {t('设为主流程')}
              </Button>
              <Button variant="danger-outline" size="sm" onClick={remove}>
                <Trash2 className="h-3.5 w-3.5" />
                {t('删除子流程')}
              </Button>
            </div>
            <p className="text-[11.5px] leading-relaxed text-subtle">
              {users.length
                ? t('被这些节点调用：{list}', {
                    list: users.map((u) => `${flowLabel(u.f, w)} · ${u.n.title || t('未命名节点')}`).join(t('、')),
                  })
                : t('还没有节点调用它。在节点的「挂载流程」或流程节点里选择它。')}
            </p>
          </>
        )}
      </div>
      <p className="flex gap-2 text-[12.5px] leading-relaxed text-subtle">
        <MousePointerClick className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        {t(
          '从节点右侧的圆点拖到另一个节点就能连线。右键按住拖动画布；左键在空白处拖出选框能选中多个节点，再拖其中一个就一起移动；选中后按 Delete 删除。',
        )}
      </p>
      <ReadinessCard checks={checks} />
    </div>
  )
}

function Editor({
  w,
  onChange,
  main,
  team,
  checks,
}: {
  w: W
  onChange: (p: Partial<WorkflowInput>) => void
  main?: Agent
  team: Team
  checks: Check[]
}) {
  const { agents, workflows } = useData()
  const { modelOf } = useAgentView()
  const [flowId, setFlowId] = useState(() => entryFlow(w).id)
  const [selected, setSelected] = useState('')
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

  const setFlow = (f: Flow) => onChange({ flows: w.flows.map((x) => (x.id === f.id ? f : x)) })
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
    onChange({ flows: [...w.flows, f] })
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
        <div className="flex flex-wrap items-center gap-1.5 border-b bg-bg px-3 py-2 md:px-5">
          <div role="tablist" aria-label={t('流程')} className="flex min-w-0 flex-wrap items-center gap-1">
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
                    'inline-flex h-8 max-w-[200px] cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-[13px] transition-colors',
                    on ? 'bg-sel font-medium text-fg' : 'text-muted hover:bg-sel/70 hover:text-fg',
                  )}
                >
                  {entry ? (
                    <Crown className="h-3.5 w-3.5 shrink-0 text-accent" />
                  ) : (
                    <WorkflowIcon className="h-3.5 w-3.5 shrink-0" />
                  )}
                  <span className="truncate">{flowLabel(f, w)}</span>
                  <span className="text-[11px] text-subtle">{f.nodes.length}</span>
                </button>
              )
            })}
            <button
              onClick={addFlow}
              disabled={w.flows.length >= 20}
              className="inline-flex h-8 cursor-pointer items-center gap-1 rounded-lg px-2 text-[13px] text-subtle hover:bg-sel/70 hover:text-fg disabled:opacity-40"
              title={t('新建子流程，可以挂到节点的开始、验收、结束上')}
            >
              <Plus className="h-3.5 w-3.5" />
              {t('子流程')}
            </button>
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <Button variant="secondary" size="sm" onClick={() => add('agent')}>
              <Bot className="h-3.5 w-3.5" />
              {t('Agent 节点')}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => add('flow')} title={t('执行另一个流程的节点')}>
              <WorkflowIcon className="h-3.5 w-3.5" />
              {t('流程节点')}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
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
              onClick={() => {
                setFull(!full)
                fit()
              }}
              aria-label={full ? t('退出全屏') : t('全屏编辑')}
              title={full ? t('退出全屏（Esc）') : t('全屏编辑')}
            >
              {full ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </Button>
          </div>
        </div>
        <div ref={box} className="relative flex h-[520px] min-h-0 bg-panel lg:h-auto lg:flex-1">
          <FlowCanvas
            key={flow.id}
            flow={flow}
            views={views}
            startSub={isEntry ? t('主流程') : t('子流程')}
            editable
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
          {drop && (
            <div className="absolute inset-0 z-20" onPointerDown={() => setDrop(null)}>
              <div
                role="menu"
                aria-label={t('新建节点')}
                onPointerDown={(e) => e.stopPropagation()}
                className="absolute flex max-h-[320px] w-[240px] flex-col overflow-y-auto rounded-xl border border-line-strong bg-card p-1 shadow-pop animate-[fade-in_120ms_ease-out]"
                style={{ left: Math.max(8, drop.x), top: Math.max(8, drop.y) }}
              >
                <span className="px-2.5 pt-1.5 pb-1 text-[11px] text-subtle">
                  {drop.reverse
                    ? t('新建节点，连到「{name}」前面', { name: name(drop.from) })
                    : t('新建节点，接在「{name}」后面', { name: name(drop.from) })}
                </span>
                <button role="menuitem" className={menuItem} onClick={() => createFrom({ agentId: '' })}>
                  <Bot className="h-4 w-4 shrink-0 text-subtle" />
                  <span className="truncate">
                    {t('主 Agent')}
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
                    <span className="mt-1 border-t px-2.5 pt-2 pb-1 text-[11px] text-subtle">{t('调用流程')}</span>
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
              <div className="pointer-events-auto flex max-w-[360px] flex-col items-center gap-3 rounded-2xl border bg-card p-5 text-center shadow-pop">
                <p className="font-serif text-[16px] font-semibold">
                  {isEntry ? t('从这里设计工作流') : t('这个子流程还是空的')}
                </p>
                <p className="text-[13px] leading-relaxed text-subtle">
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
                      <Sparkles className="h-3.5 w-3.5 text-accent" />
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
        className="shrink-0 overflow-y-auto border-t bg-bg lg:w-[320px] lg:border-t-0 lg:border-l"
      >
        {node ? (
          <NodeInspector
            key={node.id}
            w={w}
            flow={flow}
            node={node}
            main={main}
            team={team}
            setFlow={setFlow}
            onSelect={setSelected}
          />
        ) : selEdge ? (
          <div className="flex flex-col gap-4 p-5">
            <h3 className="font-serif text-[17px] font-semibold">{t('连线')}</h3>
            <p className="text-[13px] leading-relaxed text-muted">
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
            w={w}
            flow={flow}
            atEnd={selected === END}
            checks={checks}
            setFlow={setFlow}
            patch={onChange}
            onSwitchFlow={switchFlow}
          />
        )}
      </aside>
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

export function FlowEditor(props: {
  w: W
  onChange: (p: Partial<WorkflowInput>) => void
  main?: Agent
  team: Team
  checks: Check[]
}) {
  return (
    <ReactFlowProvider>
      <Editor {...props} />
    </ReactFlowProvider>
  )
}
