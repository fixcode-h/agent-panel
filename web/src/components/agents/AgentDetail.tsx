import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Copy, Sparkles, Trash2, Workflow as WorkflowIcon } from 'lucide-react'
import { DEFAULT_AGENT_ID, type Agent, type AgentInput } from '@shared/schema'
import { getCli, MODEL_TIERS } from '@shared/clis'
import {
  agentCli,
  agentPermission,
  agentRun,
  cliSettings,
  defaultSettings,
  supportsEffort,
  tierOf,
} from '@shared/settings'
import { api } from '@/lib/api'
import { useData, useNav } from '@/lib/data'
import { AGENT_ICONS } from '@/lib/agent-icons'
import { cliDefaultModel, defaultEffortOptions } from '@/lib/cli-style'
import { useCliDef } from '@/lib/cli-models'
import { agentChecks, isReady } from '@/lib/readiness'
import { useAutosave } from '@/lib/useAutosave'
import { cn, joinArgs, splitArgs } from '@/lib/utils'
import { Badge, StatusDot } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { AssistDialog } from '@/components/assist/AssistDialog'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Field, FormSection, Input, Select, Textarea } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Segmented } from '@/components/ui/segmented'
import { Checkbox } from '@/components/ui/checkbox'
import { Detail, DetailHeader } from '@/components/layout/Detail'
import { ReadinessCard } from '@/components/layout/ReadinessCard'
import { AgentAvatar } from './AgentAvatar'
import { CategoryPicker } from './CategoryPicker'
import { CommandPreview } from './CommandPreview'
import { t } from '@shared/i18n'

// 会改文件、执行任意命令、不用沙箱的权限，界面上标成警告色
const DANGER_PERMS = ['bypassPermissions', 'danger-full-access', 'yolo']

const toInput = ({ id, createdAt, updatedAt, ...rest }: Agent): AgentInput => rest

