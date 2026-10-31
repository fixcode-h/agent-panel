import { subAgentIds } from '@shared/flow'
import { useEffect, useState } from 'react'
import { toast } from '@/lib/toast'
import {
  AlertTriangle,
  Blocks,
  Braces,
  Copy,
  Download,
  Eye,
  GitBranch,
  GripVertical,
  Lock,
  MessageSquare,
  Plus,
  ScrollText,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Workflow as WorkflowIcon,
  X,
} from 'lucide-react'
import { type Agent, type AgentInput, type AgentParam, type ParamValues } from '@shared/schema'
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
import { cliDefaultModel, defaultEffortOptions, effortValue, modelEfforts } from '@/lib/cli-style'
import { useCliDef } from '@/lib/cli-models'
import { agentChecks } from '@/lib/readiness'
import { useAutosave } from '@/lib/useAutosave'
import { cn, joinArgs, splitArgs } from '@/lib/utils'
import { moveItem, useDragSort } from '@/lib/useDragSort'
import { Badge, StatusDot } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { AssistDialog } from '@/components/assist/LazyAssistDialog'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Field, FieldSizeContext, FormSection, Input, Select } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Segmented } from '@/components/ui/segmented'
import { Checkbox } from '@/components/ui/checkbox'
import { Detail, DetailHeader, DetailTabs, IssueBar } from '@/components/layout/Detail'
import { exportAgent } from '@/lib/transfer'
import { AgentAvatar } from './AgentAvatar'
import { CategoryPicker } from './CategoryPicker'
import { CommandPreview } from './CommandPreview'
import { t } from '@shared/i18n'
import {
  MAX_INCLUDE_DEPTH,
  composeRole,
  renameParamRefs,
  templateKeys,
  cycleText,
  includeCycle,
  includeDepth,
  includeTree,
  wouldCycle,
} from '@shared/agent-role'
import { DocEditor } from '@/components/workflows/DocEditor'
import {
  MenuItem,
  MenuSeparator,
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
  menuItem,
} from '@/components/ui/menu'
import { TagPicker } from '@/components/tags/Tags'
import { AgentPicker } from './AgentPicker'
import { ParamsChip, ParamsEditor, ParamsForm } from './ParamFields'
import { builtinDefinition, builtinKey, coreKey, coreUse, defaultMounts, listableAgents } from '@shared/builtin/core'
import { SkillsPicker, StartersEditor } from './AgentExtras'
import { CapabilityFields } from './CapabilityFields'

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

/**
 * 页签按「这个角色干什么（设定）/ 能派给谁（能力）/ 在哪跑（运行）/ 最终交给它什么（预览）」分。
 * 以前是概览、角色设定、能力、参数、Skill 与开场白五页，记在本机的旧值映射到新的一页
 */
