import { useEffect, useMemo, useRef, useState } from 'react'
import * as D from '@radix-ui/react-dialog'
import { toast } from 'sonner'
import { ArrowUp, Check, CircleAlert, Crown, Loader2, Sparkles, Square, Wand2, X } from 'lucide-react'
import { applyProposal, type AssistJob, type AssistKind, type AssistMessage, type Proposal } from '@shared/assist'
import { CLIS, MODEL_TIERS, type CliDefinition, type ModelTier } from '@shared/clis'
import { agentRun, cliSettings, orderClis } from '@shared/settings'
import type { Agent, AgentInput, Settings, Workflow } from '@shared/schema'
import { api } from '@/lib/api'
import { cliColor, effortLabel } from '@/lib/cli-style'
import { useCliDef } from '@/lib/cli-models'
import { Select } from '@/components/ui/input'
import { useAgentView } from '@/lib/agent-view'
import { useData } from '@/lib/data'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { AgentAvatar } from '@/components/agents/AgentAvatar'
import { FlowCanvas } from '@/components/flow/FlowCanvas'
import { nodeViews } from '@/components/flow/views'
import { entryFlow, flowLabel, getFlow } from '@shared/flow'

type Turn = AssistMessage & { proposal?: Proposal; error?: string }

const EXAMPLES: Record<AssistKind, string[]> = {
  agent: [
    '一个专门写 Playwright 端到端测试的 Agent，用 Claude Code',
    '负责代码审查的 Agent，重点看安全和性能问题',
    '帮我写 Go 后端接口的 Agent，用 Codex',
  ],
  workflow: [
    'Web 功能开发：先分析需求，前后端并行开发，然后测试和代码审查，最后验收',
    'Bug 修复：复现问题、定位修复、回归测试',
    '文档更新：并行整理 README 和接口文档，再统一校对',
  ],
}

function AgentPreview({ agent, before, newCategory }: { agent: AgentInput; before?: Agent; newCategory: string }) {
  const { categories } = useData()
  const { cliOf, cliName, modelOf } = useAgentView()
  const changed = (k: keyof AgentInput) => before && JSON.stringify(before[k]) !== JSON.stringify(agent[k])
  const tag = (k: keyof AgentInput) => (changed(k) ? <Badge tone="accent">已修改</Badge> : null)
  const cat = newCategory || categories.find((c) => c.id === agent.categoryId)?.name
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <AgentAvatar icon={agent.icon} cli={agent.cli} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-[16px] font-semibold">{agent.name}</span>
            {tag('name')}
          </div>
          <p className="text-[13px] text-muted">
            {agent.description || '没有简介'} {tag('description')}
          </p>
        </div>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13px]">
        <dt className="text-subtle">CLI</dt>
        <dd className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full" style={{ background: cliColor(cliOf(agent)) }} />
          {agent.cli
            ? CLIS.find((c) => c.id === agent.cli)?.name
            : `系统默认（${cliName(agent).replace('（默认）', '')}）`}{' '}
          {tag('cli')}
        </dd>
        <dt className="text-subtle">模型</dt>
        <dd className="font-mono text-xs">
          {modelOf(agent)} {tag('model')}
        </dd>
        <dt className="text-subtle">分类</dt>
        <dd>
          {cat || '未分类'} {newCategory && <Badge>新建</Badge>} {tag('categoryId')}
        </dd>
      </dl>
      <div className="flex flex-col gap-1.5">
        <span className="flex items-center gap-2 text-xs text-muted">角色设定 {tag('instructions')}</span>
        <pre className="max-h-[340px] overflow-auto rounded-lg border bg-field p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-fg">
          {agent.instructions || '（空）'}
        </pre>
      </div>
    </div>
  )
}

