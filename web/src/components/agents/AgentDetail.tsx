import { subAgentIds } from '@shared/flow'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  AlertTriangle,
  Braces,
  Copy,
  GitBranch,
  GripVertical,
  MessageSquare,
  Plus,
  Sparkles,
  Trash2,
  Workflow as WorkflowIcon,
  X,
} from 'lucide-react'
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
import { cliDefaultModel, defaultEffortOptions, modelEfforts } from '@/lib/cli-style'
import { useCliDef } from '@/lib/cli-models'
import { agentChecks, isReady } from '@/lib/readiness'
import { useAutosave } from '@/lib/useAutosave'
import { cn, joinArgs, splitArgs } from '@/lib/utils'
import { moveItem, useDragSort } from '@/lib/useDragSort'
import { Badge, StatusDot } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { AssistDialog } from '@/components/assist/AssistDialog'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Field, FormSection, Input, Select } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Segmented } from '@/components/ui/segmented'
import { Checkbox } from '@/components/ui/checkbox'
import { Detail, DetailHeader } from '@/components/layout/Detail'
import { ReadinessCard } from '@/components/layout/ReadinessCard'
import { AgentAvatar } from './AgentAvatar'
import { CategoryPicker } from './CategoryPicker'
import { CommandPreview } from './CommandPreview'
import { t } from '@shared/i18n'
import {
  MAX_INCLUDE_DEPTH,
  composeRole,
  cycleText,
  includeCycle,
  includeDepth,
  includeTree,
  wouldCycle,
} from '@shared/agent-role'
import { DocEditor } from '@/components/workflows/DocEditor'
import { Popover, PopoverClose, PopoverContent, PopoverTrigger, menuItem } from '@/components/ui/menu'
import { TagPicker } from '@/components/tags/Tags'
import { AgentPicker } from './AgentPicker'
import { ParamsEditor } from './ParamFields'
import { SkillsPicker, StartersEditor } from './AgentExtras'

