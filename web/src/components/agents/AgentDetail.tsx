import { useState } from 'react'
import { toast } from 'sonner'
import { Copy, Settings2, Sparkles, Trash2, Workflow as WorkflowIcon } from 'lucide-react'
import type { Agent, AgentInput } from '@shared/schema'
import { MODEL_TIERS, getCli } from '@shared/clis'
import { agentCli, agentRun, cliSettings, defaultSettings, tierOf, tierToken } from '@shared/settings'
import { api } from '@/lib/api'
import { useData, useNav } from '@/lib/data'
import { AGENT_ICONS } from '@/lib/agent-icons'
import { cliColor, effortLabel, effortOptions } from '@/lib/cli-style'
import { useCliDef } from '@/lib/cli-models'
import { agentChecks, isReady } from '@/lib/readiness'
import { useAutosave } from '@/lib/useAutosave'
import { cn, joinArgs, splitArgs } from '@/lib/utils'
import { Badge, StatusDot } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { AssistDialog } from '@/components/assist/AssistDialog'
import { ConfirmDialog } from '@/components/ui/dialog'
import { ComboInput, Field, FormSection, Input, Select, Textarea } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Detail, DetailHeader } from '@/components/layout/Detail'
import { ReadinessCard } from '@/components/layout/ReadinessCard'
import { AgentAvatar } from './AgentAvatar'
import { CategoryPicker } from './CategoryPicker'
import { CommandPreview } from './CommandPreview'

const toInput = ({ id, createdAt, updatedAt, ...rest }: Agent): AgentInput => rest

/** 选择项卡片：CLI 选择用 */
function OptionCard({
  selected,
  onClick,
  children,
}: {
  selected: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        'flex flex-[1_1_200px] cursor-pointer items-center gap-3 rounded-[10px] border border-line-strong bg-card p-3 text-left transition-shadow',
        selected && 'border-accent ring-[3px] ring-accent-soft',
      )}
    >
      {children}
    </button>
  )
}