export function AgentDetail({
  agent,
  onDuplicate,
  onDeleted,
  deleteSignal = 0,
  onOptimized,
}: {
  agent: Agent
  onDuplicate: () => void
  onDeleted: () => void
  /** 列表右键「删除」时变化，打开删除确认 */
  deleteSignal?: number
  /** AI 优化写回后让页面重新加载草稿 */
  onOptimized: () => void
}) {
  const { clis, categories, workflows, setAgents, settings } = useData()
  const { go } = useNav()
  const [draft, setDraft] = useState<AgentInput>(() => toInput(agent))
  const [args, setArgs] = useState(() => joinArgs(agent.extraArgs))
  const [deleting, setDeleting] = useState(false)
  useEffect(() => {
    if (deleteSignal) setDeleting(true)
  }, [deleteSignal])
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
  // 模型和思考强度用本机 CLI 实际支持的（读不到时是内置建议）
  const cliDef = useCliDef(cliId)
  // 不看 Agent 自己的思考强度，得到「跟随设置」时的值
  const run = agentRun({ ...draft, effort: '' }, s)
  const defCli = agentCli({ cli: '' }, s)
  // 不指定思考强度时实际用的：档位或设置给的，其次是模型自己的默认
  const usedModel = agentRun(draft, s).model || cliDefaultModel(cliDef ?? getCli(cliId)!)?.id
  const permId = agentPermission(draft, s)
  const perm = (cliDef ?? getCli(cliId))?.permissions.find((p) => p.id === permId) ?? { id: permId, hint: '' }
  const defEffort = run.effort || cliDef?.models.find((m) => m.id === usedModel)?.defaultEffort || ''
  // 换 CLI 时保留档位；思考强度新 CLI 支持就保留；权限各 CLI 不通用，回到跟随设置
  const pickCli = (id: string) =>
    draft.cli !== id &&
    setDraft((d) => ({
      ...d,
      cli: id,
      model: tierOf(d.model) ? d.model : '@medium',
      effort: d.effort && supportsEffort(id || defCli, d.effort) ? d.effort : '',
      permission: '',
    }))
  const follow = !draft.cli
  const builtin = agent.id === DEFAULT_AGENT_ID
  // 模型只能选三档；以前存的具体模型名单独列一项，换成档位后就不再出现
  const tierOptions = [
    ...MODEL_TIERS.map((m) => ({
      value: `@${m.id}`,
      label: t('{tier}档 · {model}', { tier: m.label, model: cs.tiers[m.id].model || t('自动') }),
    })),
    ...(draft.model && !tierOf(draft.model)
      ? [{ value: draft.model, label: t('{model}（旧设置，请换成档位）', { model: draft.model }) }]
      : !draft.model
        ? [{ value: '', label: t('默认模型 · {model}（旧设置，请换成档位）', { model: usedModel || t('自动') }) }]
        : []),
  ]
  const live = { ...agent, ...value }
  const checks = agentChecks(live, cli)
  const category = categories.find((c) => c.id === draft.categoryId)
  const usedIn = workflows
    .map((w) => ({
      w,
      role:
        w.mainAgentId === agent.id
          ? t('主 Agent')
          : w.members.some((m) => m.agentId === agent.id)
            ? t('子 Agent')
            : w.flows.some((f) => f.nodes.some((n) => n.agentId === agent.id))
              ? t('节点执行者')
              : '',
    }))
    .filter((x) => x.role)

  const remove = async () => {
    try {
      await api.deleteAgent(agent.id)
      setAgents((as) => as.filter((a) => a.id !== agent.id))
      toast.success(t('已删除「{name}」', { name: agent.name }))
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
            title={draft.name || t('未命名 Agent')}
            meta={
              <>
                <Badge>{builtin ? t('默认') : (category?.name ?? t('未分类'))}</Badge>
                {!draft.enabled ? (
                  <StatusDot tone="muted" label={t('已停用')} />
                ) : isReady(checks) ? (
                  <StatusDot tone="success" label={t('就绪')} />
                ) : (
                  <StatusDot tone="warning" label={t('CLI 未安装')} />
                )}
              </>
            }
            subtitle={draft.description || t('还没有简介')}
            save={{ ...save, invalid: valid ? undefined : t('名称为空，未保存') }}
            actions={
              <>
                {!builtin && (
                  <label className="flex h-9 cursor-pointer items-center gap-2 px-2 text-[13px] text-muted">
                    <Switch checked={draft.enabled} onCheckedChange={(v) => set('enabled', v)} />
                    {t('启用')}
                  </label>
                )}
                <Button variant="secondary" onClick={() => setAssist(true)} title={t('让本机 CLI 按你的要求优化')}>
                  <Sparkles className="h-4 w-4 text-accent" />
                  {t('AI 优化')}
                </Button>
                <Button
                  variant="secondary"
                  size="icon"
                  aria-label={t('复制一份')}
                  title={t('复制一份')}
                  onClick={onDuplicate}
                >
                  <Copy className="h-4 w-4" />
                </Button>
                {!builtin && (
                  <Button
                    variant="danger-outline"
                    size="icon"
                    aria-label={t('删除')}
                    title={t('删除')}
                    onClick={() => setDeleting(true)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </>
            }
          />
        }
        form={
          <>
            <FormSection title={t('基本信息')}>
              <div className="flex flex-wrap gap-4">
                <Field label={t('名称')} className="flex-[1_1_200px]" error={valid ? undefined : t('名称不能为空')}>
                  <Input
                    value={draft.name}
                    onChange={(e) => set('name', e.target.value)}
                    placeholder={t('例如：前端开发')}
                  />
                </Field>
                {!builtin && (
                  <div className="flex min-w-0 flex-[1_1_200px] flex-col gap-1.5">
                    <span className="text-xs text-muted">{t('分类')}</span>
                    <CategoryPicker value={draft.categoryId} onChange={(id) => set('categoryId', id)} />
                  </div>
                )}
              </div>
              <Field label={t('简介')}>
                <Input
                  value={draft.description}
                  onChange={(e) => set('description', e.target.value)}
                  placeholder={t('一句话说明它擅长什么')}
                />
              </Field>
              <div className="flex flex-col gap-1.5">
                <span className="text-xs text-muted">{t('图标')}</span>
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

            <FormSection title={t('运行环境')}>
              {builtin ? (
                <p className="rounded-lg border bg-field px-3 py-2.5 text-[13px] leading-relaxed text-muted">
                  {t(
                    '自带的默认 Agent 固定使用默认 CLI 的默认模型和思考强度，现在是 {cli} · {model} · {effort}。在设置里换默认 CLI 或默认模型时跟着变，对话时可以在输入框旁边临时换模型和思考强度。',
                    {
                      cli: clis.find((c) => c.id === defCli)?.name ?? defCli,
                      model: usedModel || t('自动'),
                      effort: defEffort || t('自动'),
                    },
                  )}
                </p>
              ) : (
                <>
                  <Checkbox
                    checked={follow}
                    onChange={(v) => pickCli(v ? '' : defCli)}
                    label={t('跟随默认 CLI（现在是 {cli}）', {
                      cli: clis.find((c) => c.id === defCli)?.name ?? defCli,
                    })}
                    hint={t(
                      '在设置里换了默认 CLI，这个 Agent 也跟着换，模型换成新 CLI 同一档位的模型。取消后可以固定用某个 CLI。',
                    )}
                  />
                  <div className="flex flex-wrap gap-4">
                    <Field label="CLI" className="flex-[1_1_220px]">
                      <Select
                        aria-label="CLI"
                        value={cliId}
                        disabled={follow}
                        onChange={(e) => pickCli(e.target.value)}
                        // 停用或没安装的 CLI 不给选；当前选着的照常显示，并标出原因
                        options={clis
                          .filter((c) => (c.installed && c.enabled) || c.id === cliId)
                          .map((c) => ({
                            value: c.id,
                            label:
                              (c.id === defCli ? t('{name}（默认）', { name: c.name }) : c.name) +
                              (!c.installed ? ` · ${t('未安装')}` : c.enabled ? '' : ` · ${t('已停用')}`),
                          }))}
                      />
                    </Field>
                    <Field
                      label={t('模型')}
                      className="flex-[2_1_280px]"
                      hint={t('三档对应的模型在设置里每个 CLI 下配置')}
                    >
                      <Select
                        aria-label={t('模型')}
                        value={draft.model}
                        onChange={(e) => set('model', e.target.value)}
                        options={tierOptions}
                        className="font-mono text-[13px]"
                      />
                    </Field>
                  </div>
                  {cliDef && (
                    <Field
                      label={t('思考强度')}
                      hint={t('越高想得越久、越慢。选档位时默认用档位的思考强度。')}
                      className="max-w-[320px]"
                    >
                      <Select
                        aria-label={t('思考强度')}
                        value={draft.effort === defEffort ? '' : draft.effort}
                        onChange={(e) => set('effort', e.target.value)}
                        options={defaultEffortOptions(cliDef, defEffort)}
                      />
                    </Field>
                  )}
                </>
              )}
              {cliDef && (
                <Field
                  label={t('权限')}
                  hint={
                    <span
                      className={cn(
                        // 按权限 id 判断，提示文字翻译成英文后正则就匹配不上了
                        (DANGER_PERMS.includes(perm.id) || /任意命令|不使用沙箱/.test(perm.hint)) && 'text-warning',
                      )}
                    >
                      {perm.hint}
                    </span>
                  }
                >
                  <div>
                    <Segmented
                      label={t('权限')}
                      // CLI 设置里的权限标（默认），选它就是跟随设置
                      value={perm.id === cs.permission ? '' : perm.id}
                      onChange={(v) => set('permission', v)}
                      options={cliDef.permissions.map((p) => ({
                        id: p.id === cs.permission ? '' : p.id,
                        label: p.id === cs.permission ? t('{name}（默认）', { name: p.label }) : p.label,
                      }))}
                    />
                  </div>
                </Field>
              )}
            </FormSection>

            <FormSection title={t('行为')}>
              <Field label={t('角色设定')} hint={t('执行任务时会作为前置说明交给这个 Agent。')}>
                <Textarea
                  rows={5}
                  value={draft.instructions}
                  onChange={(e) => set('instructions', e.target.value)}
                  placeholder={t('例如：你是资深前端工程师，负责按照设计稿实现页面，完成后运行测试并汇报结果。')}
                />
              </Field>
              <Field label={t('额外参数')} hint={t('追加给 CLI 的参数，用空格分隔，含空格的值用引号包住。')}>
                <Input
                  value={args}
                  onChange={(e) => setArgs(e.target.value)}
                  placeholder={t('例如：--add-dir ../shared')}
                  className="font-mono text-[13px]"
                />
              </Field>
            </FormSection>
          </>
        }
        aside={
          <>
            <CommandPreview
              cli={draft.cli}
              model={draft.model}
              effort={draft.effort}
              permission={draft.permission}
              extraArgs={value.extraArgs}
            />
            <ReadinessCard checks={checks} />
            <section className="flex flex-col gap-2 rounded-xl border bg-card p-4">
              <h3 className="text-[13px] font-semibold">{t('所在工作流')}</h3>
              {usedIn.length === 0 && <p className="text-xs text-subtle">{t('还没有工作流使用它。')}</p>}
              {usedIn.map(({ w, role }) => (
                <button
                  key={w.id}
                  onClick={() => go({ page: 'workflows', id: w.id })}
                  className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-sel"
                >
                  <WorkflowIcon className="h-4 w-4 text-subtle" />
                  <span className="flex-1 truncate">{w.name}</span>
                  <Badge tone={role === t('主 Agent') ? 'accent' : 'neutral'}>{role}</Badge>
                </button>
              ))}
            </section>
          </>
        }
      />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t('删除「{name}」？', { name: agent.name })}
        description={t('删除后无法恢复。')}
        blocked={
          usedIn.length
            ? t('它正在被工作流 {names} 使用，需要先从这些工作流中移除才能删除。', {
                names: usedIn.map(({ w }) => t('「{name}」', { name: w.name })).join(t('、')),
              })
            : undefined
        }
        onConfirm={remove}
      />
      <AssistDialog open={assist} onOpenChange={setAssist} kind="agent" target={agent} onApplied={onOptimized} />
    </>
  )
}
