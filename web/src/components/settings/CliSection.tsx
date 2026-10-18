import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  ArrowUpCircle,
  CircleAlert,
  CircleCheck,
  Download,
  Loader2,
  RefreshCw,
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
import { cliSettings, defaultCli, tierFallback, tierOf } from '@shared/settings'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { cliColor, cliDefaultModel, defaultEffortOptions, effortLabel } from '@/lib/cli-style'
import { useCliDef, useCliModels } from '@/lib/cli-models'
import { clearInstallJob, startInstall, useInstallJob } from '@/lib/cli-install'
import { cn, joinArgs, splitArgs } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input, Select, Textarea } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Segmented } from '@/components/ui/segmented'
import { ConfirmDialog } from '@/components/ui/dialog'
import { CommandPreview } from '@/components/agents/CommandPreview'
import { ModelSelect } from '@/components/agents/ModelSelect'
import { CopyText, Group, Row } from './parts'
import { CliAuthPanel } from './CliAuthPanel'
import type { ApiConfig } from '@shared/accounts'
import { CliLimitsPanel, hasLimits } from './CliLimits'
import { CliSkills } from './CliSkills'

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

function InstallLog({ job, onClose }: { job: CliInstallJob; onClose: () => void }) {
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
      <div className="flex items-center gap-2 px-3.5 py-2.5 text-[13px]">
        {job.status === 'running' ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-accent" />
        ) : job.status === 'done' ? (
          <CircleCheck className="h-4 w-4 shrink-0 text-success" />
        ) : (
          <CircleAlert className="h-4 w-4 shrink-0 text-danger" />
        )}
        <span className="min-w-0 flex-1">{statusText}</span>
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
      {job.error && <p className="px-3.5 pb-2 text-[13px] leading-relaxed text-danger">{job.error}</p>}
      {job.note && <p className="px-3.5 pb-2 text-[13px] leading-relaxed text-muted">{job.note}</p>}
      {job.status === 'failed' && (
        <p className="flex flex-wrap items-center gap-2 px-3.5 pb-2.5 text-xs text-muted">
          {t('在终端里运行')} <CopyText text={job.command} />
        </p>
      )}
      {open && (
        <pre
          ref={pre}
          className="max-h-56 overflow-auto border-t bg-field/60 px-3.5 py-2.5 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-muted"
        >
          <span className="text-subtle">$ {job.command}</span>
          {'\n'}
          {job.log || (job.status === 'running' ? t('等待输出…') : t('没有输出'))}
        </pre>
      )}
    </div>
  )
}

