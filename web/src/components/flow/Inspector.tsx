import { useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Bot,
  ChevronRight,
  Crown,
  MousePointerClick,
  Plus,
  Trash2,
  Workflow as WorkflowIcon,
} from 'lucide-react'
import { type Agent, type Flow, type FlowNode, type FlowRef, type NodeStep, type WorkflowInput } from '@shared/schema'
import { MODEL_TIERS } from '@shared/clis'
import { agentTier } from '@shared/agent-role'
import { cliSettings, defaultCli, defaultSettings } from '@shared/settings'
import { Segmented } from '@/components/ui/segmented'
import { ParamsForm } from '@/components/agents/ParamFields'
import { t } from '@shared/i18n'
import { END, START, entryFlow, flowLabel, newNodeStep, nodeSteps, preds, refLabel, succs } from '@shared/flow'
import { useData } from '@/lib/data'
import type { Check } from '@/lib/readiness'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input, Select, Textarea } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { ReadinessCard } from '@/components/layout/ReadinessCard'
import { HOOK_LABEL, type HookSlot } from './FlowCanvas'
import { parseRef, refOptions, refValue } from './views'

// 流程编辑器右边的属性栏：选中节点时编辑节点，没选中时编辑整个流程

export type W = WorkflowInput & { id: string }
export type Team = { agent: Agent; responsibility: string }[]

export const HOOK_HINT: Record<HookSlot, string> = {
  start: t('先执行这个流程，结果作为本节点的初始资料'),
  review: t('本节点完成后执行验收；不通过就把意见交回本节点继续完善'),
  end: t('验收通过后执行，结果并入本节点的输出'),
}

export const usesFlow = (n: FlowNode, id: string) =>
  [
    n.kind === 'flow' ? n.flow : null,
    n.hooks.start,
    n.hooks.review,
    n.hooks.end,
    ...n.steps.flatMap((s) => [s.kind === 'flow' ? s.flow : null, s.review]),
  ].some((r) => r?.kind === 'sub' && r.id === id)

export function Label({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <span className="flex flex-col gap-0.5">
      <span className="text-xs font-medium text-muted">{children}</span>
      {hint && <span className="text-[0.71875rem] leading-relaxed text-subtle">{hint}</span>}
    </span>
  )
}

