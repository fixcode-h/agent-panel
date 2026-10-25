import { useEffect, useRef, useState } from 'react'
import { toast } from '@/lib/toast'
import {
  ArrowUpCircle,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Download,
  Loader2,
  RefreshCw,
  RotateCcw,
  Sparkles,
  SquareTerminal,
  Trash2,
  X,
} from 'lucide-react'
import { CLIS, MODEL_TIERS, getCli, type CliDefinition, type ModelTier } from '@shared/clis'
import {
  CliSettings,
  type CliInstallJob,
  type CliModels,
  type CliUpdate,
  type CliStatus,
  type Settings,
} from '@shared/schema'
import { t } from '@shared/i18n'
import { PROXY_ENV_EXAMPLE } from '@shared/proxy'
import { accountModelId, cliSettings, defaultCli, tierFallback, tierOf } from '@shared/settings'
import { autoLimits, fmtTokens, limitSupport, parseTokens } from '@shared/model-limits'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { cliColor, cliDefaultModel, defaultEffortOptions, effortValue, modelEfforts } from '@/lib/cli-style'
import { useCliDef, useCliModels } from '@/lib/cli-models'
import { lookupModel, refreshModelCatalog, useModelCatalog } from '@/lib/model-catalog'
import { clearInstallJob, startInstall, useInstallJob } from '@/lib/cli-install'
import { cn, joinArgs, splitArgs } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input, Select, Textarea } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Segmented } from '@/components/ui/segmented'
import { ConfirmDialog } from '@/components/ui/dialog'
import { CommandPreview } from '@/components/agents/CommandPreview'
import { AiFixButton } from '@/components/ui/ai-fix'
import { ModelSelect } from '@/components/agents/ModelSelect'
import { CopyText, Group, Row } from './parts'
import { CliAuthPanel } from './CliAuthPanel'
import type { ApiConfig, ApiProtocol } from '@shared/accounts'
import { CliLimitsPanel, hasLimits } from './CliLimits'
import { CliSkills } from './CliSkills'
import { CliPackages } from './CliPackages'

export const envToText = (env: CliSettings['env']) => env.map((e) => `${e.key}=${e.value}`).join('\n')
export const textToEnv = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => ({ key: l.slice(0, l.indexOf('=')).trim(), value: l.slice(l.indexOf('=') + 1) }))

/** 编辑中的 CLI 设置：参数和环境变量先按文本编辑，保存时再解析 */
export interface CliDraft extends Omit<CliSettings, 'extraArgs' | 'env'> {
  args: string
  envText: string
}

/**
 * 安装 / 更新 / 卸载：在本机用 npm 执行，页面上显示进度和输出。
 * 失败时给出原因和命令，用户可以复制到终端自己运行（例如需要 sudo）。
 */