const ROLE_TABS = ['role', 'caps', 'run', 'preview'] as const
type RoleTab = (typeof ROLE_TABS)[number]
const OLD_TABS: Record<string, RoleTab> = { basic: 'role', extras: 'role', params: 'run' }

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
  const { go, openSettings } = useNav()
  const [draft, setDraft] = useState<AgentInput>(() => toInput(agent))
  const [args, setArgs] = useState(() => joinArgs(agent.extraArgs))
  const [deleting, setDeleting] = useState(false)
  useEffect(() => {
    if (deleteSignal) setDeleting(true)
  }, [deleteSignal])
  const [assist, setAssist] = useState(false)
  // 表单按「设定 / 能力 / 运行 / 预览」分页：一页只看一类设置，不用在长表单里来回滚。
  // 看到哪一页记在本地，切到别的角色还停在同一页
  const [tab, setTabState] = useState<RoleTab>(() => {
    try {
      const v = localStorage.getItem('role-tab') ?? ''
      return ROLE_TABS.includes(v as RoleTab) ? (v as RoleTab) : (OLD_TABS[v] ?? 'role')
    } catch {
      return 'role'
    }
  })
  const setTab = (v: RoleTab) => {
    setTabState(v)
    try {
      localStorage.setItem('role-tab', v)
    } catch {}
  }

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
  // 内置角色（含必备角色）：设定、能力、Skill 由面板维护并随版本更新，这里只能改参数取值和运行配置
  const core = coreKey(agent)
  const builtin = builtinKey(agent)
  const locked = !!builtin
  const coreDef = builtin ? builtinDefinition(builtin) : undefined
  const coreValues: ParamValues = coreDef
    ? Object.fromEntries(
        draft.params
          .filter((p) => {
            const d = coreDef.agent.params.find((x) => x.key === p.key)
            return d && p.default !== undefined && JSON.stringify(d.default) !== JSON.stringify(p.default)
          })
          .map((p) => [p.key, p.default!]),
      )
    : {}
  const setCoreValues = (v: ParamValues) =>
    coreDef &&
    set(
      'params',
      coreDef.agent.params.map((d) => (d.key in v ? { ...d, default: v[d.key] } : d)),
    )
  /**
   * 「禁止子对话执行」：子对话里点名它会自动转交父对话创建子任务（见 ADR 0019）。
   * 内置角色也能改这个开关，服务端保存时保留用户的 runIn，不跟内置定义同步。
   */
  const runInField = (
    <Checkbox
      checked={draft.runIn === 'parent'}
      onChange={(v) => set('runIn', v ? 'parent' : 'any')}
      label={t('禁止子对话执行')}
      hint={t(
        '只对子对话生效：勾上后子对话里不能执行这个角色，点名它会自动转交父对话创建子任务，子对话的计划步骤立即标完成、不会被它卡住；父对话和工作流节点里照常可以直接派它。',
      )}
    />
  )
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
  // 可以引入的：不是自己、还没引入、引入后不会绕回自己（「子任务」不作为可选角色，不允许其它角色引入它）
  const includable = listableAgents(agents).filter(
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
  // 预览可以临时换参数试：只影响右边的预览，不存
  const [trial, setTrial] = useState<ParamValues>({})
  const preview = composeRole(live, agents, trial)
  // 角色设定里写了、参数里却没有的名字：多半是改名漏了或者拼错了，执行时会原样留在提示词里
  const unknownRefs = [...templateKeys(draft.instructions)].filter((k) => !draft.params.some((p) => p.key === k))
  const startChat = () => go({ page: 'chat' })
  const checks = agentChecks(live, cli)
  // 头部下面的问题条：只列没过的必需项；「已启用」头部已经有开关和「已停用」标记，不重复说
  const issues = checks
    .filter((c) => !c.ok && !c.optional && c.label !== t('已启用'))
    .map((c) => ({
      label: c.label === t('Agent 已安装') ? t('Agent 不可用') : c.label,
      hint: c.hint,
      action:
        c.label === t('Agent 已安装') ? { label: t('去设置'), onClick: () => openSettings(`cli:${cliId}`) } : undefined,
    }))
  const category = categories.find((c) => c.id === draft.categoryId)
  const usedIn = workflows
    .map((w) => ({
      w,
      role: w.mainAgentId === agent.id ? t('主角色') : subAgentIds(w).includes(agent.id) ? t('子角色') : '',
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
          <>
            <DetailHeader
              compact
              quietSave
              leading={<AgentAvatar icon={draft.icon} cli={draft.cli} size="lg" dim={!draft.enabled} />}
              title={draft.name || t('未命名角色')}
              meta={
                <>
                  {core ? <Badge tone="accent">{t('必备')}</Badge> : <Badge>{category?.name ?? t('未分类')}</Badge>}
                  {locked && !core && <Badge tone="accent">{t('内置')}</Badge>}
                  {draft.common && <Badge tone="accent">{t('通用')}</Badge>}
                  {/* 就绪不标：一切正常不占位置，有问题由下面的提示条说 */}
                  {!draft.enabled && <StatusDot tone="muted" label={t('已停用')} />}
                </>
              }
              subtitle={draft.description || t('还没有简介')}
              save={{ ...save, invalid: valid ? undefined : t('名称为空，未保存') }}
              actions={
                <>
                  {!core && (
                    <label className="flex h-8 cursor-pointer items-center gap-2 px-1.5 text-body text-muted">
                      <Switch checked={draft.enabled} onCheckedChange={(v) => set('enabled', v)} />
                      {t('启用')}
                    </label>
                  )}
                  <Button size="sm" onClick={startChat} disabled={!draft.enabled} title={t('用这个角色开一个新对话')}>
                    <MessageSquare className="h-4 w-4" />
                    {t('对话')}
                  </Button>
                </>
              }
              more={
                <>
                  {!locked && (
                    <MenuItem onSelect={() => setAssist(true)}>
                      <Sparkles className="h-4 w-4 text-accent-text" />
                      {t('AI 优化')}
                    </MenuItem>
                  )}
                  <MenuItem onSelect={onDuplicate}>
                    <Copy className="h-4 w-4 text-subtle" />
                    {t('复制一份')}
                  </MenuItem>
                  <MenuItem onSelect={() => exportAgent(agent)}>
                    <Download className="h-4 w-4 text-subtle" />
                    {t('导出分享包')}
                  </MenuItem>
                  {!core && (
                    <>
                      <MenuSeparator />
                      <MenuItem danger onSelect={() => setDeleting(true)}>
                        <Trash2 className="h-4 w-4" />
                        {t('删除')}
                      </MenuItem>
                    </>
                  )}
                </>
              }
            />
            <IssueBar issues={issues} />
          </>
        }
        tabs={
          <DetailTabs
            value={tab}
            onChange={setTab}
            items={[
              {
                id: 'role',
                label: t('设定'),
                icon: ScrollText,
                extra: draft.includes.length ? <TabCount n={draft.includes.length} /> : undefined,
              },
              {
                id: 'caps',
                label: t('能力'),
                icon: Blocks,
                extra: draft.mounts.length ? <TabCount n={draft.mounts.length} /> : undefined,
              },
              {
                id: 'run',
                label: t('运行'),
                icon: SlidersHorizontal,
                extra: draft.params.length ? <TabCount n={draft.params.length} /> : undefined,
              },
              { id: 'preview', label: t('预览'), icon: Eye },
            ]}
          />
        }
        form={
          // 角色页的表单整片用紧凑一档的输入框（和 sm 按钮同高），别的页面不受影响
          <FieldSizeContext value="sm">
            {tab === 'role' && locked && (
              <div className="flex items-start gap-2.5 rounded-lg bg-accent-soft px-3 py-2.5 text-body leading-relaxed">
                <Lock className="mt-1 h-3.5 w-3.5 shrink-0 text-accent-text" />
                <span className="flex min-w-0 flex-col text-muted">
                  <span className="font-medium text-fg">
                    {core ? t('必备角色 · {use}', { use: coreUse(core) }) : t('内置角色 · 随版本更新')}
                  </span>
                  <span>
                    {t('名称、角色设定、能力和 Skill 由面板维护并随版本更新，参数和运行环境在「运行」页改。')}
                    {!core && t('想改设定就在「⋯」里复制一份。')}
                  </span>
                </span>
              </div>
            )}
            {tab === 'role' && locked && !core && (
              <FormSection title={t('分类与标签')}>
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted">{t('分类')}</span>
                  <CategoryPicker value={draft.categoryId} onChange={(id) => set('categoryId', id)} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted">{t('标签')}</span>
                  <TagPicker value={draft.tags} onChange={(v) => set('tags', v)} />
                </div>
              </FormSection>
            )}
            {tab === 'role' && !locked && (
              <FormSection title={t('基本信息')}>
                <div className="flex flex-wrap gap-4">
                  <Field label={t('名称')} className="flex-[1_1_200px]" error={valid ? undefined : t('名称不能为空')}>
                    <Input
                      value={draft.name}
                      onChange={(e) => set('name', e.target.value)}
                      placeholder={t('例如：前端开发')}
                    />
                  </Field>
                  <div className="flex min-w-0 flex-[1_1_200px] flex-col gap-1.5">
                    <span className="text-xs text-muted">{t('分类')}</span>
                    <CategoryPicker value={draft.categoryId} onChange={(id) => set('categoryId', id)} />
                  </div>
                </div>
                <Field label={t('简介')}>
                  <Input
                    value={draft.description}
                    onChange={(e) => set('description', e.target.value)}
                    placeholder={t('一句话说明它擅长什么')}
                  />
                </Field>
                <Checkbox
                  checked={draft.common}
                  onChange={(v) => set('common', v)}
                  label={t('通用角色')}
                  hint={t('工作流里任何角色执行时都可以把子任务派给它，不用写进工作流。')}
                />
                <Checkbox
                  checked={draft.canDelegate}
                  onChange={(v) => set('canDelegate', v)}
                  label={t('能开启子对话')}
                  hint={t('项目顶层的对话里可以把消息交给子对话，或者新建子对话；子对话本身不能再分派。')}
                />
                <Checkbox
                  checked={draft.canPlan}
                  onChange={(v) => set('canPlan', v)}
                  label={t('能启动计划')}
                  hint={t('需要完整流程或较大改动时按工作流启动计划；关掉时只在当前对话里直接执行。')}
                />
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
                          // 和 ChipGroup 同一套：没选是浅灰块，选中换强调色浅底，不描边
                          'grid h-9 w-9 cursor-pointer place-items-center rounded-lg transition-colors',
                          draft.icon === id ? 'bg-accent-soft text-accent-text' : 'chip-idle text-muted hover:text-fg',
                        )}
                      >
                        <Icon className="h-[18px] w-[18px]" strokeWidth={2.2} />
                      </button>
                    ))}
                  </div>
                </div>
              </FormSection>
            )}
            {tab === 'role' && locked && (
              <FormSection title={t('角色设定')}>
                <p className="-mt-2 text-xs leading-relaxed text-subtle">
                  {t('由面板维护，只读。Skill：{list}', { list: draft.skills.join(t('、')) || t('无') })}
                </p>
                <pre className="max-h-[420px] overflow-auto rounded-lg border bg-field p-3 font-mono text-footnote leading-relaxed whitespace-pre-wrap text-muted">
                  {draft.instructions}
                </pre>
              </FormSection>
            )}
            {tab === 'role' && !locked && (
              <>
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
                    mentionHint={t('插入角色名称，并引入它的角色设定')}
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
                        <PopoverContent align="end" className="w-[300px]">
                          {draft.params.map((p) => (
                            <div key={p.key} className="flex items-center gap-1">
                              <PopoverClose
                                className={cn(menuItem, 'min-w-0 flex-1')}
                                onClick={() => insert(`{{${p.key}}}`)}
                              >
                                <code className="font-mono text-footnote text-accent-text">{`{{${p.key}}}`}</code>
                                <span className="truncate text-subtle">{p.label}</span>
                              </PopoverClose>
                              <PopoverClose
                                className={cn(menuItem, 'w-auto shrink-0 px-2')}
                                title={t('插入按「{name}」走不同做法的分支', { name: p.label || p.key })}
                                onClick={() => insert(branchSnippet(p))}
                              >
                                <GitBranch className="h-3.5 w-3.5 text-subtle" />
                                {t('分支')}
                              </PopoverClose>
                            </div>
                          ))}
                          {!draft.params.length && (
                            <p className="px-2.5 py-2 text-xs text-subtle">{t('还没有参数，先在「运行」页里添加')}</p>
                          )}
                        </PopoverContent>
                      </Popover>
                    )}
                  />
                  {unknownRefs.length > 0 && (
                    <p className="flex items-start gap-1.5 text-caption leading-relaxed text-warning">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      {t(
                        '角色设定里引用了没有的参数：{list}。执行时会原样留在提示词里，去「运行」页的参数里添加，或者改成已有的参数名。',
                        {
                          list: unknownRefs.map((k) => `{{${k}}}`).join(t('、')),
                        },
                      )}
                    </p>
                  )}
                  <div className="flex flex-col gap-2">
                    <span className="text-xs text-muted">{t('引入的角色')}</span>
                    <p className="-mt-1 text-caption leading-relaxed text-subtle">
                      {t('引入的角色的角色设定会一起交给这个角色，可以把通用的规范、领域知识做成单独的角色复用。')}
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
                              'group inline-flex h-8 cursor-grab items-center gap-1 rounded-lg bg-card shadow-card pr-1 pl-1 text-body outline-none select-none focus-visible:border-focus active:cursor-grabbing',
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
                                className="flex cursor-pointer items-center gap-1.5 hover:text-accent-text"
                                onClick={() => go({ page: 'agents', id: a.id })}
                              >
                                <AgentAvatar icon={a.icon} cli={a.cli} size="xs" />
                                {a.name}
                              </button>
                            ) : (
                              <span className="text-subtle">{t('（已删除）')}</span>
                            )}
                            <IconButton
                              icon={X}
                              draggable={false}
                              label={t('不再引入')}
                              onClick={() =>
                                set(
                                  'includes',
                                  draft.includes.filter((x) => x !== id),
                                )
                              }
                            />
                          </span>
                        )
                      })}
                      <AgentPicker
                        onPick={(a) => include(a.id)}
                        exclude={agents.filter((a) => !includable.includes(a)).map((a) => a.id)}
                      >
                        <Button variant="secondary" size="sm">
                          <Plus className="h-3.5 w-3.5" />
                          {t('引入角色')}
                        </Button>
                      </AgentPicker>
                    </div>
                    {cycle.length > 0 && (
                      <div className="flex items-start gap-2 rounded-lg bg-danger/10 px-3 py-2 text-footnote leading-relaxed text-danger">
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
                      <div className="flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-footnote leading-relaxed text-warning">
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <div className="flex min-w-0 flex-col gap-0.5">
                          {tooDeep.length > 0 && (
                            <span>
                              {t(
                                '引入了 {depth} 层，超过 {max} 层的不会交给它：{list}。把深层的角色直接引入到上面几层，或者精简引入链。',
                                {
                                  depth,
                                  max: MAX_INCLUDE_DEPTH,
                                  list: [...new Set(tooDeep.map((r) => r.agent?.name ?? t('（已删除）')))].join(
                                    t('、'),
                                  ),
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
                        <span className="text-caption text-subtle">
                          {t('引入层级 · 共 {n} 层（最多展开 {max} 层）', { n: depth, max: MAX_INCLUDE_DEPTH })}
                        </span>
                        <ul className="flex flex-col">
                          {tree.map((r, i) => {
                            const over = r.depth > MAX_INCLUDE_DEPTH
                            return (
                              <li
                                key={i}
                                className="flex h-7 items-center gap-2 text-footnote"
                                style={{ paddingLeft: (r.depth - 1) * 18 }}
                              >
                                <span
                                  className={cn(
                                    'grid h-5 min-w-5 shrink-0 place-items-center rounded-md px-1 font-mono text-caption tabular-nums',
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
                                      'flex min-w-0 cursor-pointer items-center gap-1.5 hover:text-accent-text',
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
                                  <span className="shrink-0 text-caption text-danger">{t('绕回上层，形成循环')}</span>
                                ) : over ? (
                                  <span className="shrink-0 text-caption text-warning">{t('太深，不会展开')}</span>
                                ) : r.agent && !r.agent.enabled ? (
                                  <span className="shrink-0 text-caption text-subtle">{t('已停用')}</span>
                                ) : null}
                              </li>
                            )
                          })}
                        </ul>
                      </div>
                    )}
                  </div>
                </FormSection>
              </>
            )}
            {tab === 'role' && (
              <FormSection title={locked ? t('开场白') : t('Skill 与开场白')}>
                {!locked && (
                  <Field
                    label="Skill"
                    hint={t('执行时提醒它优先用这些 Skill。Skill 本身装在 Agent 里，在「Skills」页面管理。')}
                  >
                    <SkillsPicker value={draft.skills} onChange={(v) => set('skills', v)} cli={cliId} />
                  </Field>
                )}
                <Field label={t('开场白')} hint={t('常用的要求，和它对话时显示在输入框上方，点一下就填进去。')}>
                  <StartersEditor value={draft.starters} onChange={(v) => set('starters', v)} />
                </Field>
              </FormSection>
            )}

            {tab === 'caps' && (
              <CapabilityFields
                draft={draft}
                self={agent}
                agents={agents}
                locked={locked}
                defaults={coreDef ? defaultMounts(coreDef, agents) : undefined}
                set={set}
              />
            )}
            {tab === 'run' && (
              <FormSection title={t('运行环境')}>
                <>
                  <Checkbox
                    checked={follow}
                    onChange={(v) => pickCli(v ? '' : defCli)}
                    label={t('跟随默认 Agent（现在是 {cli}）', {
                      cli: clis.find((c) => c.id === defCli)?.name ?? defCli,
                    })}
                    hint={t(
                      '在设置里换了默认 Agent，这个角色也跟着换，模型换成新 Agent 同一档位的模型。取消后可以固定用某个 Agent。',
                    )}
                  />
                  <div className="flex flex-wrap gap-4">
                    <Field label="Agent" className="flex-[1_1_220px]">
                      <Select
                        aria-label="Agent"
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
                      hint={t('三档对应的模型在设置里每个 Agent 下配置')}
                    >
                      <Select
                        aria-label={t('模型')}
                        value={draft.model}
                        onChange={(e) => set('model', e.target.value)}
                        options={tierOptions}
                        className="font-mono text-body"
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
                        value={effortValue(cliDef, defEffort, modelEfforts(cliDef, usedModel ?? ''), draft.effort)}
                        onChange={(e) => set('effort', e.target.value)}
                        // 只列这个模型支持的强度：模型不认的强度 CLI 会启动即报错退出
                        options={defaultEffortOptions(cliDef, defEffort, modelEfforts(cliDef, usedModel ?? ''))}
                      />
                    </Field>
                  )}
                </>
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
                <Field label={t('额外参数')} hint={t('追加给 Agent 的参数，用空格分隔，含空格的值用引号包住。')}>
                  <Input
                    value={args}
                    onChange={(e) => setArgs(e.target.value)}
                    placeholder={t('例如：--add-dir ../shared')}
                    className="font-mono text-body"
                  />
                </Field>
              </FormSection>
            )}
            {tab === 'run' && locked && coreDef && (
              <FormSection title={t('参数')}>
                <p className="-mt-2 text-xs leading-relaxed text-subtle">
                  {core
                    ? t('这里改的是所有项目的默认取值；某个项目要不一样，在项目设置的「必备角色」里单独改。')
                    : t('这里改的是默认取值，工作流节点上还能单独改；参数本身随内置定义更新。')}
                </p>
                <ParamsForm params={coreDef.agent.params} values={coreValues} onChange={setCoreValues} />
              </FormSection>
            )}
            {tab === 'run' && !locked && (
              <>
                <FormSection title={t('参数')}>
                  <p className="-mt-2 text-xs leading-relaxed text-subtle">
                    {t(
                      '把可变的部分做成参数暴露出去：对话时用默认值（没有默认值的先问你），工作流节点上可以直接改。同一个角色换个参数就能走不同的做法。',
                    )}
                  </p>
                  <ParamsEditor
                    value={draft.params}
                    onChange={(v) => set('params', v)}
                    onRename={(from, to) =>
                      setDraft((d) => ({ ...d, instructions: renameParamRefs(d.instructions, from, to) }))
                    }
                  />
                </FormSection>
              </>
            )}
            {tab === 'run' && <FormSection title={t('对话范围')}>{runInField}</FormSection>}

            {tab === 'preview' && (
              <>
                <CommandPreview
                  cli={draft.cli}
                  model={draft.model}
                  effort={draft.effort}
                  permission={draft.permission}
                  extraArgs={value.extraArgs}
                />
                {preview && (
                  <FormSection title={t('实际交给它的设定')}>
                    <div className="-mt-2 flex items-center gap-2">
                      <p className="min-w-0 flex-1 text-caption text-subtle">
                        {Object.keys(trial).length
                          ? t('按试的参数展开（不保存），包含引入的角色和 Skill 提示。')
                          : t('按参数默认值展开，包含引入的角色和 Skill 提示。')}
                      </p>
                      {draft.params.length > 0 && (
                        <ParamsChip params={draft.params} values={trial} onChange={setTrial} />
                      )}
                    </div>
                    <pre className="max-h-[520px] overflow-auto rounded-lg bg-field p-3 font-mono text-footnote leading-relaxed whitespace-pre-wrap">
                      {preview}
                    </pre>
                  </FormSection>
                )}
                {includedBy.length > 0 && (
                  <FormSection title={t('被这些角色引入')}>
                    <div className="-mx-2 flex flex-col">
                      {includedBy.map((a) => (
                        <button
                          key={a.id}
                          onClick={() => go({ page: 'agents', id: a.id })}
                          className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-body hover:bg-sel"
                        >
                          <AgentAvatar icon={a.icon} cli={a.cli} size="xs" />
                          <span className="flex-1 truncate">{a.name}</span>
                        </button>
                      ))}
                    </div>
                  </FormSection>
                )}
                <FormSection title={t('所在工作流')}>
                  <div className="-mx-2 flex flex-col">
                    {usedIn.length === 0 && <p className="text-xs text-subtle">{t('还没有工作流使用它。')}</p>}
                    {usedIn.map(({ w, role }) => (
                      <button
                        key={w.id}
                        onClick={() => go({ page: 'workflows', id: w.id })}
                        className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-body hover:bg-sel"
                      >
                        <WorkflowIcon className="h-4 w-4 text-subtle" />
                        <span className="flex-1 truncate">{w.name}</span>
                        <Badge tone={role === t('主角色') ? 'accent' : 'neutral'}>{role}</Badge>
                      </button>
                    ))}
                  </div>
                </FormSection>
              </>
            )}
          </FieldSizeContext>
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

/** 「按参数分支」插入的模板：开关、文本按有没有值分，单选 / 多选按第一个选项分 */
function branchSnippet(p: AgentParam) {
  const cond = p.type === 'select' || p.type === 'multi' ? `${p.key}=${p.options[0] ?? '值'}` : p.key
  return `{{#if ${cond}}}\n\n{{else}}\n\n{{/if}}`
}

/** 标签上的数量 */
function TabCount({ n }: { n: number }) {
  return <span className="rounded-full bg-field px-1.5 text-caption text-subtle tabular-nums">{n}</span>
}
