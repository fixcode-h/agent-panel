import { useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Copy,
  Crown,
  Flag,
  GitBranch,
  GripVertical,
  MoreHorizontal,
  Play,
  Plus,
  Sparkles,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react'
import type { Agent, WorkflowNode, WorkflowStage } from '@shared/schema'
import { flowId, flowTemplate } from '@shared/flow'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Field, Input, Textarea } from '@/components/ui/input'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu'
import { AgentAvatar } from '@/components/agents/AgentAvatar'
import { Pipeline, type PipelineColumn } from './Pipeline'
import { useAgentView } from '@/lib/agent-view'

type Drop = { stage: string; before: string | null } | { gap: number } | null

const newNode = (agentId = ''): WorkflowNode => ({
  id: flowId('nd'),
  title: '',
  agentId,
  instructions: '',
})

/** 把节点从原来的阶段拿出来；原阶段空了就一起删掉（除非是 keep） */
function takeNode(stages: WorkflowStage[], id: string, keep?: string) {
  let node: WorkflowNode | undefined
  const rest = stages
    .map((s) => {
      const n = s.nodes.find((x) => x.id === id)
      if (!n) return s
      node = n
      return { ...s, nodes: s.nodes.filter((x) => x.id !== id) }
    })
    .filter(
      (s) => s.nodes.length || s.id === keep || !stages.find((o) => o.id === s.id)?.nodes.some((x) => x.id === id),
    )
  return { node, rest }
}

function Terminal({ icon: Icon, label }: { icon: typeof Play; label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-full border bg-card py-1.5 pr-3.5 pl-1.5 text-[13px] font-medium">
      <span className="grid h-7 w-7 place-items-center rounded-full bg-field text-subtle ring-1 ring-line">
        <Icon className="h-3.5 w-3.5" />
      </span>
      {label}
    </div>
  )
}

/**
 * 流程图编辑器：阶段从左到右依次执行，同一阶段里的节点并行。
 * 可以拖动节点调整顺序、拖到别的阶段并行执行，或拖到两个阶段之间新建一个阶段。
 */