function WorkflowPreview({ p }: { p: Extract<Proposal, { kind: 'workflow' }> }) {
  const { agents, workflows } = useData()
  const { modelOf } = useAgentView()
  const w = p.workflow
  const who = (id: string) => {
    const a = agents.find((x) => x.id === id) ?? p.newAgents.find((x) => x.ref === id)
    return a ? { ...a, isNew: id.startsWith('new:') } : undefined
  }
  const main = who(w.mainAgentId)
  const pool = [...agents, ...p.newAgents.map((a): Agent => ({ ...a, id: a.ref, createdAt: '', updatedAt: '' }))]
  const [fid, setFid] = useState(w.entryFlowId)
  const flow = getFlow(w, fid) ?? entryFlow(w)
  const views = nodeViews(flow, w, workflows, pool, modelOf)
  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="text-[16px] font-semibold">{w.name}</div>
        <p className="text-[13px] text-muted">{w.description || '没有简介'}</p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {[
          main && { a: main, role: '主 Agent' },
          ...w.members.map((m) => ({ a: who(m.agentId), role: m.responsibility })),
        ]
          .filter((x): x is { a: NonNullable<ReturnType<typeof who>>; role: string } => !!x && !!x.a)
          .map(({ a, role }, i) => (
            <span
              key={i}
              title={role}
              className={cn(
                'flex items-center gap-1.5 rounded-full border py-0.5 pr-2.5 pl-1 text-xs',
                a.isNew ? 'border-accent/60 bg-accent-soft' : 'bg-card',
              )}
            >
              <AgentAvatar icon={a.icon} cli={a.cli} size="xs" />
              {a.name}
              {i === 0 && <Crown className="h-3 w-3 text-accent" />}
              {a.isNew && <span className="text-[11px] text-accent">新建</span>}
            </span>
          ))}
      </div>
      <div className="overflow-hidden rounded-xl border">
        {w.flows.length > 1 && (
          <div role="tablist" className="flex flex-wrap gap-1 border-b p-1.5">
            {w.flows.map((f) => (
              <button
                key={f.id}
                role="tab"
                aria-selected={f.id === flow.id}
                onClick={() => setFid(f.id)}
                className={cn(
                  'h-7 cursor-pointer rounded-md px-2.5 text-xs',
                  f.id === flow.id ? 'bg-sel font-medium text-fg' : 'text-muted hover:text-fg',
                )}
              >
                {flowLabel(f, w)}
              </button>
            ))}
          </div>
        )}
        <FlowCanvas
          key={flow.id}
          flow={flow}
          views={views}
          startSub={flow.id === w.entryFlowId ? '主流程' : '子流程'}
          selected=""
          onSelect={() => {}}
          className="flex h-[360px] bg-panel"
        />
      </div>
      {p.newAgents.length > 0 && (
        <p className="text-xs text-muted">
          应用时会先创建 {p.newAgents.length} 个新 Agent：{p.newAgents.map((a) => a.name).join('、')}。
        </p>
      )}
      {w.document.trim() && (
        <details className="rounded-lg border bg-field">
          <summary className="cursor-pointer px-3 py-2 text-xs text-muted">工作流说明</summary>
          <pre className="max-h-[260px] overflow-auto border-t px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap">
            {w.document}
          </pre>
        </details>
      )}
    </div>
  )
}

/** 生成中：流式显示思考过程、说明文字、用到的工具和已写的字数，加上已用时间 */
function JobProgress({ job, cliName }: { job: AssistJob; cliName: string }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const secs = job.startedAt ? Math.max(0, Math.round((now - job.startedAt) / 1000)) : 0
  const writingJson = (job.outChars ?? 0) > job.text.length + 20
  const phase =
    job.attempt > 1
      ? '格式不对，正在让 CLI 修正'
      : writingJson
        ? `正在写配置（已写 ${(job.outChars ?? 0).toLocaleString()} 字）`
        : job.text
          ? '正在写说明'
          : job.thinking
            ? '正在思考'
            : `${cliName} 正在生成`
  const thinking = job.thinking?.trim()
  return (
    <div className="flex flex-col gap-2 text-[13px] leading-relaxed">
      {thinking && (
        <p className="line-clamp-4 border-l-2 border-line-strong pl-2.5 text-xs whitespace-pre-wrap text-subtle italic">
          {thinking.length > 400 ? '…' + thinking.slice(-400) : thinking}
        </p>
      )}
      {job.text && <p className="whitespace-pre-wrap">{job.text}</p>}
      {!!job.tools?.length && (
        <ul className="flex flex-col gap-0.5 text-xs text-subtle">
          {job.tools.map((t, i) => (
            <li key={i} className="truncate font-mono">
              · {t}
            </li>
          ))}
        </ul>
      )}
      <span className="flex items-center gap-2 text-xs text-subtle">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
        {phase}…<span className="tabular-nums">{secs} 秒</span>
      </span>
    </div>
  )
}