export function AgentDetail({
  agent,
  onDuplicate,
  onDeleted,
  onOptimized,
}: {
  agent: Agent
  onDuplicate: () => void
  onDeleted: () => void
  /** AI 优化写回后让页面重新加载草稿 */
  onOptimized: () => void
}) {
  const { clis, categories, workflows, setAgents, settings } = useData()
  const { go } = useNav()
  const [draft, setDraft] = useState<AgentInput>(() => toInput(agent))
  const [args, setArgs] = useState(() => joinArgs(agent.extraArgs))
  const [deleting, setDeleting] = useState(false)
  const [assist, setAssist] = useState(false)

  const value = { ...draft, extraArgs: splitArgs(args) }
  const valid = !!draft.name.trim()
  const save = useAutosave(
    value,
    async (v) => {
      const saved = await api.updateAgent(agent.id, v)
      setAgents((as) => as.map((a) => (a.id === saved.id ? saved : a)))
    },
    valid,
  )

  const set = <K extends keyof AgentInput>(k: K, v: AgentInput[K]) => setDraft((d) => ({ ...d, [k]: v }))
  const s = settings ?? defaultSettings()
  const cliId = agentCli(draft, s)
  const cli = clis.find((c) => c.id === cliId)
  const cs = cliSettings(s, cliId)
  const defaultModel = cs.defaultModel
  // 模型和思考强度用本机 CLI 实际支持的（读不到时是内置建议）
  const cliDef = useCliDef(cliId)
  // 不看 Agent 自己的思考强度，得到「跟随设置」时的值
  const run = agentRun({ ...draft, effort: '' }, s)
  const tier = tierOf(draft.model)
  // 换 CLI 时保留档位，具体模型名不通用所以清空
  const pickCli = (id: string) =>
    draft.cli !== id && setDraft((d) => ({ ...d, cli: id, model: tierOf(d.model) ? d.model : '', effort: '' }))
  const live = { ...agent, ...value }
  const checks = agentChecks(live, cli)
  const category = categories.find((c) => c.id === draft.categoryId)
  const usedIn = workflows
    .map((w) => ({
      w,
      role:
        w.mainAgentId === agent.id
          ? '主 Agent'
          : w.members.some((m) => m.agentId === agent.id)
            ? '子 Agent'
            : w.flows.some((f) => f.nodes.some((n) => n.agentId === agent.id))
              ? '节点执行者'
              : '',
    }))
    .filter((x) => x.role)

  const remove = async () => {
    try {
      await api.deleteAgent(agent.id)
      setAgents((as) => as.filter((a) => a.id !== agent.id))
      toast.success(`已删除「${agent.name}」`)
      onDeleted()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <>
      <Detail
        header={
          <DetailHeader
            leading={<AgentAvatar icon={draft.icon} cli={draft.cli} size="lg" dim={!draft.enabled} />}
            title={draft.name || '未命名 Agent'}
            meta={
              <>
                <Badge>{category?.name ?? '未分类'}</Badge>
                {!draft.enabled ? (
                  <StatusDot tone="muted" label="已停用" />
                ) : isReady(checks) ? (
                  <StatusDot tone="success" label="就绪" />
                ) : (
                  <StatusDot tone="warning" label="CLI 未安装" />
                )}
              </>
            }
            subtitle={draft.description || '还没有简介'}
            save={{ ...save, invalid: valid ? undefined : '名称为空，未保存' }}
            actions={
              <>
                <label className="flex h-9 cursor-pointer items-center gap-2 px-2 text-[13px] text-muted">
                  <Switch checked={draft.enabled} onCheckedChange={(v) => set('enabled', v)} />
                  启用
                </label>
                <Button variant="secondary" onClick={() => setAssist(true)} title="让本机 CLI 按你的要求优化">
                  <Sparkles className="h-4 w-4 text-accent" />
                  AI 优化
                </Button>
                <Button variant="secondary" size="icon" aria-label="复制" title="复制" onClick={onDuplicate}>
                  <Copy className="h-4 w-4" />
                </Button>
                <Button
                  variant="danger-outline"
                  size="icon"
                  aria-label="删除"
                  title="删除"
                  onClick={() => setDeleting(true)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </>
            }
          />
        }
        form={
          <>
            <FormSection title="基本信息">
              <div className="flex flex-wrap gap-4">
                <Field label="名称" className="flex-[1_1_200px]" error={valid ? undefined : '名称不能为空'}>
                  <Input
                    value={draft.name}
                    onChange={(e) => set('name', e.target.value)}
                    placeholder="例如：前端开发"
                  />
                </Field>
                <div className="flex min-w-0 flex-[1_1_200px] flex-col gap-1.5">
                  <span className="text-xs text-muted">分类</span>
                  <CategoryPicker value={draft.categoryId} onChange={(id) => set('categoryId', id)} />
                </div>
              </div>
              <Field label="简介">
                <Input
                  value={draft.description}
                  onChange={(e) => set('description', e.target.value)}
                  placeholder="一句话说明它擅长什么"
                />
              </Field>
              <div className="flex flex-col gap-1.5">
                <span className="text-xs text-muted">图标</span>
                <div className="flex flex-wrap gap-1.5">
                  {AGENT_ICONS.map(({ id, label, icon: Icon }) => (
                    <button
                      type="button"
                      key={id}
                      aria-label={label}
                      title={label}
                      onClick={() => set('icon', id)}
                      className={cn(
                        'grid h-9 w-9 cursor-pointer place-items-center rounded-lg border border-line-strong bg-field text-muted transition-colors hover:text-fg',
                        draft.icon === id && 'border-accent bg-accent-soft text-accent hover:text-accent',
                      )}
                    >
                      <Icon className="h-[18px] w-[18px]" strokeWidth={1.8} />
                    </button>
                  ))}
                </div>
              </div>
            </FormSection>

            <FormSection title="运行环境">
              <div className="flex flex-col gap-1.5">
                <span className="text-xs text-muted">CLI</span>
                <div className="flex flex-wrap gap-2.5">
                  <OptionCard selected={!draft.cli} onClick={() => pickCli('')}>
                    <span
                      className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-white"
                      style={{ background: cliColor(agentCli({ cli: '' }, s)) }}
                    >
                      <Settings2 className="h-4 w-4" />
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span className="font-medium">系统默认</span>
                      <span className="truncate text-xs text-subtle">
                        当前：{getCli(agentCli({ cli: '' }, s))?.name}，在设置里切换
                      </span>
                    </span>
                  </OptionCard>
                  {clis.map((c) => (
                    <OptionCard key={c.id} selected={draft.cli === c.id} onClick={() => pickCli(c.id)}>
                      <span className="h-8 w-8 shrink-0 rounded-lg" style={{ background: cliColor(c.id) }} />
                      <span className="flex min-w-0 flex-col">
                        <span className="font-medium">{c.name}</span>
                        <span
                          className={cn('truncate text-xs', c.enabled && c.installed ? 'text-success' : 'text-warning')}
                        >
                          {!c.enabled
                            ? '已在设置中停用'
                            : c.installed
                              ? `已安装 · ${c.version?.split(' ')[0] ?? ''}`
                              : '本机未检测到'}
                        </span>
                      </span>
                    </OptionCard>
                  ))}
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-xs text-muted">模型档位</span>
                <div role="radiogroup" aria-label="模型档位" className="grid grid-cols-3 gap-2">
                  {MODEL_TIERS.map((t) => {
                    const on = tier?.id === t.id
                    return (
                      <button
                        key={t.id}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        title={t.hint}
                        onClick={() => set('model', on ? '' : tierToken(t.id))}
                        className={cn(
                          'flex min-w-0 cursor-pointer flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left transition-colors',
                          on ? 'border-accent bg-accent-soft' : 'bg-field hover:border-line-strong',
                        )}
                      >
                        <span className={cn('text-[13px] font-medium', on ? 'text-accent' : 'text-fg')}>
                          {t.label}档 <span className="font-normal text-subtle">· {t.hint}</span>
                        </span>
                        <span className="w-full truncate font-mono text-xs text-muted">
                          {cs.tiers[t.id].model || 'CLI 默认'}
                          {cs.tiers[t.id].effort && (
                            <span className="text-subtle"> · {effortLabel(cliDef, cs.tiers[t.id].effort)}</span>
                          )}
                        </span>
                      </button>
                    )
                  })}
                </div>
                <span className="text-xs text-subtle">
                  选档位后，执行时按设置里 {cli?.name ?? cliId} 的档位换成具体模型；换 CLI 也会跟着换。
                </span>
              </div>
              <Field label="或指定模型">
                <ComboInput
                  aria-label="模型名"
                  suggestions={(cliDef?.models ?? []).map((m) => ({ value: m.id, label: m.label }))}
                  value={tier ? '' : draft.model}
                  onChange={(v) => set('model', v)}
                  spellCheck={false}
                  placeholder={
                    tier
                      ? `已选${tier.label}档：${cs.tiers[tier.id].model}，填写会改为指定模型`
                      : defaultModel
                        ? `留空使用设置里的默认模型：${defaultModel}`
                        : '留空使用 CLI 默认模型'
                  }
                  className="font-mono text-[13px]"
                />
              </Field>
              {cliDef && (
                <Field
                  label="思考强度"
                  hint="越高想得越久、越慢。不指定时用档位的设置，再没有就用 CLI 的默认。"
                  className="max-w-[320px]"
                >
                  <Select
                    value={draft.effort}
                    onChange={(e) => set('effort', e.target.value)}
                    options={effortOptions(
                      cliDef,
                      run.effort ? `跟随设置 · ${effortLabel(cliDef, run.effort)}` : '跟随设置 · CLI 默认',
                    )}
                  />
                </Field>
              )}
            </FormSection>

            <FormSection title="行为">
              <Field label="角色设定" hint="执行任务时会作为前置说明交给这个 Agent。">
                <Textarea
                  rows={5}
                  value={draft.instructions}
                  onChange={(e) => set('instructions', e.target.value)}
                  placeholder="例如：你是资深前端工程师，负责按照设计稿实现页面，完成后运行测试并汇报结果。"
                />
              </Field>
              <Field label="额外参数" hint="追加给 CLI 的参数，用空格分隔，含空格的值用引号包住。">
                <Input
                  value={args}
                  onChange={(e) => setArgs(e.target.value)}
                  placeholder="例如：--permission-mode acceptEdits"
                  className="font-mono text-[13px]"
                />
              </Field>
            </FormSection>
          </>
        }
        aside={
          <>
            <CommandPreview cli={draft.cli} model={draft.model} effort={draft.effort} extraArgs={value.extraArgs} />
            <ReadinessCard checks={checks} />
            <section className="flex flex-col gap-2 rounded-xl border bg-card p-4">
              <h3 className="text-[13px] font-semibold">所在工作流</h3>
              {usedIn.length === 0 && <p className="text-xs text-subtle">还没有工作流使用它。</p>}
              {usedIn.map(({ w, role }) => (
                <button
                  key={w.id}
                  onClick={() => go({ page: 'workflows', id: w.id })}
                  className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-sel"
                >
                  <WorkflowIcon className="h-4 w-4 text-subtle" />
                  <span className="flex-1 truncate">{w.name}</span>
                  <Badge tone={role === '主 Agent' ? 'accent' : 'neutral'}>{role}</Badge>
                </button>
              ))}
            </section>
          </>
        }
      />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`删除「${agent.name}」？`}
        description="删除后无法恢复。"
        blocked={
          usedIn.length
            ? `它正在被工作流 ${usedIn.map(({ w }) => `「${w.name}」`).join('、')} 使用，需要先从这些工作流中移除才能删除。`
            : undefined
        }
        onConfirm={remove}
      />
      <AssistDialog open={assist} onOpenChange={setAssist} kind="agent" target={agent} onApplied={onOptimized} />
    </>
  )
}