export function FlowEditor({
  stages,
  onChange,
  main,
  team,
  overview,
}: {
  stages: WorkflowStage[]
  onChange: (s: WorkflowStage[]) => void
  main?: Agent
  team: { agent: Agent; responsibility: string }[]
  /** 没选中节点时右侧显示的内容（例如就绪检查） */
  overview?: React.ReactNode
}) {
  const { modelOf } = useAgentView()
  const [selected, setSelected] = useState<string | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  // 拖动中的节点 id 同步记在 ref 里，dragover 触发时 state 可能还没更新
  const dragRef = useRef<string | null>(null)
  const [drop, setDrop] = useState<Drop>(null)
  const [regen, setRegen] = useState(false)
  const teamIds = new Set([main?.id, ...team.map((t) => t.agent.id)].filter(Boolean))
  const agentOf = (n: WorkflowNode) => (n.agentId ? team.find((t) => t.agent.id === n.agentId)?.agent : main)

  const sel = (() => {
    for (const [si, s] of stages.entries()) {
      const n = s.nodes.find((x) => x.id === selected)
      if (n) return { node: n, stage: s, si }
    }
    return null
  })()

  const addStage = (at: number) => {
    const n = newNode()
    onChange([...stages.slice(0, at), { id: flowId('st'), title: '', nodes: [n] }, ...stages.slice(at)])
    setSelected(n.id)
  }
  const addNode = (stageId: string) => {
    const n = newNode()
    onChange(stages.map((s) => (s.id === stageId ? { ...s, nodes: [...s.nodes, n] } : s)))
    setSelected(n.id)
  }
  const updateNode = (id: string, patch: Partial<WorkflowNode>) =>
    onChange(
      stages.map((s) => ({
        ...s,
        nodes: s.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)),
      })),
    )
  const removeNode = (id: string) => {
    onChange(takeNode(stages, id).rest)
    if (selected === id) setSelected(null)
  }
  const duplicate = (id: string) => {
    const copy = {
      ...sel!.node,
      id: flowId('nd'),
      title: sel!.node.title ? `${sel!.node.title}（副本）`.slice(0, 60) : '',
    }
    onChange(
      stages.map((s) => {
        const i = s.nodes.findIndex((n) => n.id === id)
        return i < 0
          ? s
          : {
              ...s,
              nodes: [...s.nodes.slice(0, i + 1), copy, ...s.nodes.slice(i + 1)],
            }
      }),
    )
    setSelected(copy.id)
  }
  const moveStage = (i: number, d: -1 | 1) => {
    const j = i + d
    if (j < 0 || j >= stages.length) return
    const next = [...stages]
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange(next)
  }
  const renameStage = (id: string, title: string) => onChange(stages.map((s) => (s.id === id ? { ...s, title } : s)))
  const removeStage = (id: string) => {
    if (sel?.stage.id === id) setSelected(null)
    onChange(stages.filter((s) => s.id !== id))
  }

  const applyDrop = (d: Drop) => {
    const dragging = dragRef.current
    if (!dragging || !d) return
    if ('gap' in d) {
      // 拖到两个阶段之间：新建一个阶段放这个节点
      const prev = stages[d.gap - 1]?.id
      const next = stages[d.gap]?.id
      const { node, rest } = takeNode(stages, dragging)
      if (!node) return
      const ni = rest.findIndex((s) => s.id === next)
      const pi = rest.findIndex((s) => s.id === prev)
      const at = ni >= 0 ? ni : pi >= 0 ? pi + 1 : next ? 0 : rest.length
      onChange([...rest.slice(0, at), { id: flowId('st'), title: '', nodes: [node] }, ...rest.slice(at)])
    } else {
      if (d.before === dragging) return
      const { node, rest } = takeNode(stages, dragging, d.stage)
      if (!node) return
      onChange(
        rest.map((s) => {
          if (s.id !== d.stage) return s
          const i = d.before ? s.nodes.findIndex((n) => n.id === d.before) : -1
          return {
            ...s,
            nodes: i < 0 ? [...s.nodes, node] : [...s.nodes.slice(0, i), node, ...s.nodes.slice(i)],
          }
        }),
      )
    }
    setSelected(dragging)
  }
  const endDrag = () => {
    dragRef.current = null
    setDragging(null)
    setDrop(null)
  }
  const over = (d: Drop) => (e: React.DragEvent) => {
    if (!dragRef.current) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    if (JSON.stringify(d) !== JSON.stringify(drop)) setDrop(d)
  }
  const dropHere = (d: Drop) => (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    applyDrop(d)
    endDrag()
  }

  const generate = () => {
    const next = flowTemplate(team)
    onChange(next)
    setSelected(null)
  }

  const nodeCard = (s: WorkflowStage, n: WorkflowNode) => {
    const a = agentOf(n)
    const outside = !!n.agentId && !teamIds.has(n.agentId)
    const isDrop = !!drop && 'stage' in drop && drop.before === n.id && dragging !== n.id
    return (
      <div onDragOver={over({ stage: s.id, before: n.id })} onDrop={dropHere({ stage: s.id, before: n.id })}>
        {isDrop && <div className="mb-2 h-1 rounded-full bg-accent" />}
        <button
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData('text/plain', n.id)
            e.dataTransfer.effectAllowed = 'move'
            dragRef.current = n.id
            setDragging(n.id)
          }}
          onDragEnd={endDrag}
          onClick={() => setSelected(n.id)}
          aria-pressed={selected === n.id}
          className={cn(
            'group relative flex w-full cursor-pointer flex-col gap-1.5 rounded-xl border bg-card p-3 text-left shadow-card transition-[border-color,box-shadow,opacity] hover:border-accent/60',
            selected === n.id ? 'border-accent shadow-[0_0_0_3px_var(--accent-soft)]' : 'border-line-strong',
            dragging === n.id && 'opacity-40',
          )}
        >
          <GripVertical className="absolute top-3 right-2 h-3.5 w-3.5 text-subtle opacity-0 group-hover:opacity-100" />
          <span className="flex items-center gap-2 pr-4">
            {a ? (
              <AgentAvatar icon={a.icon} cli={a.cli} size="sm" dim={!a.enabled} />
            ) : (
              <span className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-[7px] bg-warning/15 text-warning">
                <TriangleAlert className="h-3.5 w-3.5" />
              </span>
            )}
            <span className="flex min-w-0 flex-col">
              <span className={cn('truncate text-[13px] font-medium', !n.title.trim() && 'text-subtle')}>
                {n.title.trim() || '未命名节点'}
              </span>
              <span className="flex items-center gap-1 truncate text-[11px] text-subtle">
                {outside ? (
                  <span className="text-warning">Agent 不在团队中</span>
                ) : a ? (
                  <>
                    {a.name}
                    {!n.agentId && <Crown className="h-3 w-3 text-accent" aria-label="主 Agent" />}
                  </>
                ) : (
                  <span className="text-warning">还没有主 Agent</span>
                )}
              </span>
            </span>
          </span>
          {n.instructions.trim() && (
            <span className="line-clamp-2 text-xs leading-relaxed text-muted">{n.instructions.trim()}</span>
          )}
        </button>
      </div>
    )
  }

  const columns: PipelineColumn[] = [
    {
      key: 'start',
      width: 96,
      header: <div className="h-9" />,
      items: [{ key: 'start', node: <Terminal icon={Play} label="开始" /> }],
    },
    ...stages.map((s, si) => ({
      key: s.id,
      width: 212,
      props: {
        onDragOver: over({ stage: s.id, before: null }),
        onDrop: dropHere({ stage: s.id, before: null }),
      },
      className: cn(
        'rounded-2xl p-1.5 -m-1.5 transition-colors',
        drop && 'stage' in drop && drop.stage === s.id && 'bg-accent-soft/60',
      ),
      header: (
        <div className="flex h-9 items-center gap-1.5 border-b pb-1.5">
          <span
            className={cn(
              'grid h-5 min-w-5 shrink-0 place-items-center rounded-md px-1 font-mono text-[11px] font-semibold',
              s.nodes.length > 1 ? 'bg-accent-soft text-accent' : 'bg-field text-subtle ring-1 ring-line',
            )}
          >
            {si + 1}
          </span>
          <input
            value={s.title}
            onChange={(e) => renameStage(s.id, e.target.value)}
            placeholder={`阶段 ${si + 1}`}
            aria-label={`第 ${si + 1} 个阶段的名称`}
            maxLength={40}
            className="h-7 min-w-0 flex-1 rounded-md bg-transparent px-1 text-[13px] font-semibold outline-none placeholder:text-subtle hover:bg-field focus:bg-field focus:ring-1 focus:ring-accent"
          />
          {s.nodes.length > 1 && (
            <span className="flex shrink-0 items-center gap-0.5 text-[11px] text-accent" title="这个阶段的节点同时执行">
              <GitBranch className="h-3 w-3 rotate-90" />
              并行
            </span>
          )}
          <Menu>
            <MenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={`第 ${si + 1} 个阶段的操作`}>
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </MenuTrigger>
            <MenuContent>
              <MenuItem disabled={si === 0} onSelect={() => moveStage(si, -1)}>
                <ArrowLeft className="h-4 w-4" />
                左移
              </MenuItem>
              <MenuItem disabled={si === stages.length - 1} onSelect={() => moveStage(si, 1)}>
                <ArrowRight className="h-4 w-4" />
                右移
              </MenuItem>
              <MenuItem danger onSelect={() => removeStage(s.id)}>
                <Trash2 className="h-4 w-4" />
                删除阶段
              </MenuItem>
            </MenuContent>
          </Menu>
        </div>
      ),
      items: s.nodes.length
        ? s.nodes.map((n) => ({ key: n.id, node: nodeCard(s, n) }))
        : [
            {
              key: `${s.id}-empty`,
              node: <div className="rounded-xl border border-dashed p-4 text-center text-xs text-subtle">拖入节点</div>,
            },
          ],
      footer: (
        <>
          {drop && 'stage' in drop && drop.stage === s.id && drop.before === null && (
            <div className="h-1 rounded-full bg-accent" />
          )}
          <button
            onClick={() => addNode(s.id)}
            className="flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-dashed border-line-strong text-xs text-muted hover:border-accent hover:text-accent"
          >
            <Plus className="h-3.5 w-3.5" />
            并行节点
          </button>
        </>
      ),
    })),
    {
      key: 'end',
      width: 96,
      header: <div className="h-9" />,
      items: [{ key: 'end', node: <Terminal icon={Flag} label="完成" /> }],
    },
  ]

  // 第 i 列和第 i+1 列之间：插入阶段的按钮，拖动时变成「新建阶段」的放置区
  const gap = (i: number) => {
    if (i < 0) return null
    const at = i // columns[0] 是「开始」，所以第 i 个间隙插入到 stages[i]
    const active = !!drop && 'gap' in drop && drop.gap === at
    return (
      <div
        className="group relative flex w-14 shrink-0 items-center justify-center self-stretch"
        onDragOver={over({ gap: at })}
        onDrop={dropHere({ gap: at })}
      >
        {dragging ? (
          <div
            className={cn(
              'absolute inset-y-0 inset-x-2 grid place-items-center rounded-xl border-2 border-dashed text-[11px] [writing-mode:vertical-rl]',
              active ? 'border-accent bg-accent-soft text-accent' : 'border-line-strong/70 text-subtle',
            )}
          >
            新阶段
          </div>
        ) : (
          <button
            onClick={() => addStage(at)}
            aria-label={`在这里插入阶段`}
            title="插入阶段"
            className="relative z-10 grid h-7 w-7 cursor-pointer place-items-center rounded-full border border-line-strong bg-card text-muted opacity-60 shadow-card transition-opacity group-hover:opacity-100 hover:border-accent hover:text-accent focus-visible:opacity-100"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    )
  }

  const teamList = [
    ...(main ? [{ agent: main, responsibility: '主 Agent', main: true }] : []),
    ...team.map((t) => ({ ...t, main: false })),
  ]

  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <div className="min-w-0 rounded-2xl border bg-panel [background-image:radial-gradient(var(--line)_1px,transparent_1px)] [background-size:16px_16px]">
          <div className="flex flex-wrap items-center gap-2 border-b bg-panel/90 px-4 py-2.5 rounded-t-2xl">
            <span className="text-[13px] font-semibold">流程图</span>
            <span className="text-xs text-subtle">
              {stages.length} 个阶段 · {stages.reduce((n, s) => n + s.nodes.length, 0)} 个节点
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={() => (stages.length ? setRegen(true) : generate())}
            >
              <Sparkles className="h-3.5 w-3.5" />
              按团队生成
            </Button>
            <Button variant="secondary" size="sm" onClick={() => addStage(stages.length)}>
              <Plus className="h-3.5 w-3.5" />
              添加阶段
            </Button>
          </div>
          {stages.length ? (
            <Pipeline columns={columns} gap={gap} className="p-4" />
          ) : (
            <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
              <span className="grid h-11 w-11 place-items-center rounded-xl bg-accent-soft text-accent">
                <GitBranch className="h-5 w-5 rotate-90" />
              </span>
              <p className="text-[14px] font-medium">还没有流程</p>
              <p className="max-w-[380px] text-xs leading-relaxed text-subtle">
                阶段从左到右依次执行，同一阶段里的节点同时执行。可以按团队生成一个常用流程再修改。
              </p>
              <div className="flex gap-2">
                <Button size="sm" onClick={generate}>
                  <Sparkles className="h-3.5 w-3.5" />
                  按团队生成
                </Button>
                <Button size="sm" variant="secondary" onClick={() => addStage(0)}>
                  <Plus className="h-3.5 w-3.5" />
                  添加阶段
                </Button>
              </div>
            </div>
          )}
        </div>

        {!sel && (
          <div className="grid gap-4 md:grid-cols-2">
            <section className="rounded-xl border bg-card p-4 text-xs leading-relaxed text-muted">
              <h3 className="mb-2 text-[13px] font-semibold text-fg">怎么编排</h3>
              <ul className="flex list-disc flex-col gap-1 pl-4">
                <li>阶段从左到右依次执行，上一阶段的节点全部完成才进入下一阶段。</li>
                <li>同一阶段里的节点同时执行，适合互不依赖的工作，例如前端和后端。</li>
                <li>拖动节点可以调整顺序、放进别的阶段并行，或拖到两个阶段之间新建阶段。</li>
                <li>没指定 Agent 的节点由主 Agent 执行。点击节点编辑它的任务。</li>
              </ul>
            </section>
            {overview}
          </div>
        )}
      </div>

      {sel && (
        <aside className="flex w-full shrink-0 flex-col gap-4 lg:sticky lg:top-4 lg:w-[320px]">
          <section className="flex flex-col gap-4 rounded-xl border bg-card p-4">
            <div className="flex items-center gap-2">
              <h3 className="text-[13px] font-semibold">节点</h3>
              <span className="truncate text-xs text-subtle">
                {sel.stage.title || `阶段 ${sel.si + 1}`}
                {sel.stage.nodes.length > 1 && ` · 与 ${sel.stage.nodes.length - 1} 个节点并行`}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                className="ml-auto"
                aria-label="取消选择"
                onClick={() => setSelected(null)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            <Field label="名称">
              <Input
                autoFocus={!sel.node.title}
                value={sel.node.title}
                maxLength={60}
                onChange={(e) => updateNode(sel.node.id, { title: e.target.value })}
                placeholder="例如：实现接口"
              />
            </Field>
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-muted">执行的 Agent</span>
              <div className="flex flex-col gap-1" role="radiogroup" aria-label="执行的 Agent">
                {teamList.map(({ agent: a, responsibility, main: isMain }) => {
                  const on = isMain ? !sel.node.agentId || sel.node.agentId === a.id : sel.node.agentId === a.id
                  return (
                    <button
                      key={a.id}
                      role="radio"
                      aria-checked={on}
                      onClick={() => updateNode(sel.node.id, { agentId: isMain ? '' : a.id })}
                      className={cn(
                        'flex cursor-pointer items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left',
                        on ? 'border-accent bg-accent-soft' : 'border-line hover:bg-sel',
                      )}
                    >
                      <AgentAvatar icon={a.icon} cli={a.cli} size="sm" dim={!a.enabled} />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="flex items-center gap-1 truncate text-[13px] font-medium">
                          {a.name}
                          {isMain && <Crown className="h-3 w-3 text-accent" />}
                        </span>
                        <span className="truncate text-[11px] text-subtle">
                          {responsibility || a.description || modelOf(a)}
                        </span>
                      </span>
                    </button>
                  )
                })}
                {teamList.length === 0 && <p className="text-xs text-subtle">先在「设置」里选主 Agent 和子 Agent。</p>}
              </div>
            </div>
            <Field label="要做什么" hint="写清楚这个节点的任务、产出和完成标准，执行时会和需求一起发给 Agent">
              <Textarea
                rows={8}
                value={sel.node.instructions}
                onChange={(e) => updateNode(sel.node.id, { instructions: e.target.value })}
                placeholder="例如：按分析阶段的接口设计实现 API，补充参数校验，并运行类型检查。"
                className="font-mono text-[13px]"
              />
            </Field>
            <div className="flex gap-2 border-t pt-3">
              <Button variant="secondary" size="sm" onClick={() => duplicate(sel.node.id)}>
                <Copy className="h-3.5 w-3.5" />
                复制为并行节点
              </Button>
              <Button variant="danger-outline" size="sm" className="ml-auto" onClick={() => removeNode(sel.node.id)}>
                <Trash2 className="h-3.5 w-3.5" />
                删除
              </Button>
            </div>
          </section>
        </aside>
      )}

      <ConfirmDialog
        open={regen}
        onOpenChange={setRegen}
        title="按团队重新生成流程？"
        description="会用「分析 → 子 Agent 并行实现 → 验收」替换现在的流程，已有的节点会被覆盖。"
        confirmText="替换"
        onConfirm={() => {
          generate()
          setRegen(false)
        }}
      />
    </div>
  )
}