/** 输入框下面的模型、思考强度：显示这次实际会用的值，选了就只对这次生成生效 */
function RunPicker({
  def,
  settings,
  model,
  effort,
  onModel,
  onEffort,
  disabled,
}: {
  def: CliDefinition
  settings: Settings
  model: string
  effort: string
  onModel: (v: string) => void
  onEffort: (v: string) => void
  disabled?: boolean
}) {
  const cs = cliSettings(settings, def.id)
  const run = agentRun({ cli: def.id, model, effort }, settings)
  // 「默认」显示设置里会用到的具体模型，档位也换成具体模型
  const base = agentRun({ cli: def.id, model: '' }, settings)
  const tierRun = (t: ModelTier) => agentRun({ cli: def.id, model: `@${t}` }, settings)
  const modelOptions = [
    { value: '', label: base.model ? `默认 · ${base.model}` : '默认模型' },
    ...MODEL_TIERS.map((t) => ({
      value: `@${t.id}`,
      label: `${t.label}档 · ${tierRun(t.id).model || 'CLI 默认'}`,
      group: '档位',
    })),
    ...def.models.map((m) => ({ value: m.id, label: m.id, group: '模型' })),
  ]
  if (model && !modelOptions.some((o) => o.value === model))
    modelOptions.push({ value: model, label: model, group: '模型' })
  // 思考强度「跟随」时显示跟着模型或档位得到的值
  const follow = agentRun({ cli: def.id, model }, settings).effort
  const compact =
    'h-7 w-auto max-w-[170px] gap-1 rounded-md border-transparent bg-transparent px-2 text-[12px] text-muted shadow-none hover:bg-sel hover:text-fg'
  return (
    <div
      className="flex min-w-0 items-center gap-0.5"
      title={`这次用 ${run.model || 'CLI 默认模型'}${run.effort ? ` · ${effortLabel(def, run.effort)}` : ''}`}
    >
      <Select
        aria-label="模型"
        value={model}
        onChange={(e) => onModel(e.target.value)}
        options={modelOptions}
        disabled={disabled}
        className={cn(compact, 'font-mono')}
      />
      {def.efforts.length > 0 && (
        <Select
          aria-label="思考强度"
          value={effort}
          onChange={(e) => onEffort(e.target.value)}
          disabled={disabled}
          className={compact}
          options={[
            { value: '', label: follow ? `思考 · ${effortLabel(def, follow)}` : '思考 · CLI 默认' },
            ...def.efforts.map((e) => ({ value: e.id, label: `思考 · ${e.label}` })),
          ]}
        />
      )}
      {!cs.enabled && <span className="text-[11px] text-warning">已停用</span>}
    </div>
  )
}

/**
 * 用本机 CLI 对话生成 / 优化 Agent 或工作流。左边对话，右边预览最新的结果，确认后应用。
 */
