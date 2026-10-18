import { Bot, Crown, MousePointerClick, Trash2, Workflow as WorkflowIcon } from 'lucide-react'
import {
  DEFAULT_AGENT_ID,
  type Agent,
  type Flow,
  type FlowNode,
  type FlowRef,
  type WorkflowInput,
} from '@shared/schema'
import { MODEL_TIERS } from '@shared/clis'
import { agentTier } from '@shared/agent-role'
import { cliSettings, defaultCli, defaultSettings } from '@shared/settings'
import { Segmented } from '@/components/ui/segmented'
import { ParamsForm } from '@/components/agents/ParamFields'
import { t } from '@shared/i18n'
import { END, START, entryFlow, flowLabel, preds, succs } from '@shared/flow'
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
  [n.kind === 'flow' ? n.flow : null, n.hooks.start, n.hooks.review, n.hooks.end].some(
    (r) => r?.kind === 'sub' && r.id === id,
  )

export function Label({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <span className="flex flex-col gap-0.5">
      <span className="text-xs font-medium text-muted">{children}</span>
      {hint && <span className="text-[11.5px] leading-relaxed text-subtle">{hint}</span>}
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
  const setNode = (p: Partial<FlowNode>) =>
    setFlow({ ...flow, nodes: flow.nodes.map((n) => (n.id === node.id ? { ...n, ...p } : n)) })
  const up = preds(flow, node.id).map(name)
  const down = succs(flow, node.id).map(name)
  const opts = refOptions(w, workflows, flow.id)
  const outside = node.agentId && node.agentId !== main?.id && !team.some((m) => m.agent.id === node.agentId)
  // 节点只能用默认 CLI 的三档模型，思考强度跟着档位
  const runner = node.agentId ? agents.find((a) => a.id === node.agentId) : main
  const s = settings ?? defaultSettings()
  const defCliId = defaultCli(s)
  const cs = cliSettings(s, defCliId)
  const tier = node.tier || (runner ? agentTier(runner) : 'medium')
  const params = runner && runner.id !== DEFAULT_AGENT_ID ? runner.params : []

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
      {node.kind === 'agent' && (
        <div className="flex flex-col gap-1.5">
          <Label
            hint={t('用默认 CLI（{cli}）的这一档模型，思考强度也用档位的。没改过时跟着 Agent 的档位。', {
              cli: clis.find((c) => c.id === defCliId)?.name ?? defCliId,
            })}
          >
            {t('模型档位')}
          </Label>
          <Segmented
            label={t('模型档位')}
            value={tier}
            onChange={(v) => setNode({ tier: v })}
            options={MODEL_TIERS.map((m) => ({ id: m.id, label: t('{tier}档', { tier: m.label }) }))}
          />
          <span className="font-mono text-[11.5px] text-subtle">
            {cs.tiers[tier].model || t('自动')}
            {cs.tiers[tier].effort ? ` · ${cs.tiers[tier].effort}` : ''}
          </span>
        </div>
      )}
      {node.kind === 'agent' && params.length > 0 && (
        <section className="flex flex-col gap-3 rounded-xl border p-3.5">
          <Label hint={t('{name} 暴露的参数，在这个节点上的取值；没改的用 Agent 的默认值。', { name: runner!.name })}>
            {t('参数')}
          </Label>
          <ParamsForm params={params} values={node.params} onChange={(v) => setNode({ params: v })} compact />
        </section>
      )}
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

      {node.kind === 'agent' && (
        <label className="flex flex-wrap items-center gap-2 rounded-xl border p-3.5 text-xs text-muted">
          <span className="flex flex-1 flex-col gap-0.5">
            <span className="text-[13px] font-semibold text-fg">{t('失败自动重试')}</span>
            <span className="text-[11.5px] leading-relaxed text-subtle">
              {t('连接断开、偶发报错时接着上次的会话再试，不用等你点「继续执行」。')}
            </span>
          </span>
          <Input
            type="number"
            min={0}
            max={5}
            value={node.retries}
            aria-label={t('失败自动重试')}
            onChange={(e) => setNode({ retries: Math.min(5, Math.max(0, Math.round(Number(e.target.value) || 0))) })}
            className="h-8 w-16 text-center"
          />
          {t('次')}
        </label>
      )}

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