/** 高 / 中 / 低三档：每档一个模型和思考强度，模型留空跟随默认模型（没设默认模型时用建议值） */
export function TierTable({
  def,
  value,
  defaultModel,
  onChange,
  readOnly,
}: {
  def: CliDefinition
  value: CliDraft['tiers']
  /** 这个 CLI 设置里的默认模型，留空的档位跟随它 */
  defaultModel: string
  onChange?: (v: CliDraft['tiers']) => void
  /** 只展示：「默认 CLI」里跟随那个 CLI 自己的档位设置 */
  readOnly?: boolean
}) {
  const set = (tier: ModelTier, k: 'model' | 'effort', v: string) =>
    onChange?.({ ...value, [tier]: { ...value[tier], [k]: v } })
  return (
    <div className="overflow-hidden rounded-xl border">
      <div className="hidden grid-cols-[120px_1fr_170px] gap-3 border-b bg-field/50 px-3.5 py-2 text-xs text-subtle sm:grid">
        <span>{t('档位')}</span>
        <span>{t('模型')}</span>
        <span>{t('思考强度')}</span>
      </div>
      {MODEL_TIERS.map((tr) => {
        const sug = { ...def.tiers[tr.id], model: tierFallback(def, defaultModel, tr.id) }
        return (
          <div
            key={tr.id}
            className="grid grid-cols-1 gap-2 border-b px-3.5 py-3 last:border-b-0 sm:grid-cols-[120px_1fr_170px] sm:items-center sm:gap-3"
          >
            <span className="flex items-center gap-2">
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-accent-soft text-xs font-semibold text-accent">
                {tr.label}
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="text-[13px]">{t('{tier}档', { tier: tr.label })}</span>
                <span className="truncate text-[11px] text-subtle">{tr.hint}</span>
              </span>
            </span>
            {readOnly ? (
              <>
                <span className="truncate font-mono text-[13px]">{value[tr.id].model || sug.model}</span>
                <span className="truncate text-[13px] text-muted">
                  {(value[tr.id].effort || sug.effort) &&
                    `${value[tr.id].effort || sug.effort} · ${effortLabel(def, value[tr.id].effort || sug.effort)}`}
                </span>
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
                  value={value[tr.id].effort === sug.effort ? '' : value[tr.id].effort}
                  onChange={(e) => set(tr.id, 'effort', e.target.value)}
                  options={defaultEffortOptions(def, sug.effort)}
                />
              </>
            )}
          </div>
        )
      })}
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
  const e = d.defaultEffort || cliDefaultModel(def)?.defaultEffort
  if (!e) return `auto · ${t('自动（默认）')}`
  return `${e} · ${effortLabel(def, e)}${d.defaultEffort ? '' : t('（默认）')}`
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
          : !['codex', 'commandcode'].includes(getCli(cli.id)?.modelsFrom ?? '')
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
}) {
  const set = <K extends keyof CliDraft>(k: K, v: CliDraft[K]) => onChange({ ...draft, [k]: v })
  // 模型和思考强度用本机 CLI 实际支持的
  const full = useCliDef(def.id) ?? def
  const models = useCliModels(def.id)
  const perm = def.permissions.find((p) => p.id === draft.permission) ?? def.permissions[0]
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
              <span className="rounded-full bg-accent-soft px-2 py-px text-[11px] font-normal text-accent">
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
        {/* 没安装的 CLI 用不了，开关显示为关；装好后自动打开 */}
        <Switch
          checked={!!ok && draft.enabled}
          disabled={!ok}
          title={ok ? undefined : t('安装后自动启用')}
          onCheckedChange={(v) => set('enabled', v)}
          aria-label={t('启用 {cli}', { cli: def.name })}
        />
      </div>
      {installer.job ? (
        <InstallLog key={installer.job.id} job={installer.job} onClose={installer.clear} />
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
            {t('会运行')} <code className="font-mono text-[12px]">npm uninstall -g {def.npmPackage}</code>
            {t('。用这个 CLI 的 Agent 之后都无法执行，直到重新安装。登录信息和它自己的配置不会被删除。')}
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
        />
      )}

      <Group title={t('模型')}>
        <ModelSource cli={def} data={models} />
        <Row
          title={t('三档模型')}
          desc={t(
            'Agent 选了高、中、低档时使用的模型和思考强度。模型留空时跟随下面的默认模型，没设默认模型时用建议值。',
          )}
          stack
        >
          <TierTable
            def={full}
            value={draft.tiers}
            defaultModel={draft.defaultModel}
            onChange={(v) => set('tiers', v)}
          />
        </Row>
        <Row title={t('默认模型')} desc={t('Agent 没有指定模型时使用，可以选一个档位')}>
          <DefaultModel def={full} draft={draft} onChange={(v) => set('defaultModel', v)} />
        </Row>
        <Row title={t('默认思考强度')} desc={t('Agent 和档位都没有指定时使用')}>
          <Select
            aria-label={t('{cli} 默认思考强度', { cli: def.name })}
            value={draft.defaultEffort === cliDefaultModel(full)?.defaultEffort ? '' : draft.defaultEffort}
            onChange={(e) => set('defaultEffort', e.target.value)}
            options={defaultEffortOptions(full, cliDefaultModel(full)?.defaultEffort)}
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
        <Row title={t('可执行文件')} desc={t('留空时从 PATH 查找 {command}', { command: def.command })}>
          <Input
            value={draft.command}
            onChange={(e) => set('command', e.target.value)}
            placeholder={def.command}
            className="h-9 font-mono text-[13px]"
            spellCheck={false}
          />
        </Row>
        <Row title={t('额外参数')} desc={t('每次调用都会追加，Agent 自己的参数排在后面')}>
          <Input
            value={draft.args}
            onChange={(e) => set('args', e.target.value)}
            placeholder={t('例如 --add-dir ../shared')}
            className="h-9 font-mono text-[13px]"
            spellCheck={false}
          />
        </Row>
        <Row title={t('环境变量')} desc={t('每行一个 KEY=VALUE，只传给这个 CLI')}>
          <Textarea
            rows={2}
            value={draft.envText}
            onChange={(e) => set('envText', e.target.value)}
            placeholder={def.envExample || 'HTTPS_PROXY=http://127.0.0.1:7890'}
            className="font-mono text-[13px]"
            spellCheck={false}
          />
        </Row>
        <Row
          title={t('自动压缩上下文')}
          desc={
            def.autoCompact === 'panel'
              ? t('上下文占用达到这个比例时，对话结束一轮后自动压缩（写一份摘要，下一轮开新会话带上）')
              : t('上下文占用达到这个比例时自动压缩')
          }
        >
          <Select
            aria-label={t('{cli} 自动压缩', { cli: def.name })}
            value={String(draft.autoCompact)}
            onChange={(e) => set('autoCompact', Number(e.target.value))}
            options={[
              { value: '0', label: t('{name}（默认）', { name: t('按 CLI 自己的规则') }) },
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

      {ok && (
        <Group title="Skills">
          <p className="pb-2 text-[12px] text-muted">
            {def.protocol === 'codex-app'
              ? t('{cli} 加载的 Skill（用户目录、系统自带和插件里的）', { cli: def.name })
              : t('{dirs} 里的 Skill；项目里的在项目设置里看', {
                  dirs: [...def.skills.user, ...(def.protocol === 'claude-stream' ? [t('已装插件')] : [])].join('、'),
                })}
          </p>
          <CliSkills cli={def.id} />
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
      return [
        c.id,
        {
          enabled: eff.enabled,
          command: raw?.command ?? '',
          defaultModel: eff.defaultModel,
          defaultEffort: eff.defaultEffort,
          tiers: CliSettings.shape.tiers.parse(raw?.tiers),
          permission: eff.permission,
          args: joinArgs(eff.extraArgs),
          envText: envToText(eff.env),
          showLimits: eff.showLimits,
          autoCompact: eff.autoCompact,
          authMode: eff.authMode,
          apiId: eff.apiId,
        },
      ]
    }),
  )

/** 会跳过确认、不受沙箱限制的权限档，说明文字标成警告色 */
export const DANGER_PERMS = ['bypassPermissions', 'danger-full-access', 'yolo']