/** 角色设定的模板 */
const ROLE_TEMPLATE = `# 角色
你是……，负责……

# 工作方式
- 先……，再……
- 遇到……时……

# 输出要求
- 完成后用中文简要总结做了什么、改了哪些文件
`

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
  const { clis, categories, workflows, agents, setAgents, settings } = useData()
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
  // 可以引入的：不是自己、还没引入、引入后不会绕回自己
  const includable = agents.filter(
    (a) => a.id !== agent.id && !draft.includes.includes(a.id) && !wouldCycle(agent.id, a.id, agents),
  )
  const include = (id: string) =>
    !draft.includes.includes(id) && !wouldCycle(agent.id, id, agents) && set('includes', [...draft.includes, id])
  const includedBy = agents.filter((a) => a.includes.includes(agent.id))
  // 按草稿算：改了引入马上看到层级、循环和对引入它的 Agent 的影响
  const withLive = agents.map((a) => (a.id === agent.id ? live : a))
  const tree = includeTree(live, withLive)
  const depth = tree.reduce((m, r) => Math.max(m, r.depth), 0)
  const tooDeep = tree.filter((r) => r.depth > MAX_INCLUDE_DEPTH && !r.cycle)
  const cycle = includeCycle(live, withLive)
  const deepParents = includedBy
    .map((a) => ({ a, depth: includeDepth(a, withLive) }))
    .filter((x) => x.depth > MAX_INCLUDE_DEPTH)
  const sortIncludes = useDragSort((from, to) => set('includes', moveItem(draft.includes, from, to)))
  const preview = composeRole(live, agents)
  const startChat = () => go({ page: 'chat' })
  const checks = agentChecks(live, cli)
  const category = categories.find((c) => c.id === draft.categoryId)
  const usedIn = workflows
    .map((w) => ({
      w,
      role: w.mainAgentId === agent.id ? t('主 Agent') : subAgentIds(w).includes(agent.id) ? t('子 Agent') : '',
    }))
    .filter((x) => x.role)

  const remove = async () => {
    try {
      await api.deleteAgent(agent.id)
      setAgents((as) =>
        as
          .filter((a) => a.id !== agent.id)
          .map((a) =>
            a.includes.includes(agent.id) ? { ...a, includes: a.includes.filter((x) => x !== agent.id) } : a,
          ),
      )
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
                {draft.common && <Badge tone="accent">{t('通用')}</Badge>}
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
                  <label className="flex h-9 cursor-pointer items-center gap-2 px-2 text-[0.8125rem] text-muted">
                    <Switch checked={draft.enabled} onCheckedChange={(v) => set('enabled', v)} />
                    {t('启用')}
                  </label>
                )}
                <Button
                  variant="secondary"
                  onClick={startChat}
                  disabled={!draft.enabled}
                  title={t('用这个 Agent 开一个新对话')}
                >
                  <MessageSquare className="h-4 w-4" />
                  {t('对话')}
                </Button>
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
              {!builtin && (
                <Checkbox
                  checked={draft.common}
                  onChange={(v) => set('common', v)}
                  label={t('通用 Agent')}
                  hint={t('工作流里任何 Agent 执行时都可以把子任务派给它，不用写进工作流。')}
                />
              )}
              <div className="flex flex-col gap-1.5">
                <span className="text-xs text-muted">{t('标签')}</span>
                <TagPicker value={draft.tags} onChange={(v) => set('tags', v)} />
              </div>
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
                <p className="rounded-lg border bg-field px-3 py-2.5 text-[0.8125rem] leading-relaxed text-muted">
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
                        className="font-mono text-[0.8125rem]"
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
                        // 只列这个模型支持的强度：模型不认的强度 CLI 会启动即报错退出
                        options={defaultEffortOptions(cliDef, defEffort, modelEfforts(cliDef, usedModel ?? ''))}
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

            <FormSection title={t('角色设定')}>
              <p className="-mt-2 text-xs leading-relaxed text-subtle">
                {t(
                  '和工作流说明一样用 Markdown 写清楚它是谁、怎么做事、输出什么，执行时作为前置说明交给它。可以用 {{参数名}} 引用参数，用 {{#if 参数名=值}}…{{else}}…{{/if}} 按参数走不同的做法。',
                )}
              </p>
              <DocEditor
                value={draft.instructions}
                onChange={(v) => set('instructions', v)}
                team={includable.concat(agents.filter((a) => draft.includes.includes(a.id)))}
                onTemplate={() => ROLE_TEMPLATE}
                label={t('角色设定')}
                placeholder={t(
                  '例如：\n# 角色\n你是资深前端工程师，负责按照设计稿实现页面。\n\n# 输出要求\n完成后运行测试并汇报结果。',
                )}
                mentionHint={t('插入 Agent 名称，并引入它的角色设定')}
                onMention={(a) => include(a.id)}
                minHeight={300}
                tools={(insert) => (
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button variant="ghost" size="sm">
                        <Braces className="h-3.5 w-3.5" />
                        {t('插入参数')}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent align="end" className="w-[260px]">
                      {draft.params.map((p) => (
                        <PopoverClose key={p.key} className={menuItem} onClick={() => insert(`{{${p.key}}}`)}>
                          <code className="font-mono text-[0.75rem] text-accent">{`{{${p.key}}}`}</code>
                          <span className="truncate text-subtle">{p.label}</span>
                        </PopoverClose>
                      ))}
                      {draft.params.length > 0 && (
                        <PopoverClose
                          className={menuItem}
                          onClick={() =>
                            insert(
                              `{{#if ${draft.params[0].key}=${draft.params[0].options[0] ?? '值'}}}\n\n{{else}}\n\n{{/if}}`,
                            )
                          }
                        >
                          <GitBranch className="h-3.5 w-3.5 text-subtle" />
                          {t('按参数分支')}
                        </PopoverClose>
                      )}
                      {!draft.params.length && (
                        <p className="px-2.5 py-2 text-xs text-subtle">{t('还没有参数，先在下面的「参数」里添加')}</p>
                      )}
                    </PopoverContent>
                  </Popover>
                )}
              />
              <div className="flex flex-col gap-2">
                <span className="text-xs text-muted">{t('引入的 Agent')}</span>
                <p className="-mt-1 text-[0.71875rem] leading-relaxed text-subtle">
                  {t('引入的 Agent 的角色设定会一起交给这个 Agent，可以把通用的规范、领域知识做成单独的 Agent 复用。')}
                </p>
                <div className="flex flex-wrap items-center gap-1.5">
                  {draft.includes.map((id, i) => {
                    const a = agents.find((x) => x.id === id)
                    return (
                      <span
                        key={id}
                        {...sortIncludes.itemProps(i, draft.includes.length)}
                        tabIndex={0}
                        title={t('拖动调整顺序（也可以按 Alt + 方向键），越靠前的设定越先交给它')}
                        className={cn(
                          'group inline-flex h-8 cursor-grab items-center gap-1 rounded-lg border bg-card pr-1 pl-1 text-[0.8125rem] outline-none select-none focus-visible:border-focus active:cursor-grabbing',
                          sortIncludes.drag === i && 'opacity-40',
                          sortIncludes.over === i &&
                            sortIncludes.drag !== null &&
                            sortIncludes.drag !== i &&
                            'border-accent bg-accent/10',
                          cycle[1] === id && 'border-danger/60',
                        )}
                      >
                        <GripVertical className="h-3.5 w-3.5 shrink-0 text-subtle opacity-60 group-hover:opacity-100" />
                        {a ? (
                          <button
                            type="button"
                            draggable={false}
                            className="flex cursor-pointer items-center gap-1.5 hover:text-accent"
                            onClick={() => go({ page: 'agents', id: a.id })}
                          >
                            <AgentAvatar icon={a.icon} cli={a.cli} size="xs" />
                            {a.name}
                          </button>
                        ) : (
                          <span className="text-subtle">{t('（已删除）')}</span>
                        )}
                        <button
                          type="button"
                          draggable={false}
                          aria-label={t('不再引入')}
                          title={t('不再引入')}
                          onClick={() =>
                            set(
                              'includes',
                              draft.includes.filter((x) => x !== id),
                            )
                          }
                          className="grid h-6 w-6 cursor-pointer place-items-center rounded text-subtle hover:bg-sel hover:text-fg"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </span>
                    )
                  })}
                  <AgentPicker
                    onPick={(a) => include(a.id)}
                    exclude={agents.filter((a) => !includable.includes(a)).map((a) => a.id)}
                  >
                    <Button variant="secondary" size="sm">
                      <Plus className="h-3.5 w-3.5" />
                      {t('引入 Agent')}
                    </Button>
                  </AgentPicker>
                </div>
                {cycle.length > 0 && (
                  <div className="flex items-start gap-2 rounded-lg bg-danger/10 px-3 py-2 text-[0.78125rem] leading-relaxed text-danger">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span className="min-w-0 flex-1">
                      {t(
                        '引入关系有循环：{chain}。执行时绕回的那一环会被跳过，设定很可能不完整，请去掉其中一个引入。',
                        {
                          chain: cycleText(cycle, withLive),
                        },
                      )}
                    </span>
                    <Button
                      size="sm"
                      variant="danger-outline"
                      onClick={() =>
                        set(
                          'includes',
                          draft.includes.filter((x) => x !== cycle[1]),
                        )
                      }
                    >
                      {t('不再引入「{name}」', { name: withLive.find((a) => a.id === cycle[1])?.name ?? '' })}
                    </Button>
                  </div>
                )}
                {(tooDeep.length > 0 || deepParents.length > 0) && (
                  <div className="flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-[0.78125rem] leading-relaxed text-warning">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <div className="flex min-w-0 flex-col gap-0.5">
                      {tooDeep.length > 0 && (
                        <span>
                          {t(
                            '引入了 {depth} 层，超过 {max} 层的不会交给它：{list}。把深层的 Agent 直接引入到上面几层，或者精简引入链。',
                            {
                              depth,
                              max: MAX_INCLUDE_DEPTH,
                              list: [...new Set(tooDeep.map((r) => r.agent?.name ?? t('（已删除）')))].join(t('、')),
                            },
                          )}
                        </span>
                      )}
                      {deepParents.map(({ a, depth: d }) => (
                        <span key={a.id}>
                          {t('「{name}」引入了它，「{name}」的引入链有 {depth} 层，超过 {max} 层的部分不会生效。', {
                            name: a.name,
                            depth: d,
                            max: MAX_INCLUDE_DEPTH,
                          })}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {depth > 1 && (
                  <div className="flex flex-col gap-1 rounded-lg border bg-field px-3 py-2">
                    <span className="text-[0.71875rem] text-subtle">
                      {t('引入层级 · 共 {n} 层（最多展开 {max} 层）', { n: depth, max: MAX_INCLUDE_DEPTH })}
                    </span>
                    <ul className="flex flex-col">
                      {tree.map((r, i) => {
                        const over = r.depth > MAX_INCLUDE_DEPTH
                        return (
                          <li
                            key={i}
                            className="flex h-7 items-center gap-2 text-[0.78125rem]"
                            style={{ paddingLeft: (r.depth - 1) * 18 }}
                          >
                            <span
                              className={cn(
                                'grid h-5 min-w-5 shrink-0 place-items-center rounded-md px-1 font-mono text-[0.6875rem] tabular-nums',
                                r.cycle
                                  ? 'bg-danger/12 text-danger'
                                  : over
                                    ? 'bg-warning/12 text-warning'
                                    : 'bg-sel text-muted',
                              )}
                              title={t('第 {n} 层', { n: r.depth })}
                            >
                              {r.depth}
                            </span>
                            {r.agent ? (
                              <button
                                type="button"
                                className={cn(
                                  'flex min-w-0 cursor-pointer items-center gap-1.5 hover:text-accent',
                                  (over || r.cycle) && 'text-subtle line-through',
                                )}
                                onClick={() => go({ page: 'agents', id: r.agent!.id })}
                              >
                                <AgentAvatar icon={r.agent.icon} cli={r.agent.cli} size="xs" />
                                <span className="truncate">{r.agent.name}</span>
                              </button>
                            ) : (
                              <span className="text-subtle">{t('（已删除）')}</span>
                            )}
                            {r.cycle ? (
                              <span className="shrink-0 text-[0.71875rem] text-danger">{t('绕回上层，形成循环')}</span>
                            ) : over ? (
                              <span className="shrink-0 text-[0.71875rem] text-warning">{t('太深，不会展开')}</span>
                            ) : r.agent && !r.agent.enabled ? (
                              <span className="shrink-0 text-[0.71875rem] text-subtle">{t('已停用')}</span>
                            ) : null}
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                )}
              </div>
            </FormSection>

            <FormSection title={t('参数')}>
              <p className="-mt-2 text-xs leading-relaxed text-subtle">
                {t(
                  '把可变的部分做成参数暴露出去：对话时用默认值（没有默认值的先问你），工作流节点上可以直接改。同一个 Agent 换个参数就能走不同的做法。',
                )}
              </p>
              <ParamsEditor value={draft.params} onChange={(v) => set('params', v)} />
            </FormSection>

            <FormSection title={t('Skill 与开场白')}>
              <Field
                label="Skill"
                hint={t('执行时提醒它优先用这些 Skill。Skill 本身装在 CLI 里，在「Skills 与命令」页面管理。')}
              >
                <SkillsPicker value={draft.skills} onChange={(v) => set('skills', v)} cli={cliId} />
              </Field>
              <Field label={t('开场白')} hint={t('常用的要求，和它对话时显示在输入框上方，点一下就填进去。')}>
                <StartersEditor value={draft.starters} onChange={(v) => set('starters', v)} />
              </Field>
              <Field label={t('额外参数')} hint={t('追加给 CLI 的参数，用空格分隔，含空格的值用引号包住。')}>
                <Input
                  value={args}
                  onChange={(e) => setArgs(e.target.value)}
                  placeholder={t('例如：--add-dir ../shared')}
                  className="font-mono text-[0.8125rem]"
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
            {preview && (
              <details className="group rounded-xl border bg-card p-4">
                <summary className="cursor-pointer text-[0.8125rem] font-semibold">{t('实际交给它的设定')}</summary>
                <p className="mt-2 text-[0.71875rem] text-subtle">
                  {t('按参数默认值展开，包含引入的 Agent 和 Skill 提示。')}
                </p>
                <pre className="mt-2 max-h-80 overflow-auto rounded-lg bg-field p-2.5 font-mono text-[0.71875rem] leading-relaxed whitespace-pre-wrap">
                  {preview}
                </pre>
              </details>
            )}
            {includedBy.length > 0 && (
              <section className="flex flex-col gap-2 rounded-xl border bg-card p-4">
                <h3 className="text-[0.8125rem] font-semibold">{t('被这些 Agent 引入')}</h3>
                {includedBy.map((a) => (
                  <button
                    key={a.id}
                    onClick={() => go({ page: 'agents', id: a.id })}
                    className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[0.8125rem] hover:bg-sel"
                  >
                    <AgentAvatar icon={a.icon} cli={a.cli} size="xs" />
                    <span className="flex-1 truncate">{a.name}</span>
                  </button>
                ))}
              </section>
            )}
            <section className="flex flex-col gap-2 rounded-xl border bg-card p-4">
              <h3 className="text-[0.8125rem] font-semibold">{t('所在工作流')}</h3>
              {usedIn.length === 0 && <p className="text-xs text-subtle">{t('还没有工作流使用它。')}</p>}
              {usedIn.map(({ w, role }) => (
                <button
                  key={w.id}
                  onClick={() => go({ page: 'workflows', id: w.id })}
                  className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[0.8125rem] hover:bg-sel"
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