export function NodeInspector({
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
  const { workflows, agents, settings, clis } = useData()
  const name = (id: string) =>
    id === START ? t('开始') : id === END ? t('结束') : flow.nodes.find((n) => n.id === id)?.title || t('未命名节点')
  // 旧的单执行者节点第一次修改时变成显式的一步，确认、验收随之下沉到步骤上
  const materialize = (n: FlowNode): FlowNode =>
    n.steps.length
      ? n
      : { ...n, steps: nodeSteps(n), hooks: { ...n.hooks, review: null, maxRounds: 3, confirm: undefined } }
  const setNode = (p: Partial<FlowNode>) =>
    setFlow({ ...flow, nodes: flow.nodes.map((n) => (n.id === node.id ? { ...materialize(n), ...p } : n)) })
  const steps = node.steps.length ? node.steps : nodeSteps(node)
  const setSteps = (list: NodeStep[]) => setNode({ steps: list })
  const patchStep = (id: string, p: Partial<NodeStep>) => setSteps(steps.map((s) => (s.id === id ? { ...s, ...p } : s)))
  const moveStep = (i: number, by: -1 | 1) => {
    const next = [...steps]
    const [x] = next.splice(i, 1)
    next.splice(i + by, 0, x)
    setSteps(next)
  }
  const addStep = (kind: NodeStep['kind']) =>
    setSteps([...steps, newNodeStep({ kind, ...(kind === 'agent' ? { agentId: '' } : {}) })])
  // 收起的步骤只记在这里，不写进流程：换台机器打开仍然全部展开
  const [folded, setFolded] = useState<Set<string>>(() => new Set())
  const foldStep = (id: string) =>
    setFolded((f) => {
      const next = new Set(f)
      if (!next.delete(id)) next.add(id)
      return next
    })
  const up = preds(flow, node.id).map(name)
  const down = succs(flow, node.id).map(name)
  const opts = refOptions(w, workflows, flow.id)
  // 子 Agent 在步骤上选：这个工作流已经用到的排在前面，其余的 Agent 都能选
  const used = new Set([...team.map((m) => m.agent.id), ...steps.map((s) => s.agentId)])
  const s = settings ?? defaultSettings()
  const defCliId = defaultCli(s)
  const cs = cliSettings(s, defCliId)
  const runnerOf = (u: NodeStep) => (u.agentId ? agents.find((a) => a.id === u.agentId) : main)
  const stepName = (u: NodeStep) =>
    u.title.trim() ||
    (u.kind === 'flow' ? refLabel(u.flow, w, workflows) || t('调用流程') : runnerOf(u)?.name || t('主角色'))

  return (
    <div className="flex flex-col gap-5 p-5">
      <div className="flex items-center gap-2">
        <h3 className="flex-1 font-serif text-[1.0625rem] font-semibold">{t('节点')}</h3>
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
      <div className="flex flex-col gap-3">
        <div className="flex items-end gap-2">
          <Label hint={t('按顺序执行，上一步的输出作为下一步的输入')}>{t('执行步骤')}</Label>
          <span className="ml-auto text-[0.6875rem] text-subtle">{t('共 {n} 步', { n: steps.length })}</span>
        </div>
        {steps.map((u, i) => {
          const runner = runnerOf(u)
          const tier = u.tier || (runner ? agentTier(runner) : 'medium')
          const params = runner?.params ?? []
          const open = !folded.has(u.id)
          return (
            <section key={u.id} className="flex flex-col gap-3 rounded-xl border p-3.5">
              <div className="flex items-center gap-1.5">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => foldStep(u.id)}
                  aria-expanded={open}
                  aria-label={open ? t('收起这一步') : t('展开这一步')}
                  title={open ? t('收起这一步') : t('展开这一步')}
                  className="-ml-1"
                >
                  <ChevronRight className={cn('h-4 w-4 transition-transform', open && 'rotate-90')} />
                </Button>
                <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-field font-mono text-[0.6875rem] text-muted">
                  {i + 1}
                </span>
                <Input
                  value={u.title}
                  maxLength={60}
                  onChange={(e) => patchStep(u.id, { title: e.target.value })}
                  placeholder={stepName(u)}
                  aria-label={t('步骤标题')}
                  className="h-8 flex-1"
                />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={i === 0}
                  onClick={() => moveStep(i, -1)}
                  aria-label={t('上移')}
                  title={t('上移')}
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={i === steps.length - 1}
                  onClick={() => moveStep(i, 1)}
                  aria-label={t('下移')}
                  title={t('下移')}
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={steps.length <= 1}
                  onClick={() => setSteps(steps.filter((x) => x.id !== u.id))}
                  aria-label={t('删除这一步')}
                  title={t('删除这一步')}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
              {!open && (
                <p className="-mt-1 truncate text-[0.71875rem] text-subtle">
                  {[
                    stepName(u),
                    u.kind === 'agent'
                      ? t('{tier}档', { tier: MODEL_TIERS.find((m) => m.id === tier)?.label ?? tier })
                      : '',
                    u.review ? t('有验收流程') : '',
                    u.confirm ? t('完成后等我确认') : '',
                    u.retries > 0 ? t('失败重试 {n} 次', { n: u.retries }) : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              )}
              {open && (
                <>
                  <div
                    role="radiogroup"
                    aria-label={t('执行方式')}
                    className="grid grid-cols-2 rounded-lg bg-field p-0.5"
                  >
                    {(
                      [
                        { id: 'agent', label: t('交给角色'), icon: Bot },
                        { id: 'flow', label: t('调用流程'), icon: WorkflowIcon },
                      ] as const
                    ).map((k) => (
                      <button
                        key={k.id}
                        role="radio"
                        aria-checked={u.kind === k.id}
                        onClick={() => patchStep(u.id, { kind: k.id })}
                        className={cn(
                          'flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-md text-[0.8125rem] transition-colors',
                          u.kind === k.id ? 'bg-card font-medium text-fg shadow-card' : 'text-muted hover:text-fg',
                        )}
                      >
                        <k.icon className="h-3.5 w-3.5" />
                        {k.label}
                      </button>
                    ))}
                  </div>
                  {u.kind === 'agent' ? (
                    <Select
                      aria-label={t('执行的角色')}
                      value={u.agentId}
                      onChange={(e) => patchStep(u.id, { agentId: e.target.value })}
                      options={[
                        {
                          value: '',
                          label: main ? t('主角色 · {name}', { name: main.name }) : t('主角色（还没有选择）'),
                        },
                        ...team
                          .filter((m) => m.agent.id !== main?.id)
                          .map((m) => ({ value: m.agent.id, label: m.agent.name, group: t('这个工作流用到的') })),
                        ...agents
                          .filter((a) => a.id !== main?.id && a.enabled && (!used.has(a.id) || a.id === u.agentId))
                          .map((a) => ({ value: a.id, label: a.name, group: t('其他角色') })),
                      ]}
                    />
                  ) : (
                    <Select
                      aria-label={t('调用的流程')}
                      value={refValue(u.flow)}
                      onChange={(e) => patchStep(u.id, { flow: parseRef(e.target.value) })}
                      options={refOptions(w, workflows, flow.id, t('选择流程'))}
                    />
                  )}
                  {u.kind === 'agent' && (
                    <>
                      <div className="flex flex-col gap-1.5">
                        <Label
                          hint={t('用默认 CLI（{cli}）的这一档模型，思考强度也用档位的。没改过时跟着角色的档位。', {
                            cli: clis.find((c) => c.id === defCliId)?.name ?? defCliId,
                          })}
                        >
                          {t('模型档位')}
                        </Label>
                        <Segmented
                          label={t('模型档位')}
                          value={tier}
                          onChange={(v) => patchStep(u.id, { tier: v })}
                          options={MODEL_TIERS.map((m) => ({ id: m.id, label: t('{tier}档', { tier: m.label }) }))}
                        />
                        <span className="font-mono text-[0.71875rem] text-subtle">
                          {cs.tiers[tier].model || t('自动')}
                          {cs.tiers[tier].effort ? ` · ${cs.tiers[tier].effort}` : ''}
                        </span>
                      </div>
                      {params.length > 0 && runner && (
                        <section className="flex flex-col gap-3 rounded-lg border p-2.5">
                          <Label
                            hint={t('{name} 暴露的参数，在这一步上的取值；没改的用角色的默认值。', {
                              name: runner.name,
                            })}
                          >
                            {t('参数')}
                          </Label>
                          <ParamsForm
                            params={params}
                            values={u.params}
                            onChange={(v) => patchStep(u.id, { params: v })}
                            compact
                          />
                        </section>
                      )}
                    </>
                  )}
                  <label className="flex flex-col gap-1.5">
                    <Label hint={t('会和工作流说明、上游结果一起发给执行者')}>{t('这一步要做的事')}</Label>
                    <Textarea
                      rows={4}
                      value={u.instructions}
                      onChange={(e) => patchStep(u.id, { instructions: e.target.value })}
                      placeholder={t('例如：按分析结论实现接口，补充单元测试，完成后列出改动的文件。')}
                      className="text-[0.8125rem]"
                    />
                  </label>
                  <div className="flex flex-col gap-2 rounded-lg border p-2.5">
                    <Label hint={t('这一步完成后执行验收；不通过就把意见交回这一步继续完善')}>{t('验收流程')}</Label>
                    <Select
                      aria-label={t('验收流程')}
                      value={refValue(u.review)}
                      onChange={(e) => patchStep(u.id, { review: parseRef(e.target.value) })}
                      options={opts}
                    />
                    {u.review && (
                      <label className="flex flex-wrap items-center gap-2 text-xs text-muted">
                        {t('最多验收')}
                        <Input
                          type="number"
                          min={1}
                          max={10}
                          value={u.maxRounds}
                          aria-label={t('最多验收')}
                          onChange={(e) =>
                            patchStep(u.id, {
                              maxRounds: Math.min(10, Math.max(1, Math.round(Number(e.target.value) || 1))),
                            })
                          }
                          className="h-8 w-16 text-center"
                        />
                        {t('轮，仍不通过时节点失败')}
                      </label>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <label className="flex flex-1 cursor-pointer items-center gap-2 text-xs text-muted">
                      <Switch
                        checked={!!u.confirm}
                        onCheckedChange={(v) => patchStep(u.id, { confirm: v })}
                        aria-label={t('完成后等我确认')}
                      />
                      {t('完成后等我确认')}
                    </label>
                    {u.kind === 'agent' && (
                      <label className="flex items-center gap-2 text-xs text-muted">
                        {t('失败自动重试')}
                        <Input
                          type="number"
                          min={0}
                          max={5}
                          value={u.retries}
                          aria-label={t('失败自动重试')}
                          onChange={(e) =>
                            patchStep(u.id, {
                              retries: Math.min(5, Math.max(0, Math.round(Number(e.target.value) || 0))),
                            })
                          }
                          className="h-8 w-16 text-center"
                        />
                        {t('次')}
                      </label>
                    )}
                  </div>
                </>
              )}
            </section>
          )
        })}
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" disabled={steps.length >= 20} onClick={() => addStep('agent')}>
            <Plus className="h-3.5 w-3.5" />
            {t('添加角色')}
          </Button>
          <Button variant="secondary" size="sm" disabled={steps.length >= 20} onClick={() => addStep('flow')}>
            <WorkflowIcon className="h-3.5 w-3.5" />
            {t('添加工作流')}
          </Button>
        </div>
      </div>

      <section className="flex flex-col gap-4 rounded-xl border p-3.5">
        <h4 className="text-[0.8125rem] font-semibold">{t('挂载流程')}</h4>
        {(['start', 'end'] as HookSlot[]).map((s) => (
          <div key={s} className="flex flex-col gap-1.5">
            <Label hint={HOOK_HINT[s]}>{HOOK_LABEL[s]}</Label>
            <Select
              aria-label={t('{slot}流程', { slot: HOOK_LABEL[s] })}
              value={refValue(node.hooks[s])}
              onChange={(e) => setNode({ hooks: { ...node.hooks, [s]: parseRef(e.target.value) } })}
              options={opts}
            />
          </div>
        ))}
        {opts.length === 1 && (
          <p className="text-[0.71875rem] text-subtle">
            {t('还没有可选的流程。可以在上方新建子流程，或者先创建别的工作流。')}
          </p>
        )}
      </section>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
        <dt className="text-subtle">{t('上游')}</dt>
        <dd className="truncate">{up.join(t('、')) || t('没有，不会执行')}</dd>
        <dt className="text-subtle">{t('下游')}</dt>
        <dd className="truncate">{down.join(t('、')) || t('没有')}</dd>
      </dl>
    </div>
  )
}

export function FlowInspector({
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
            steps: n.steps.map((s) => ({
              ...s,
              flow: s.kind === 'flow' ? drop(s.flow) : s.flow,
              review: drop(s.review),
            })),
            hooks: { ...n.hooks, start: drop(n.hooks.start), review: drop(n.hooks.review), end: drop(n.hooks.end) },
          })),
        })),
    })
    onSwitchFlow(w.entryFlowId)
  }
  return (
    <div className="flex flex-col gap-5 p-5">
      <div className="flex items-center gap-2">
        <h3 className="flex-1 font-serif text-[1.0625rem] font-semibold">{atEnd ? t('结束') : t('流程')}</h3>
        {isEntry ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-[0.6875rem] text-accent">
            <Crown className="h-3 w-3" />
            {t('主流程')}
          </span>
        ) : (
          <span className="rounded-full bg-field px-2 py-0.5 text-[0.6875rem] text-muted">{t('子流程')}</span>
        )}
      </div>
      {atEnd && (
        <p className="-mt-2 text-[0.8125rem] leading-relaxed text-muted">
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
          className="text-[0.8125rem]"
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
            <p className="text-[0.71875rem] leading-relaxed text-subtle">
              {users.length
                ? t('被这些节点调用：{list}', {
                    list: users.map((u) => `${flowLabel(u.f, w)} · ${u.n.title || t('未命名节点')}`).join(t('、')),
                  })
                : t('还没有节点调用它。在节点的「挂载流程」或流程节点里选择它。')}
            </p>
          </>
        )}
      </div>
      <p className="flex gap-2 text-[0.78125rem] leading-relaxed text-subtle">
        <MousePointerClick className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        {t(
          '从节点右侧的圆点拖到另一个节点就能连线。右键按住拖动画布；左键在空白处拖出选框能选中多个节点，再拖其中一个就一起移动；选中后按 Delete 删除。',
        )}
      </p>
      <ReadinessCard checks={checks} />
    </div>
  )
}