export function AssistDialog({
  open,
  onOpenChange,
  kind,
  target,
  onApplied,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  kind: AssistKind
  /** 有值表示优化它，没有表示新建 */
  target?: Agent | Workflow
  onApplied: (r: { agent?: Agent; workflow?: Workflow }) => void
}) {
  const { clis, settings, categories, setAgents, setCategories, setWorkflows } = useData()
  const usable = clis.filter((c) => c.installed && c.enabled)
  const [cli, setCli] = useState('')
  // 这次生成用的模型和思考强度：默认跟设置走，可以在输入框下面临时调整
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const cliDef = useCliDef(cli)
  const pickCli = (id: string) => {
    setCli(id)
    setModel(id === settings?.assist.cli ? (settings?.assist.model ?? '') : '')
    setEffort('')
  }
  const [turns, setTurns] = useState<Turn[]>([])
  const [text, setText] = useState('')
  const [job, setJob] = useState<AssistJob | null>(null)
  const [applying, setApplying] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  // 中文和英文之间留空格：「创建 Agent」「生成的 Agent 会…」
  const what = kind === 'agent' ? ' Agent ' : '工作流'

  useEffect(() => {
    if (!open) return
    setTurns([])
    setText('')
    setJob(null)
    const pref = settings?.assist.cli
    pickCli(usable.find((c) => c.id === pref)?.id ?? usable[0]?.id ?? pref ?? CLIS[0].id)
  }, [open])

  // 生成中轮询
  useEffect(() => {
    if (!job || job.status !== 'running') return
    // 一次请求回来再发下一次；卸载或任务结束后到达的旧响应直接丢掉，不会重复追加或把结束的任务恢复成进行中
    let alive = true
    let t: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const j = await api.assistJob(job.id)
        if (!alive) return
        if (j.status === 'running') {
          setJob(j)
          t = setTimeout(poll, 600)
          return
        }
        alive = false
        setTurns((ts) => [
          ...ts,
          {
            role: 'assistant',
            text: j.text + (j.raw ? `\n\n\`\`\`json\n${j.raw}\n\`\`\`` : ''),
            proposal: j.proposal,
            error: j.error,
          },
        ])
        setJob(null)
      } catch (e) {
        if (!alive) return
        alive = false
        toast.error((e as Error).message)
        setJob(null)
      }
    }
    t = setTimeout(poll, 600)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [job?.id, job?.status === 'running'])

  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns, job?.text])

  const latest = useMemo(() => [...turns].reverse().find((t) => t.proposal)?.proposal, [turns])
  const running = !!job

  const send = async (msg = text) => {
    if (!msg.trim() || running) return
    const next: Turn[] = [...turns, { role: 'user', text: msg.trim() }]
    setTurns(next)
    setText('')
    try {
      setJob(
        await api.assist({
          kind,
          targetId: target?.id ?? '',
          cli,
          model,
          effort,
          messages: next.map(({ role, text }) => ({ role, text })),
        }),
      )
    } catch (e) {
      setTurns((ts) => [...ts, { role: 'assistant', text: '', error: (e as Error).message }])
    }
  }

  const stop = async () => {
    if (job) await api.stopAssist(job.id).catch(() => {})
  }

  const apply = async () => {
    if (!latest) return
    setApplying(true)
    try {
      const r = await applyProposal(latest, {
        categories,
        createCategory: (name) => api.createCategory(name),
        createAgent: (a) => api.createAgent(a),
      })
      if (r.categories.length) setCategories((cs) => [...cs, ...r.categories])
      if (r.created.length) setAgents((as) => [...as, ...r.created])
      if (r.agent) {
        const a = target ? await api.updateAgent(target.id, r.agent) : await api.createAgent(r.agent)
        setAgents((as) => (target ? as.map((x) => (x.id === a.id ? a : x)) : [...as, a]))
        toast.success(target ? `已更新「${a.name}」` : `已创建「${a.name}」`)
        onApplied({ agent: a })
      } else if (r.workflow) {
        const w = target ? await api.updateWorkflow(target.id, r.workflow) : await api.createWorkflow(r.workflow)
        setWorkflows((ws) => (target ? ws.map((x) => (x.id === w.id ? w : x)) : [...ws, w]))
        toast.success(
          `${target ? '已更新' : '已创建'}「${w.name}」${r.created.length ? `，并新建了 ${r.created.length} 个 Agent` : ''}`,
        )
        onApplied({ workflow: w })
      }
      onOpenChange(false)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setApplying(false)
    }
  }

  return (
    <D.Root open={open} onOpenChange={(o) => !running && onOpenChange(o)}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/50 animate-[fade-in_150ms_ease-out]" />
        <D.Content className="fixed inset-2 z-50 m-auto flex max-h-[860px] max-w-[1180px] flex-col overflow-hidden rounded-2xl border border-line-strong bg-bg shadow-2xl animate-[pop-in_160ms_ease-out] focus:outline-none md:inset-6">
          <header className="flex items-center gap-3 border-b bg-panel px-5 py-3.5">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-accent-soft text-accent">
              {target ? <Wand2 className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
            </span>
            <div className="min-w-0 flex-1">
              <D.Title className="truncate text-[15px] font-semibold">
                {target ? `用 AI 优化「${target.name}」` : `用 AI 创建${what.trimEnd()}`}
              </D.Title>
              <D.Description className="truncate text-xs text-subtle">
                本机 CLI 按固定格式生成{what.trimEnd()}，校验通过后在右侧预览，确认再应用
              </D.Description>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="关闭"
              disabled={running}
              onClick={() => onOpenChange(false)}
            >
              <X className="h-4 w-4" />
            </Button>
          </header>

          <div className="flex min-h-0 flex-1 flex-col md:flex-row">
            {/* 对话 */}
            <section className="flex min-h-0 flex-1 flex-col border-b md:max-w-[460px] md:border-r md:border-b-0">
              <div className="flex flex-wrap items-center gap-1.5 border-b px-4 py-2.5">
                <span className="mr-1 text-xs text-subtle">使用</span>
                {orderClis(CLIS, settings?.cliOrder ?? []).map((c) => {
                  const st = clis.find((x) => x.id === c.id)
                  const ok = !!st?.installed && st.enabled
                  return (
                    <button
                      key={c.id}
                      onClick={() => pickCli(c.id)}
                      aria-pressed={cli === c.id}
                      disabled={running}
                      title={ok ? st?.version : '未安装或已停用'}
                      className={cn(
                        'flex h-7 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-xs',
                        cli === c.id ? 'border-accent bg-accent-soft text-fg' : 'text-muted hover:text-fg',
                        !ok && 'opacity-50',
                      )}
                    >
                      <span className="h-1.5 w-1.5 rounded-full" style={{ background: cliColor(c.id) }} />
                      {c.name}
                    </button>
                  )
                })}
              </div>
              <div ref={scroller} className="flex min-h-[200px] flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
                {turns.length === 0 && !running && (
                  <div className="flex flex-col gap-2">
                    <p className="text-[13px] text-muted">
                      {target
                        ? `说说想怎么改，例如「角色设定再具体一些」「加一个代码审查阶段」。`
                        : `描述你想要的${what.trimEnd()}，越具体越好。可以从下面的例子开始：`}
                    </p>
                    {!target &&
                      EXAMPLES[kind].map((e) => (
                        <button
                          key={e}
                          onClick={() => send(e)}
                          className="cursor-pointer rounded-lg border bg-card px-3 py-2 text-left text-[13px] text-muted hover:border-accent hover:text-fg"
                        >
                          {e}
                        </button>
                      ))}
                  </div>
                )}
                {turns.map((t, i) =>
                  t.role === 'user' ? (
                    <div
                      key={i}
                      className="ml-auto max-w-[88%] rounded-2xl rounded-br-md border bg-sel px-3.5 py-2 text-[13px] leading-relaxed whitespace-pre-wrap"
                    >
                      {t.text}
                    </div>
                  ) : (
                    <div key={i} className="flex flex-col gap-1.5 text-[13px] leading-relaxed">
                      {t.text && <p className="whitespace-pre-wrap">{t.text.split('```')[0].trim()}</p>}
                      {t.proposal && (
                        <span className="flex items-center gap-1.5 text-xs text-success">
                          <Check className="h-3.5 w-3.5" />
                          格式校验通过，右侧是预览
                        </span>
                      )}
                      {t.error && (
                        <span className="flex items-start gap-1.5 text-xs text-danger whitespace-pre-wrap">
                          <CircleAlert className="mt-px h-3.5 w-3.5 shrink-0" />
                          {t.error}
                        </span>
                      )}
                    </div>
                  ),
                )}
                {job && <JobProgress job={job} cliName={CLIS.find((c) => c.id === cli)?.name ?? cli} />}
              </div>
              <div className="p-3">
                <div className="rounded-xl border border-line-strong bg-card focus-within:border-accent focus-within:ring-[3px] focus-within:ring-accent-soft">
                  <textarea
                    rows={2}
                    value={text}
                    aria-label="描述"
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                        e.preventDefault()
                        send()
                      }
                    }}
                    placeholder={latest ? '继续说要改的地方' : `描述你想要的${what.trimEnd()}`}
                    className="block max-h-40 w-full resize-none bg-transparent px-3.5 pt-2.5 text-[13px] leading-relaxed outline-none placeholder:text-subtle"
                  />
                  <div className="flex items-center px-2.5 pb-2">
                    {settings && cliDef && (
                      <RunPicker
                        def={cliDef}
                        settings={settings}
                        model={model}
                        effort={effort}
                        onModel={setModel}
                        onEffort={setEffort}
                        disabled={running}
                      />
                    )}
                    <span className="ml-2 hidden text-[11px] text-subtle sm:inline">Enter 发送</span>
                    {running ? (
                      <Button size="sm" variant="secondary" className="ml-auto" onClick={stop}>
                        <Square className="h-3 w-3 fill-current" />
                        停止
                      </Button>
                    ) : (
                      <Button
                        size="icon-sm"
                        className="ml-auto"
                        aria-label="发送"
                        disabled={!text.trim()}
                        onClick={() => send()}
                      >
                        <ArrowUp className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            </section>

            {/* 预览 */}
            <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-panel">
              <div className="flex-1 overflow-y-auto p-5">
                {latest ? (
                  latest.kind === 'agent' ? (
                    <AgentPreview
                      agent={latest.agent}
                      before={target as Agent | undefined}
                      newCategory={latest.newCategory}
                    />
                  ) : (
                    <WorkflowPreview p={latest} />
                  )
                ) : (
                  <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-2 text-center text-subtle">
                    <Sparkles className="h-6 w-6" />
                    <p className="text-[13px]">生成的{what}会显示在这里</p>
                  </div>
                )}
              </div>
              <footer className="flex items-center gap-2 border-t px-5 py-3">
                <span className="text-xs text-subtle">
                  {latest ? (target ? '应用后会覆盖当前内容' : '可以继续对话修改，满意后再创建') : ''}
                </span>
                <Button className="ml-auto" disabled={!latest || running || applying} onClick={apply}>
                  {applying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                  {target ? '应用修改' : `创建${what.trimEnd()}`}
                </Button>
              </footer>
            </section>
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}