function useCliInstaller(def: CliDefinition) {
  const { tasks, agents, settings } = useData()
  const job = useInstallJob(def.id)
  const running = job?.status === 'running'
  const start = async (action: CliInstallJob['action']) => {
    try {
      await startInstall(def.id, action)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  // 卸载前提醒：有任务正在用它
  const busy = tasks.some(
    (task) =>
      task.status === 'running' &&
      agents.some(
        (a) =>
          (a.cli || (settings ? defaultCli(settings) : '')) === def.id &&
          task.steps.some((s) => s.agentId === a.id && s.status === 'running'),
      ),
  )
  return { job, running, start, clear: () => clearInstallJob(def.id), busy }
}

function InstallLog({
  job,
  name,
  onClose,
  onDetect,
}: {
  job: CliInstallJob
  name: string
  onClose: () => void
  onDetect: () => void
}) {
  const [open, setOpen] = useState(job.status === 'failed')
  const pre = useRef<HTMLPreElement>(null)
  useEffect(() => {
    if (job.status === 'failed') setOpen(true)
  }, [job.status])
  useEffect(() => {
    if (pre.current) pre.current.scrollTop = pre.current.scrollHeight
  }, [job.log, open])
  const kind = job.action === 'uninstall' ? 'uninstall' : job.update ? 'update' : 'install'
  const statusText = {
    running: { install: t('正在安装…'), update: t('正在更新…'), uninstall: t('正在卸载…') },
    done: { install: t('安装完成'), update: t('更新完成'), uninstall: t('卸载完成') },
    failed: { install: t('安装没有成功'), update: t('更新没有成功'), uninstall: t('卸载没有成功') },
  }[job.status === 'running' ? 'running' : job.status === 'done' ? 'done' : 'failed'][kind]
  return (
    <div
      className={cn(
        'mt-3 overflow-hidden rounded-xl border',
        job.status === 'failed' ? 'border-danger/40 bg-danger/5' : job.status === 'done' ? 'border-success/30' : '',
      )}
    >
      <div className="flex items-center gap-2 px-3.5 py-2.5 text-[0.8125rem]">
        {job.status === 'running' ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-accent" />
        ) : job.status === 'done' ? (
          <CircleCheck className="h-4 w-4 shrink-0 text-success" />
        ) : (
          <CircleAlert className="h-4 w-4 shrink-0 text-danger" />
        )}
        <span className="min-w-0 flex-1">{statusText}</span>
        {job.status === 'failed' && (
          <AiFixButton
            variant="ghost"
            className="h-7 px-2 text-xs"
            issue={() => ({
              title: `${name}：${statusText}`,
              error: [job.error, job.note].filter(Boolean).join('\n'),
              command: job.command,
              output: job.log.slice(-12_000),
              topic: `cli:${job.cli}`,
              onDone: onDetect,
            })}
          />
        )}
        <button
          onClick={() => setOpen((o) => !o)}
          className="cursor-pointer rounded-md px-1.5 py-0.5 text-xs text-muted hover:bg-sel hover:text-fg"
        >
          {open ? t('收起输出') : t('查看输出')}
        </button>
        {job.status !== 'running' && (
          <button
            onClick={onClose}
            aria-label={t('关闭')}
            className="grid h-6 w-6 cursor-pointer place-items-center rounded-md text-subtle hover:bg-sel hover:text-fg"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {job.error && <p className="px-3.5 pb-2 text-[0.8125rem] leading-relaxed text-danger">{job.error}</p>}
      {job.note && <p className="px-3.5 pb-2 text-[0.8125rem] leading-relaxed text-muted">{job.note}</p>}
      {job.status === 'failed' && (
        <p className="flex flex-wrap items-center gap-2 px-3.5 pb-2.5 text-xs text-muted">
          {t('在终端里运行')} <CopyText text={job.command} />
        </p>
      )}
      {open && (
        <pre
          ref={pre}
          className="max-h-56 overflow-auto border-t bg-field/60 px-3.5 py-2.5 font-mono text-[0.71875rem] leading-relaxed whitespace-pre-wrap text-muted"
        >
          <span className="text-subtle">$ {job.command}</span>
          {'\n'}
          {job.log || (job.status === 'running' ? t('等待输出…') : t('没有输出'))}
        </pre>
      )}
    </div>
  )
}

/**
 * 上下文窗口 / 最大输出的输入框：0 是自动，输入框里用灰色显示按模型估出来的值；手填「1M」「200K」「128000」都认，
 * 改过的旁边有恢复默认的按钮。CLI 不接受的项只读（disabled 时只显示估出来的值）
 */
function TokenField({
  label,
  value,
  auto,
  onChange,
  disabled,
  readOnly,
  title,
}: {
  label: string
  value: number
  auto?: number
  onChange: (v: number) => void
  disabled?: boolean
  readOnly?: boolean
  title?: string
}) {
  const [text, setText] = useState(value ? fmtTokens(value) : '')
  useEffect(() => setText(value ? fmtTokens(value) : ''), [value])
  const autoText = auto ? fmtTokens(auto) : ''
  const commit = () => {
    if (!text.trim()) return onChange(0)
    const n = parseTokens(text)
    if (n) onChange(n)
    else setText(value ? fmtTokens(value) : '')
  }
  return (
    <label className="flex min-w-0 items-center gap-2 text-xs text-subtle" title={title}>
      <span className="shrink-0">{label}</span>
      {readOnly ? (
        <span className="truncate font-mono text-[0.8125rem] text-fg">
          {value ? fmtTokens(value) : autoText || '—'}
        </span>
      ) : (
        <span className="relative min-w-0 flex-1">
          <Input
            aria-label={label}
            className="h-8 pr-8 font-mono text-[0.8125rem]"
            value={disabled ? '' : text}
            placeholder={autoText}
            disabled={disabled}
            onChange={(e) => setText(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
          {!!value && !disabled && (
            <button
              type="button"
              onClick={() => onChange(0)}
              aria-label={t('恢复自动')}
              title={t('恢复自动')}
              className="absolute top-1/2 right-1.5 grid h-6 w-6 -translate-y-1/2 cursor-pointer place-items-center rounded-md text-subtle hover:bg-sel hover:text-fg"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
          )}
        </span>
      )}
    </label>
  )
}

/** 高 / 中 / 低三档：每档一个模型和思考强度，模型留空跟随默认模型（没设默认模型时用建议值） */
export function TierTable({
  def,
  value,
  defaultModel,
  onChange,
  readOnly,
  protocol,
  apiModelMap,
  apiModelEfforts,
}: {
  def: CliDefinition
  value: CliDraft['tiers']
  /** 这个 CLI 设置里的默认模型，留空的档位跟随它 */
  defaultModel: string
  onChange?: (v: CliDraft['tiers']) => void
  /** 只展示：「默认 CLI」里跟随那个 CLI 自己的档位设置 */
  readOnly?: boolean
  /** API 模式的协议：同分时优先选支持它的模型 */
  protocol?: ApiProtocol
  /** 当前 API 配置里的模型映射：模型名 → 按哪个模型配置估算 */
  apiModelMap?: Record<string, string>
  /** 当前 API 配置里每个模型的默认思考强度 */
  apiModelEfforts?: Record<string, string>
}) {
  const catalog = useCliModels(def.id)?.models
  const modelCatalog = useModelCatalog()
  const settings = useData().settings
  const aiLookup = settings?.modelCatalog.aiLookup ?? true
  const [looking, setLooking] = useState('')
  /** 上下文、最大输出和模型映射默认收起，避免表格太长 */
  const [expanded, setExpanded] = useState<Set<ModelTier>>(() => new Set())
  const can = limitSupport(def)
  const set = <K extends keyof CliDraft['tiers']['high']>(tier: ModelTier, k: K, v: CliDraft['tiers']['high'][K]) =>
    onChange?.({ ...value, [tier]: { ...value[tier], [k]: v } })
  const toggle = (tier: ModelTier) =>
    setExpanded((s) => {
      const next = new Set(s)
      if (next.has(tier)) next.delete(tier)
      else next.add(tier)
      return next
    })
  const lookup = async (model: string) => {
    setLooking(model)
    try {
      const job = await lookupModel(model, protocol)
      if (job.status !== 'done') throw new Error(job.error || t('补全失败'))
      await refreshModelCatalog()
      toast.success(t('已补全 {model} 的模型信息', { model }))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setLooking('')
    }
  }
  return (
    <div className="overflow-hidden rounded-xl border">
      <div className="hidden grid-cols-[120px_1fr_170px] gap-3 border-b bg-field/50 px-3.5 py-2 text-xs text-subtle sm:grid">
        <span>{t('档位')}</span>
        <span>{t('模型')}</span>
        <span>{t('思考强度')}</span>
      </div>
      {MODEL_TIERS.map((tr) => {
        const sug = { ...def.tiers[tr.id], model: tierFallback(def, defaultModel, tr.id) }
        const model = value[tr.id].model || sug.model
        // 自动值按这一档实际用的模型识别：换了模型，空着的上下文、最大输出和思考强度跟着变
        const own = autoLimits(model, catalog, { entries: modelCatalog?.entries, protocol })
        // API 配置里给这个模型配了映射：上下文、最大输出和思考强度都按映射到的模型算
        const mapTo = apiModelMap?.[model] ?? ''
        const mappedAuto = mapTo ? autoLimits(mapTo, catalog, { entries: modelCatalog?.entries, protocol }) : undefined
        const auto = mappedAuto?.matched
          ? {
              ...own,
              context: mappedAuto.context,
              maxOutput: mappedAuto.maxOutput,
              efforts: mappedAuto.efforts,
              defaultEffort: mappedAuto.defaultEffort,
              matched: true,
            }
          : own
        const open = expanded.has(tr.id)
        const context = value[tr.id].context || auto.context
        const maxOutput = value[tr.id].maxOutput || auto.maxOutput
        const allowed = def.efforts.map((e) => e.id)
        const mappedEfforts = mappedAuto?.matched
          ? mappedAuto.efforts.filter((e) => !allowed.length || allowed.includes(e))
          : undefined
        const effortList = mappedEfforts
          ? mappedEfforts.map((id) => ({ id }))
          : def.models.some((m) => m.id === model)
            ? modelEfforts(def, model)
            : auto.matched
              ? auto.efforts.filter((e) => !allowed.length || allowed.includes(e)).map((id) => ({ id }))
              : def.efforts
        // 默认思考强度：API 设置里按模型配的优先，其次才是模型目录的默认值
        const defaultEffort = sug.effort || apiModelEfforts?.[model] || auto.defaultEffort
        return (
          <div
            key={tr.id}
            className="grid grid-cols-1 gap-2 border-b px-3.5 py-3 last:border-b-0 sm:grid-cols-[120px_1fr_170px] sm:items-center sm:gap-x-3"
          >
            <span className="flex items-center gap-2">
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-accent-soft text-xs font-semibold text-accent">
                {tr.label}
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="text-[0.8125rem]">{t('{tier}档', { tier: tr.label })}</span>
                <span className="truncate text-[0.6875rem] text-subtle">{tr.hint}</span>
              </span>
            </span>
            {readOnly ? (
              <>
                <span className="truncate font-mono text-[0.8125rem]">{model}</span>
                <span className="truncate text-[0.8125rem] text-muted">{value[tr.id].effort || defaultEffort}</span>
              </>
            ) : (
              <>
                {/* 档位自己的模型下拉不列档位；留空时用的模型标（默认） */}
                <ModelSelect
                  aria-label={t('{cli} {tier}档模型', { cli: def.name, tier: tr.label })}
                  def={def}
                  value={value[tr.id].model}
                  onChange={(v) => set(tr.id, 'model', v)}
                  defaultValue={sug.model}
                />
                <Select
                  aria-label={t('{cli} {tier}档思考强度', { cli: def.name, tier: tr.label })}
                  value={effortValue(def, defaultEffort, effortList, value[tr.id].effort)}
                  onChange={(e) => set(tr.id, 'effort', e.target.value)}
                  // 只列这一档实际用的模型支持的强度：模型不认的强度 CLI 会启动即报错退出
                  options={defaultEffortOptions(def, defaultEffort, effortList)}
                />
              </>
            )}
            <div className="flex flex-col gap-2 sm:col-span-2 sm:col-start-2">
              <button
                type="button"
                onClick={() => toggle(tr.id)}
                aria-expanded={open}
                className="flex w-fit cursor-pointer flex-wrap items-center gap-x-1.5 gap-y-1 text-[0.6875rem] text-subtle hover:text-fg"
              >
                <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 transition-transform', open && 'rotate-90')} />
                <span>
                  {t('上下文')} <span className="font-mono text-[0.75rem] text-muted">{fmtTokens(context)}</span>
                </span>
                <span aria-hidden>·</span>
                <span>
                  {t('最大输出')} <span className="font-mono text-[0.75rem] text-muted">{fmtTokens(maxOutput)}</span>
                </span>
                {mapTo && <span className="text-accent">{t('映射 {model}', { model: mapTo })}</span>}
              </button>
              {open && (
                <div className="flex flex-col gap-2 rounded-lg border bg-field/30 p-2.5">
                  {mapTo && (
                    <p className="text-[0.6875rem] leading-relaxed text-subtle">
                      {t('这个模型在 API 配置里映射到了 {model}：上下文和最大输出按它的配置估算。', { model: mapTo })}
                    </p>
                  )}
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-3">
                    <TokenField
                      label={t('上下文')}
                      value={value[tr.id].context}
                      auto={auto.context}
                      readOnly={readOnly}
                      onChange={(v) => set(tr.id, 'context', v)}
                      title={
                        can.context ? undefined : t('{cli} 不接受这项设置，只用于面板估算上下文占用', { cli: def.name })
                      }
                    />
                    <TokenField
                      label={t('最大输出')}
                      value={value[tr.id].maxOutput}
                      auto={auto.maxOutput}
                      readOnly={readOnly}
                      disabled={!can.maxOutput}
                      onChange={(v) => set(tr.id, 'maxOutput', v)}
                      title={can.maxOutput ? undefined : t('{cli} 不接受最大输出的设置', { cli: def.name })}
                    />
                  </div>
                </div>
              )}
            </div>
            {!readOnly && model && !auto.matched && !mapTo && aiLookup && (
              <div className="flex flex-wrap items-center gap-2 text-[0.6875rem] text-subtle sm:col-span-2 sm:col-start-2">
                <span>
                  {t('模型配置里没有 {model}，按 {context} / {maxOutput} 估算', {
                    model,
                    context: fmtTokens(auto.context),
                    maxOutput: fmtTokens(auto.maxOutput),
                  })}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1.5 text-[0.6875rem]"
                  disabled={!!looking}
                  onClick={() => void lookup(model)}
                >
                  {looking === model ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                  {looking === model ? t('查询中…') : t('AI 补全')}
                </Button>
              </div>
            )}
          </div>
        )
      })}
      {(!can.context || !can.maxOutput) && (
        <p className="border-t bg-field/40 px-3.5 py-2 text-[0.71875rem] leading-relaxed text-subtle">
          {!can.context && !can.maxOutput
            ? t('{cli} 没有设置上下文窗口和最大输出的参数，上下文只用于面板估算占用和压缩时机。', { cli: def.name })
            : !can.maxOutput
              ? t('{cli} 没有设置最大输出的参数，只能改上下文窗口。', { cli: def.name })
              : t('{cli} 没有设置上下文窗口的参数，上下文只用于面板估算占用。', { cli: def.name })}
        </p>
      )}
    </div>
  )
}

/** AI 创建用的模型：和其他模型下拉同一套，默认选中这个 CLI 设置里的默认模型 */
export function AssistModel({
  cli,
  draft,
  value,
  onChange,
  label,
  fallback,
}: {
  cli: string
  draft?: CliDraft
  value: string
  onChange: (v: string) => void
  label?: string
  /** 留空时实际用的值；不给时是这个 CLI 的默认模型 */
  fallback?: string
}) {
  const def = useCliDef(cli) ?? CLIS.find((c) => c.id === cli)
  if (!def || !draft) return null
  const tiers = {
    high: { model: draft.tiers.high.model || tierFallback(def, draft.defaultModel, 'high') },
    medium: { model: draft.tiers.medium.model || tierFallback(def, draft.defaultModel, 'medium') },
    low: { model: draft.tiers.low.model || tierFallback(def, draft.defaultModel, 'low') },
  }
  return (
    <ModelSelect
      aria-label={label ?? t('AI 创建使用的模型')}
      def={def}
      value={value}
      onChange={onChange}
      tiers={tiers}
      defaultValue={fallback ?? (draft.defaultModel || cliDefaultModel(def)?.id || '')}
    />
  )
}

/** 某个 CLI 的默认模型实际是什么：档位换成那一档的模型，没设置时是 CLI 自己的默认 */
export function defaultModelText(def: CliDefinition, d: CliDraft) {
  const v = d.defaultModel
  const tr = tierOf(v)
  if (tr) return `${t('{tier}档', { tier: tr.label })} · ${d.tiers[tr.id].model || tierFallback(def, '', tr.id)}`
  if (v) return v
  const m = cliDefaultModel(def)?.id
  return m ? m + t('（默认）') : t('自动（默认）')
}

export function defaultEffortText(def: CliDefinition, d: CliDraft) {
  // 只显示 CLI 的英文取值，和下拉里一致
  return d.defaultEffort || cliDefaultModel(def)?.defaultEffort || 'auto'
}

/** 默认模型：可以是档位或具体模型；不指定时就是 CLI 自己的默认模型，直接标（默认） */
function DefaultModel({
  def,
  draft,
  onChange,
}: {
  def: CliDefinition
  draft: CliDraft
  onChange: (v: string) => void
}) {
  const tiers = {
    high: { model: draft.tiers.high.model || tierFallback(def, draft.defaultModel, 'high') },
    medium: { model: draft.tiers.medium.model || tierFallback(def, draft.defaultModel, 'medium') },
    low: { model: draft.tiers.low.model || tierFallback(def, draft.defaultModel, 'low') },
  }
  return (
    <ModelSelect
      aria-label={t('{cli} 默认模型', { cli: def.name })}
      def={def}
      value={draft.defaultModel}
      onChange={onChange}
      tiers={tiers}
      defaultValue={cliDefaultModel(def)?.id ?? ''}
    />
  )
}

/** 模型列表从哪来：本机 CLI 读到的，还是内置的建议 */
function ModelSource({ cli, data }: { cli: CliDefinition; data?: CliModels }) {
  if (!data)
    return (
      <p className="flex items-center gap-1.5 pt-1 text-xs text-subtle">
        <Loader2 className="h-3 w-3 animate-spin" />
        {t('正在从本机 {cli} 读取可用的模型…', { cli: cli.name })}
      </p>
    )
  // 账号登录列出账号能用的全部模型；API 方式列出配置文件里配的模型
  const how =
    data.auth === 'account'
      ? data.from
        ? t('已用 {from} 登录，', { from: data.from })
        : t('已用账号登录，')
      : data.auth === 'api'
        ? data.from
          ? t('用的是 API 方式，下面是 {from} 里配置的模型，', { from: data.from })
          : t('用的是 API 方式，配置文件里没有写模型，')
        : ''
  const text =
    data.source === 'cli'
      ? t('{how}已从本机 {cli} 读到 {n} 个可用模型。', { how, cli: cli.name, n: data.models.length })
      : data.auth === 'api' && !data.error
        ? how + t('下面是常用的型号，也可以直接填写模型名。')
        : data.error
          ? t('没能从 {cli} 读到模型列表（{error}），下面是内置的建议，也可以直接填写模型名。', {
              cli: cli.name,
              error: data.error,
            })
          : !['codex', 'commandcode', 'pi'].includes(getCli(cli.id)?.modelsFrom ?? '')
            ? t('{cli} 没有列出模型的命令，下面是常用的型号，也可以直接填写完整的模型名。', { cli: cli.name })
            : t('下面是内置的建议，也可以直接填写模型名。')
  return <p className={cn('pt-1 text-xs leading-relaxed', data.error ? 'text-warning' : 'text-subtle')}>{text}</p>
}

export function CliSection({
  def,
  draft,
  status,
  isDefault,
  onChange,
  onDetect,
  detecting,
  apis,
  onGoApis,
  onAddApi,
}: {
  def: CliDefinition
  draft: CliDraft
  status?: CliStatus
  isDefault: boolean
  onChange: (d: CliDraft) => void
  onDetect: () => void
  detecting: boolean
  apis: ApiConfig[]
  onGoApis: () => void
  /** 把识别到的 API 存进全局列表 */
  onAddApi: (a: ApiConfig) => void
}) {
  const set = <K extends keyof CliDraft>(k: K, v: CliDraft[K]) => onChange({ ...draft, [k]: v })
  // 模型和思考强度用本机 CLI 实际支持的
  const full = useCliDef(def.id) ?? def
  const models = useCliModels(def.id)
  // API 模式：模型目录按这个接口的协议优先选
  const apiConfig = draft.authMode === 'api' ? apis.find((a) => a.id === draft.apiId) : undefined
  // 账号方式：以前 API 方式存下的模型（带 provider 前缀、协议后缀）按执行时的规则换成账号模型显示，
  // 下拉里看到的就是实际会用的，不再出现 API 的模型
  const selectedApi = apis.find((a) => a.id === draft.apiId)
  const shown = (m: string) => (draft.authMode === 'account' ? accountModelId(def, selectedApi, m) : m)
  const view: CliDraft = {
    ...draft,
    defaultModel: shown(draft.defaultModel),
    tiers: {
      high: { ...draft.tiers.high, model: shown(draft.tiers.high.model) },
      medium: { ...draft.tiers.medium, model: shown(draft.tiers.medium.model) },
      low: { ...draft.tiers.low, model: shown(draft.tiers.low.model) },
    },
  }
  const perm = def.permissions.find((p) => p.id === draft.permission) ?? def.permissions[0]
  // 默认思考强度用在实际的默认模型上：默认模型是档位时是那一档的模型
  const defTier = tierOf(view.defaultModel)
  const defEffortModel = defTier
    ? view.tiers[defTier.id].model || tierFallback(full, '', defTier.id)
    : view.defaultModel || cliDefaultModel(full)?.id || ''
  const ok = status?.installed
  const installer = useCliInstaller(def)
  // 在这里装好（或更新好）以后自动启用，不用再手动打开开关
  const installed = installer.job?.action === 'install' && installer.job.status === 'done'
  useEffect(() => {
    if (installed && !draft.enabled) set('enabled', true)
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [installed])
  // 只有 npm 上有更新的版本时才显示「更新」
  const [update, setUpdate] = useState<CliUpdate | null>(null)
  const checkUpdate = (refresh = false) =>
    api
      .cliUpdate(def.id, refresh)
      .then(setUpdate)
      .catch(() => setUpdate(null))
  useEffect(() => {
    setUpdate(null)
    if (ok && !installer.running) void checkUpdate()
    // 只在版本或安装状态变化时重新检查
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [def.id, ok, status?.version, installer.running])
  const [removing, setRemoving] = useState(false)
  return (
    <>
      <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-field/40 p-3.5">
        <span
          className="grid h-10 w-10 shrink-0 place-items-center rounded-[10px] text-white"
          style={{ background: cliColor(def.id) }}
        >
          <SquareTerminal className="h-5 w-5" strokeWidth={1.8} />
        </span>
        <div className="min-w-0 flex-[1_1_180px]">
          <p className="flex items-center gap-2 font-medium">
            {def.name}
            {isDefault && (
              <span className="rounded-full bg-accent-soft px-2 py-px text-[0.6875rem] font-normal text-accent">
                {t('系统默认')}
              </span>
            )}
          </p>
          <p
            className={cn('truncate text-xs', !status ? 'text-subtle' : ok ? 'text-success' : 'text-warning')}
            title={status?.error}
          >
            {!status
              ? t('检测中…')
              : ok
                ? t('已安装 · {version}', { version: status.version ?? '' })
                : t('没有检测到：{error}', { error: status.error ?? '' })}
          </p>
        </div>
        {status && !ok && (
          <Button size="sm" onClick={() => installer.start('install')} disabled={installer.running}>
            {installer.running ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            {t('安装')}
          </Button>
        )}
        {status && ok && (
          <>
            {(update?.available || (installer.running && installer.job?.action === 'install')) && (
              <Button
                variant="secondary"
                size="sm"
                title={
                  update
                    ? t('当前 {current}，npm 上最新是 {latest}', {
                        current: update.current ?? '',
                        latest: update.latest ?? '',
                      })
                    : undefined
                }
                onClick={() => installer.start('install')}
                disabled={installer.running}
              >
                {installer.running && installer.job?.action === 'install' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ArrowUpCircle className="h-3.5 w-3.5" />
                )}
                {installer.running ? t('更新中') : t('更新到 {tag}', { tag: update?.latest ?? '' })}
              </Button>
            )}
            <Button variant="danger-outline" size="sm" onClick={() => setRemoving(true)} disabled={installer.running}>
              {installer.running && installer.job?.action === 'uninstall' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
              {t('卸载')}
            </Button>
          </>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('重新检测')}
          title={t('重新检测')}
          onClick={() => {
            onDetect()
            if (ok) void checkUpdate(true)
          }}
          disabled={detecting || installer.running}
        >
          <RefreshCw className={cn('h-3.5 w-3.5', detecting && 'animate-spin')} />
        </Button>
        {/* 没安装的 CLI 不显示启动按钮；装好后自动打开 */}
        {ok && (
          <Switch
            checked={draft.enabled}
            onCheckedChange={(v) => set('enabled', v)}
            aria-label={t('启用 {cli}', { cli: def.name })}
          />
        )}
      </div>
      {installer.job ? (
        <InstallLog
          key={installer.job.id}
          job={installer.job}
          name={def.name}
          onClose={installer.clear}
          onDetect={onDetect}
        />
      ) : (
        status &&
        !ok && (
          <p className="flex flex-wrap items-center gap-2 pt-3 text-xs text-muted">
            {t('点「安装」用 npm 安装，或者在终端里运行')} <CopyText text={def.installHint} />
            <span className="text-subtle">{t('自己装好后点右边的刷新重新检测。')}</span>
          </p>
        )
      )}
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={t('卸载 {cli}？', { cli: def.name })}
        description={
          <>
            {t('会运行')} <code className="font-mono text-[0.75rem]">npm uninstall -g {def.npmPackage}</code>
            {t('。用这个 Agent 的角色之后都无法执行，直到重新安装。登录信息和它自己的配置不会被删除。')}
          </>
        }
        blocked={installer.busy ? t('有任务正在用它执行，请等任务完成或先停止。') : undefined}
        confirmText={t('卸载')}
        onConfirm={() => {
          setRemoving(false)
          return installer.start('uninstall')
        }}
      />

      {def.auth && (
        <CliAuthPanel
          def={def}
          mode={draft.authMode}
          apiId={draft.apiId}
          apis={apis}
          onMode={(m) => set('authMode', m)}
          onApi={(id) => set('apiId', id)}
          onGoApis={onGoApis}
          onAddApi={onAddApi}
        />
      )}

      <Group title={t('模型')}>
        <ModelSource cli={def} data={models} />
        <Row
          title={t('三档模型')}
          desc={t(
            '角色选了高、中、低档时使用的模型和思考强度。模型留空时跟随下面的默认模型，没设默认模型时用建议值。上下文、最大输出和思考强度按模型目录自动填，目录里没有的模型按 1M / 128K 估算，也可以手动改。',
          )}
          stack
        >
          <TierTable
            def={full}
            value={view.tiers}
            defaultModel={view.defaultModel}
            protocol={apiConfig?.protocol}
            apiModelMap={apiConfig?.modelMap}
            apiModelEfforts={apiConfig?.modelEfforts}
            onChange={(v) => set('tiers', v)}
          />
        </Row>
        <Row title={t('默认模型')} desc={t('角色没有指定模型时使用，可以选一个档位')}>
          <DefaultModel def={full} draft={view} onChange={(v) => set('defaultModel', v)} />
        </Row>
        <Row title={t('默认思考强度')} desc={t('角色和档位都没有指定时使用')}>
          <Select
            aria-label={t('{cli} 默认思考强度', { cli: def.name })}
            value={effortValue(
              full,
              cliDefaultModel(full)?.defaultEffort,
              modelEfforts(full, defEffortModel),
              draft.defaultEffort,
            )}
            onChange={(e) => set('defaultEffort', e.target.value)}
            options={defaultEffortOptions(
              full,
              cliDefaultModel(full)?.defaultEffort,
              modelEfforts(full, defEffortModel),
            )}
          />
        </Row>
      </Group>

      <Group title={t('运行')}>
        <Row
          title={t('权限')}
          desc={<span className={cn(DANGER_PERMS.includes(perm.id) && 'text-warning')}>{perm.hint}</span>}
          stack
        >
          <Segmented
            label={t('{cli} 权限', { cli: def.name })}
            value={perm.id}
            onChange={(v) => set('permission', v)}
            options={def.permissions.map((p) => ({ id: p.id, label: p.label }))}
          />
        </Row>
        <Row
          title={t('最大回合')}
          desc={t('一轮任务最多执行多少回合（模型请求次数）。留空用 Agent 自己的默认值，Command Code 是 1000')}
        >
          <Input
            type="number"
            min={0}
            max={1000}
            aria-label={t('{cli} 最大回合', { cli: def.name })}
            value={draft.maxTurns || ''}
            onChange={(e) => set('maxTurns', Math.min(1000, Math.max(0, Math.trunc(Number(e.target.value) || 0))))}
            placeholder="1000"
            className="h-9 w-28 font-mono text-[0.8125rem]"
          />
        </Row>
        {(def.options ?? []).map((o) => (
          <Row key={o.id} title={o.label} desc={o.hint}>
            <Switch
              checked={draft.options[o.id] ?? o.default}
              onCheckedChange={(v) => set('options', { ...draft.options, [o.id]: v })}
              aria-label={`${def.name} ${o.label}`}
            />
          </Row>
        ))}
        <Row title={t('可执行文件')} desc={t('留空时从 PATH 查找 {command}', { command: def.command })}>
          <Input
            value={draft.command}
            onChange={(e) => set('command', e.target.value)}
            placeholder={def.command}
            className="h-9 font-mono text-[0.8125rem]"
            spellCheck={false}
          />
        </Row>
        <Row title={t('额外参数')} desc={t('每次调用都会追加，角色自己的参数排在后面')}>
          <Input
            value={draft.args}
            onChange={(e) => set('args', e.target.value)}
            placeholder={t('例如 --add-dir ../shared')}
            className="h-9 font-mono text-[0.8125rem]"
            spellCheck={false}
          />
        </Row>
        <Row title={t('环境变量')} desc={t('每行一个 KEY=VALUE，只传给这个 Agent')}>
          <Textarea
            rows={2}
            value={draft.envText}
            onChange={(e) => set('envText', e.target.value)}
            placeholder={def.envExample || PROXY_ENV_EXAMPLE}
            className="font-mono text-[0.8125rem]"
            spellCheck={false}
          />
        </Row>
        <Row
          title={t('自动压缩上下文')}
          desc={
            // 能原地压缩会话的（Pi 走协议压缩）不用开新会话，只有写摘要的才这样说明
            def.autoCompact === 'panel' && def.compact === 'summary'
              ? t('上下文占用达到这个比例时，对话结束一轮后自动压缩（写一份摘要，下一轮开新会话带上）')
              : t('上下文占用达到这个比例时自动压缩')
          }
        >
          <Select
            aria-label={t('{cli} 自动压缩', { cli: def.name })}
            value={String(draft.autoCompact)}
            onChange={(e) => set('autoCompact', Number(e.target.value))}
            options={[
              { value: '0', label: t('{name}（默认）', { name: t('按 Agent 自己的规则') }) },
              ...[50, 60, 70, 80, 90].map((n) => ({ value: String(n), label: `${n}%` })),
            ]}
          />
        </Row>
        <div className="pt-4">
          <CommandPreview
            cli={def.id}
            model=""
            extraArgs={[]}
            title={t('实际调用（任务描述从 stdin 传入）')}
            override={{
              showLimits: draft.showLimits,
              autoCompact: draft.autoCompact,
              authMode: draft.authMode,
              apiId: draft.apiId,
              enabled: draft.enabled,
              command: draft.command.trim(),
              defaultModel: draft.defaultModel.trim(),
              defaultEffort: draft.defaultEffort,
              tiers: draft.tiers,
              permission: draft.permission,
              extraArgs: splitArgs(draft.args),
              env: textToEnv(draft.envText),
              maxTurns: draft.maxTurns,
              options: draft.options,
            }}
          />
        </div>
      </Group>

      {hasLimits(def.id) && (
        <Group title={t('额度')}>
          <Row title={t('显示额度')} desc={t('在这里和任务页右栏显示账号的 5 小时、每周额度用了多少')}>
            <Switch
              checked={draft.showLimits}
              onCheckedChange={(v) => set('showLimits', v)}
              aria-label={t('显示 {cli} 的额度', { cli: def.name })}
            />
          </Row>
          {draft.showLimits && ok && (
            <div className="pb-1">
              <CliLimitsPanel cli={def.id} />
            </div>
          )}
        </Group>
      )}

      {ok && def.packages && (
        <Group title={t('扩展包')}>
          <p className="pb-2 text-[0.75rem] text-muted">
            {t('包里可以有扩展、Skill、提示词模板和主题，装在 {file} 里。扩展会在本机执行代码，只装信得过的来源', {
              // ${ENV:-默认值} 只显示默认值，用户一般没设这个环境变量
              file: def.packages.file.replace(/\$\{\w+:-([^}]*)\}/g, '$1'),
            })}
          </p>
          <CliPackages def={def} />
        </Group>
      )}

      {ok && (
        <Group title="Skills">
          <p className="pb-2 text-[0.75rem] text-muted">
            {def.rpc?.skillsQuery
              ? t('{cli} 自己的 Skill（用户目录、系统自带和插件里的）；~/.agents/skills 里共用的不在这里列', {
                  cli: def.name,
                })
              : t('{dirs} 里的 Skill；项目里的在项目设置里看', {
                  // ~/.agents/skills 是各 CLI 共用的，这一页只列 CLI 自己的
                  dirs: [
                    ...def.skills.user.filter((d) => d !== '~/.agents/skills'),
                    ...(def.rpc?.pluginSkills ? [t('已装插件')] : []),
                  ].join('、'),
                })}
          </p>
          <CliSkills cli={def.id} own />
        </Group>
      )}
    </>
  )
}

export const toDraft = (s: Settings): Record<string, CliDraft> =>
  Object.fromEntries(
    CLIS.map((c) => {
      const raw = s.clis[c.id]
      const eff = cliSettings(s, c.id)
      const own = CliSettings.parse(raw ?? {})
      return [
        c.id,
        {
          enabled: eff.enabled,
          command: raw?.command ?? '',
          defaultModel: eff.defaultModel,
          defaultEffort: eff.defaultEffort,
          tiers: CliSettings.shape.tiers.parse(raw?.tiers),
          permission: eff.permission,
          // 用户自己写的：API 模式和 CLI 定义自带的环境变量、参数不算（保存时会写回设置里）
          args: joinArgs(own.extraArgs),
          envText: envToText(own.env),
          showLimits: eff.showLimits,
          autoCompact: eff.autoCompact,
          maxTurns: own.maxTurns,
          options: own.options,
          authMode: eff.authMode,
          apiId: eff.apiId,
        },
      ]
    }),
  )

/** 会跳过确认、不受沙箱限制的权限档，说明文字标成警告色 */
export const DANGER_PERMS = ['bypassPermissions', 'danger-full-access', 'yolo']
