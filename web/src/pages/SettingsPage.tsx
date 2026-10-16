import { useEffect, useRef, useState } from 'react'
import * as D from '@radix-ui/react-dialog'
import { toast } from 'sonner'
import {
  ArrowUpCircle,
  Check,
  CircleAlert,
  CircleCheck,
  Copy,
  Cpu,
  Download,
  FlaskConical,
  Loader2,
  RefreshCw,
  Settings2,
  Sparkles,
  SquareTerminal,
  Trash2,
  X,
  type LucideIcon,
  Layers,
  HardDrive,
  GripVertical,
} from 'lucide-react'
import { CLIS, MODEL_TIERS, type CliDefinition, type ModelTier } from '@shared/clis'
import {
  CliSettings,
  type CliInstallJob,
  type CliModels,
  type CliUpdate,
  type CliStatus,
  type Settings,
  CONTENT_MAX,
  CONTENT_WIDTH,
} from '@shared/schema'
import { applyContentWidth, switchLang } from '@/lib/data'
import { LANGS, t } from '@shared/i18n'
import { cliSettings, defaultCli, orderClis, tierFallback, tierOf } from '@shared/settings'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { cliColor, cliDefaultModel, defaultEffortOptions, effortLabel } from '@/lib/cli-style'
import { loadCliModels, useCliDef, useCliModels } from '@/lib/cli-models'
import { clearInstallJob, resumeInstallJobs, setInstallFinish, startInstall, useInstallJob } from '@/lib/cli-install'
import { notifyEnabled, notifySupported, setNotify } from '@/lib/notify'
import { useAutosave } from '@/lib/useAutosave'
import { cn, joinArgs, splitArgs } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input, Select, Textarea } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Segmented } from '@/components/ui/segmented'
import { ConfirmDialog } from '@/components/ui/dialog'
import { SaveIndicator } from '@/components/layout/Detail'
import { CommandPreview } from '@/components/agents/CommandPreview'
import { UpdateSection } from '@/components/settings/UpdateSection'
import { DataSection } from '@/components/settings/DataSection'
import { ModelSelect } from '@/components/agents/ModelSelect'
import { ProjectCategoryList } from '@/components/projects/ProjectCategoryList'
import { DialogCloseButton } from '@/components/projects/ProjectSettingsDialog'
import { useAppUpdate } from '@/lib/app-update'

const envToText = (env: CliSettings['env']) => env.map((e) => `${e.key}=${e.value}`).join('\n')
const textToEnv = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => ({ key: l.slice(0, l.indexOf('=')).trim(), value: l.slice(l.indexOf('=') + 1) }))

/** 编辑中的 CLI 设置：参数和环境变量先按文本编辑，保存时再解析 */
interface CliDraft extends Omit<CliSettings, 'extraArgs' | 'env'> {
  args: string
  envText: string
}

/** 设置里的一行：左边标题和说明，右边控件；窄屏或 stack 时上下排 */
function Row({
  title,
  desc,
  children,
  stack,
}: {
  title: string
  desc?: React.ReactNode
  children: React.ReactNode
  stack?: boolean
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-3 border-b py-4 last:border-b-0',
        !stack && 'sm:flex-row sm:items-center sm:justify-between sm:gap-8',
      )}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[14px] font-medium">{title}</span>
        {desc && <span className="text-[13px] leading-relaxed text-subtle">{desc}</span>}
      </div>
      <div className={cn('min-w-0', !stack && 'sm:w-[280px] sm:shrink-0')}>{children}</div>
    </div>
  )
}

function Group({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col">
      {title && <h3 className="pt-6 pb-1 text-xs font-medium text-subtle">{title}</h3>}
      {children}
    </section>
  )
}

function CopyText({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      onClick={() =>
        navigator.clipboard
          .writeText(text)
          .then(() => {
            setDone(true)
            setTimeout(() => setDone(false), 1500)
          })
          .catch(() => {})
      }
      className="inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-md border bg-field px-2 py-1 font-mono text-xs text-muted hover:text-fg"
      title={t('复制安装命令')}
    >
      <span className="truncate">{text}</span>
      {done ? <Check className="h-3 w-3 shrink-0 text-success" /> : <Copy className="h-3 w-3 shrink-0" />}
    </button>
  )
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
function TierTable({
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
function AssistModel({
  cli,
  draft,
  value,
  onChange,
}: {
  cli: string
  draft?: CliDraft
  value: string
  onChange: (v: string) => void
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
      aria-label={t('AI 创建使用的模型')}
      def={def}
      value={value}
      onChange={onChange}
      tiers={tiers}
      defaultValue={draft.defaultModel || cliDefaultModel(def)?.id || ''}
    />
  )
}

/** 只读的设置值：样子和输入框对齐，但不能改 */
function ReadValue({ children, mono }: { children: React.ReactNode; mono?: boolean }) {
  return (
    <span
      className={cn(
        'flex h-9 items-center truncate rounded-lg border border-line bg-field/50 px-3 text-[13px] text-muted',
        mono && 'font-mono',
      )}
    >
      {children}
    </span>
  )
}

/** 某个 CLI 的默认模型实际是什么：档位换成那一档的模型，没设置时是 CLI 自己的默认 */
function defaultModelText(def: CliDefinition, d: CliDraft) {
  const v = d.defaultModel
  const tr = tierOf(v)
  if (tr) return `${t('{tier}档', { tier: tr.label })} · ${d.tiers[tr.id].model || tierFallback(def, '', tr.id)}`
  if (v) return v
  const m = cliDefaultModel(def)?.id
  return m ? m + t('（默认）') : t('自动（默认）')
}

function defaultEffortText(def: CliDefinition, d: CliDraft) {
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
          : cli.id === 'claude'
            ? t('{cli} 没有列出模型的命令，下面是常用的型号，也可以直接填写完整的模型名。', { cli: cli.name })
            : t('下面是内置的建议，也可以直接填写模型名。')
  return <p className={cn('pt-1 text-xs leading-relaxed', data.error ? 'text-warning' : 'text-subtle')}>{text}</p>
}

function CliSection({
  def,
  draft,
  status,
  isDefault,
  onChange,
  onDetect,
  detecting,
}: {
  def: CliDefinition
  draft: CliDraft
  status?: CliStatus
  isDefault: boolean
  onChange: (d: CliDraft) => void
  onDetect: () => void
  detecting: boolean
}) {
  const set = <K extends keyof CliDraft>(k: K, v: CliDraft[K]) => onChange({ ...draft, [k]: v })
  // 模型和思考强度用本机 CLI 实际支持的
  const full = useCliDef(def.id) ?? def
  const models = useCliModels(def.id)
  const perm = def.permissions.find((p) => p.id === draft.permission) ?? def.permissions[0]
  const ok = status?.installed
  const installer = useCliInstaller(def)
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
        <Switch
          checked={draft.enabled}
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
            placeholder={
              def.id === 'codex'
                ? 'OPENAI_API_KEY=sk-...'
                : def.id === 'claude'
                  ? 'ANTHROPIC_API_KEY=sk-ant-...'
                  : 'HTTPS_PROXY=http://127.0.0.1:7890'
            }
            className="font-mono text-[13px]"
            spellCheck={false}
          />
        </Row>
        <div className="pt-4">
          <CommandPreview
            cli={def.id}
            model=""
            extraArgs={[]}
            title={t('实际调用（任务描述从 stdin 传入）')}
            override={{
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
    </>
  )
}

const toDraft = (s: Settings): Record<string, CliDraft> =>
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
        },
      ]
    }),
  )

/** 会跳过确认、不受沙箱限制的权限档，说明文字标成警告色 */
const DANGER_PERMS = ['bypassPermissions', 'danger-full-access', 'yolo']

interface Section {
  id: string
  label: string
  icon?: LucideIcon
  cli?: CliDefinition
}

const sectionsFor = (clis: CliDefinition[]): Section[] => [
  { id: 'general', label: t('常规'), icon: Settings2 },
  { id: 'categories', label: t('项目分类'), icon: Layers },
  { id: 'models', label: t('默认 CLI'), icon: Cpu },
  ...clis.map((c) => ({ id: `cli:${c.id}`, label: c.name, cli: c })),
  { id: 'assist', label: t('AI 创建'), icon: Sparkles },
  { id: 'data', label: t('数据'), icon: HardDrive },
  { id: 'update', label: t('版本更新'), icon: ArrowUpCircle },
]

function SettingsBody({
  initial,
  section,
  onSection,
}: {
  initial: Settings
  section: string
  onSection: (s: string) => void
}) {
  const { setSettings, clis, refreshClis } = useData()
  const [timeout, setTimeoutMin] = useState(String(initial.stepTimeoutMinutes))
  const [notify, setNotifyOn] = useState(notifyEnabled)
  const [openBrowser, setOpenBrowser] = useState(initial.openBrowser)
  const [contentWidth, setContentWidth] = useState(initial.contentWidth)
  const [language, setLanguage] = useState(initial.language)
  const [cliOrder, setCliOrder] = useState(() => orderClis(CLIS, initial.cliOrder).map((c) => c.id))
  const ordered = orderClis(CLIS, cliOrder)
  const SECTIONS = sectionsFor(ordered)
  // 侧栏里拖动 CLI 调整顺序：拖到哪一项上就插到那里
  const [dragging, setDragging] = useState('')
  const moveCli = (id: string, to: number) =>
    setCliOrder((o) => {
      const from = o.indexOf(id)
      if (from < 0 || to < 0 || to >= o.length || from === to) return o
      const next = o.filter((x) => x !== id)
      next.splice(to, 0, id)
      return next
    })
  const [drafts, setDrafts] = useState(() => toDraft(initial))
  const [detecting, setDetecting] = useState(false)
  const [assist, setAssist] = useState(initial.assist)
  const [defCli, setDefCli] = useState(() => defaultCli(initial))
  const demo = !!import.meta.env.VITE_DEMO
  const update = useAppUpdate().data?.update
  // 安装 / 卸载结束后重新检测，并提示结果；进度在 cli-install 里，切换页面不会丢
  useEffect(() => {
    setInstallFinish((j) => {
      const name = CLIS.find((c) => c.id === j.cli)?.name ?? j.cli
      void Promise.all([refreshClis().catch(() => {}), loadCliModels(j.cli, true).catch(() => {})])
      // 服务端改用了 npm 装的那个可执行文件：同步到这里，免得自动保存又改回去
      if (j.note)
        void api.settings().then((fresh) => {
          setSettings(fresh)
          setDrafts((d) => ({ ...d, [j.cli]: { ...d[j.cli], command: fresh.clis[j.cli]?.command ?? '' } }))
        })
      const kind = j.action === 'uninstall' ? 'uninstall' : j.update ? 'update' : 'install'
      if (j.status === 'done')
        toast.success(
          {
            install: t('{name} 已安装', { name }),
            update: t('{name} 已更新', { name }),
            uninstall: t('{name} 已卸载', { name }),
          }[kind],
        )
      else
        toast.error(
          {
            install: t('{name} 安装失败', { name }),
            update: t('{name} 更新失败', { name }),
            uninstall: t('{name} 卸载失败', { name }),
          }[kind],
        )
    })
    void resumeInstallJobs()
  }, [refreshClis])
  // 打开设置就开始读各个 CLI 的模型列表，切到 CLI 页时多半已经读好（Command Code 第一次要几秒）
  useEffect(() => {
    for (const c of CLIS) loadCliModels(c.id).catch(() => {})
  }, [])

  const minutes = Number(timeout)
  const valid = timeout !== '' && Number.isInteger(minutes) && minutes >= 0 && minutes <= 1440
  const tier = (x: { model: string; effort: string }) => ({ model: x.model.trim(), effort: x.effort })
  const value: Settings = {
    openBrowser,
    contentWidth,
    language,
    cliOrder,
    stepTimeoutMinutes: valid ? minutes : initial.stepTimeoutMinutes,
    defaultCli: defCli,
    clis: Object.fromEntries(
      Object.entries(drafts).map(([id, d]) => [
        id,
        {
          enabled: d.enabled,
          command: d.command.trim(),
          defaultModel: d.defaultModel.trim(),
          defaultEffort: d.defaultEffort,
          tiers: { high: tier(d.tiers.high), medium: tier(d.tiers.medium), low: tier(d.tiers.low) },
          permission: d.permission,
          extraArgs: splitArgs(d.args),
          env: textToEnv(d.envText),
        },
      ]),
    ),
    assist: { ...assist, model: assist.model.trim() },
  }
  const save = useAutosave(
    value,
    async (v) => {
      setSettings(await api.saveSettings(v))
      await refreshClis()
    },
    // 超时填错时这一项沿用原值，其他设置照常保存
    true,
  )

  const detect = async () => {
    setDetecting(true)
    try {
      // 模型列表跟着重新读：装了新版本、换了账号或改了环境变量后能用的模型可能变了
      await Promise.all([refreshClis(), ...CLIS.map((c) => loadCliModels(c.id, true).catch(() => {}))])
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setDetecting(false)
    }
  }

  const cur = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0]
  const statusOf = (id: string) => clis.find((c) => c.id === id)
  const inCli = cur.id === 'models' || !!cur.cli
  const defDef = useCliDef(defCli) ?? CLIS.find((c) => c.id === defCli)!

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <nav
        aria-label={t('设置分类')}
        className="flex shrink-0 gap-0.5 overflow-x-auto border-b bg-rail p-2 md:w-[220px] md:flex-col md:overflow-visible md:border-r md:border-b-0 md:p-3"
      >
        <span className="hidden px-2.5 pt-1 pb-3 font-serif text-[20px] font-semibold md:block">{t('设置')}</span>
        {SECTIONS.filter((s) => !s.cli).map((s) => {
          // CLI 相关的几页（默认 CLI 和各个 CLI）在左栏里合成一项「CLI」
          const on = s.id === 'models' ? inCli : s.id === cur.id
          return (
            <button
              key={s.id}
              onClick={() => onSection(s.id)}
              aria-current={on ? 'page' : undefined}
              className={cn(
                'flex h-9 shrink-0 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] whitespace-nowrap transition-colors',
                on ? 'bg-sel font-medium text-fg' : 'text-muted hover:bg-sel/70 hover:text-fg',
              )}
            >
              {s.id === 'models' ? (
                <SquareTerminal className="h-4 w-4 shrink-0" strokeWidth={1.8} />
              ) : (
                s.icon && <s.icon className="h-4 w-4 shrink-0" strokeWidth={1.8} />
              )}
              <span className="truncate">{s.id === 'models' ? 'CLI' : s.label}</span>
              {s.id === 'update' && update && (
                <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-accent" title={t('有新版本')} />
              )}
            </button>
          )
        })}
      </nav>

      {inCli && (
        // CLI 的二级列表：默认 CLI 和各个 CLI，CLI 可以拖动调整顺序（新建 Agent、下拉框里也按这个顺序）
        <nav
          aria-label="CLI"
          className="flex shrink-0 gap-0.5 overflow-x-auto border-b p-2 md:w-[232px] md:flex-col md:overflow-visible md:border-r md:border-b-0 md:p-3 md:pt-6"
        >
          {SECTIONS.filter((s) => s.id === 'models' || s.cli).map((s, i, list) => {
            const on = s.id === cur.id
            const st = s.cli && statusOf(s.cli.id)
            return (
              <div key={s.id} className="contents">
                {s.cli && !list[i - 1]?.cli && (
                  <span className="hidden items-center justify-between px-2.5 pt-3 pb-1 text-[11px] text-subtle md:flex">
                    {t('已接入')}
                    <span className="text-[10.5px] text-subtle/80">{t('拖动调整顺序')}</span>
                  </span>
                )}
                <button
                  onClick={() => onSection(s.id)}
                  aria-current={on ? 'page' : undefined}
                  title={s.cli ? t('拖动调整顺序，或按 Alt + ↑ / ↓') : undefined}
                  draggable={!!s.cli}
                  onDragStart={(e) => {
                    if (!s.cli) return
                    e.dataTransfer.effectAllowed = 'move'
                    e.dataTransfer.setData('text/plain', s.cli.id)
                    setDragging(s.cli.id)
                  }}
                  onDragOver={(e) => {
                    if (!dragging || !s.cli) return
                    e.preventDefault()
                    if (s.cli.id !== dragging) moveCli(dragging, cliOrder.indexOf(s.cli.id))
                  }}
                  onDrop={(e) => e.preventDefault()}
                  onDragEnd={() => setDragging('')}
                  onKeyDown={(e) => {
                    if (!s.cli || !e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
                    e.preventDefault()
                    moveCli(s.cli.id, cliOrder.indexOf(s.cli.id) + (e.key === 'ArrowUp' ? -1 : 1))
                  }}
                  className={cn(
                    'group flex h-9 shrink-0 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] whitespace-nowrap transition-colors',
                    on ? 'bg-sel font-medium text-fg' : 'text-muted hover:bg-sel/70 hover:text-fg',
                    s.cli && dragging === s.cli.id && 'opacity-50',
                  )}
                >
                  {s.cli ? (
                    <span className="h-4 w-4 shrink-0 rounded-[4px]" style={{ background: cliColor(s.cli.id) }} />
                  ) : (
                    s.icon && <s.icon className="h-4 w-4 shrink-0" strokeWidth={1.8} />
                  )}
                  <span className="truncate">{s.label}</span>
                  {s.cli && defCli === s.cli.id && (
                    <span className="text-[11px] font-normal text-subtle">{t('默认')}</span>
                  )}
                  {s.cli && (
                    <GripVertical className="ml-auto hidden h-3.5 w-3.5 shrink-0 text-subtle opacity-0 group-hover:opacity-100 md:block" />
                  )}
                  {st && (
                    <span
                      className={cn(
                        'hidden h-1.5 w-1.5 shrink-0 rounded-full md:block',
                        !st.enabled ? 'bg-line-strong' : st.installed ? 'bg-success' : 'bg-warning',
                      )}
                    />
                  )}
                </button>
              </div>
            )
          })}
        </nav>
      )}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center gap-3 px-5 pt-5 pb-3 md:px-8 md:pt-7">
          <h2 className="min-w-0 flex-1 truncate font-serif text-[20px] font-semibold">{cur.label}</h2>
          <SaveIndicator {...save} invalid={valid ? undefined : t('超时时间需要是 0 到 1440 的整数')} />
          <DialogCloseButton label={t('关闭设置')} />
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-10 md:px-8">
          {cur.id === 'general' && (
            <Group>
              {demo && (
                <p className="mb-2 flex gap-2.5 rounded-xl border p-3.5 text-[13px] leading-relaxed text-subtle">
                  <FlaskConical className="mt-0.5 h-4 w-4 shrink-0" />
                  {t('在线演示没有本机环境，任务的输出都是示例；下载到本机运行后会真正调用 CLI。')}
                </p>
              )}
              <Row
                title={t('单个步骤最长运行时间')}
                desc={t('分钟，填 0 不限制。超时后会停止这一步，任务标记为失败。')}
              >
                <div className="flex flex-col gap-1">
                  <Input
                    inputMode="numeric"
                    value={timeout}
                    onChange={(e) => setTimeoutMin(e.target.value.replace(/[^\d]/g, ''))}
                    aria-invalid={!valid}
                    className={cn('h-9', !valid && 'border-danger focus:border-danger focus:ring-danger/20')}
                    aria-label={t('单个步骤最长运行时间（分钟）')}
                  />
                  {!valid && <span className="text-xs text-danger">{t('填 0 到 1440 之间的整数，0 表示不限制')}</span>}
                </div>
              </Row>
              <Row title="语言 · Language" desc={t('界面显示的语言，切换后页面会重新加载。')}>
                <Select
                  aria-label={t('语言')}
                  value={language}
                  onChange={async (e) => {
                    const v = e.target.value as Settings['language']
                    setLanguage(v)
                    // 文案在页面加载时就定了，保存后重新加载页面
                    try {
                      setSettings(await api.saveSettings({ ...value, language: v }))
                    } catch (err) {
                      return toast.error((err as Error).message)
                    }
                    switchLang(v)
                  }}
                  options={[
                    { value: 'auto', label: t('跟随浏览器 · Auto') },
                    ...LANGS.map((l) => ({ value: l.id, label: l.label })),
                  ]}
                  className="w-48"
                />
              </Row>
              <Row
                title={t('内容宽度')}
                desc={t('项目首页的输入框和任务列表、任务页的对话和工作流节点都用这个宽度，窗口窄时自动缩小。')}
              >
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min={640}
                    max={CONTENT_MAX}
                    step={20}
                    value={contentWidth}
                    aria-label={t('内容宽度')}
                    onChange={(e) => {
                      const w = Number(e.target.value)
                      setContentWidth(w)
                      // 拖动时立即生效，不用等保存
                      applyContentWidth(w)
                    }}
                    className="w-40 cursor-pointer accent-[var(--color-accent)]"
                  />
                  <span className="w-14 font-mono text-[13px] text-muted tabular-nums">{contentWidth}px</span>
                  {contentWidth !== CONTENT_WIDTH && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setContentWidth(CONTENT_WIDTH)
                        applyContentWidth(CONTENT_WIDTH)
                      }}
                    >
                      {t('恢复默认')}
                    </Button>
                  )}
                </div>
              </Row>
              {!demo && (
                <Row
                  title={t('启动后打开浏览器')}
                  desc={t('启动面板服务后，自动用默认浏览器打开 http://127.0.0.1:8787。')}
                >
                  <Switch aria-label={t('启动后打开浏览器')} checked={openBrowser} onCheckedChange={setOpenBrowser} />
                </Row>
              )}
              <Row
                title={t('任务完成时通知我')}
                desc={t('页面不在前台时，任务完成或失败会弹出系统通知。需要浏览器允许通知。')}
              >
                <Switch
                  aria-label={t('任务完成时通知我')}
                  checked={notify}
                  disabled={!notifySupported()}
                  onCheckedChange={async (on) => {
                    const ok = await setNotify(on)
                    setNotifyOn(ok)
                    if (on && !ok) toast.error(t('浏览器没有允许通知，可以在地址栏左侧的网站设置里打开'))
                  }}
                />
              </Row>
            </Group>
          )}

          {cur.id === 'models' && (
            <>
              <p className="text-[13px] leading-relaxed text-subtle">
                {t(
                  'Agent 可以不指定 CLI，选「系统默认」时用这里的 CLI；模型可以只选高、中、低一档，执行时换成那个 CLI 对应档位的模型和思考强度。改这里就能让所有用默认设置的 Agent 一起切换。',
                )}
              </p>
              <Group>
                <Row title={t('默认 CLI')} desc={t('Agent 选了「系统默认」或没有指定 CLI 时使用')}>
                  <Select
                    aria-label={t('默认 CLI')}
                    value={defCli}
                    onChange={(e) => setDefCli(e.target.value)}
                    className="w-[240px]"
                    options={ordered.map((c) => {
                      const st = statusOf(c.id)
                      const note = !st
                        ? ''
                        : !st.enabled
                          ? ` · ${t('已停用')}`
                          : st.installed
                            ? ''
                            : ` · ${t('未安装')}`
                      return { value: c.id, label: c.name + note }
                    })}
                  />
                </Row>
              </Group>
              <Group title={t('{cli} 的模型', { cli: defDef.name })}>
                <Row
                  title={t('三档模型')}
                  desc={
                    <>
                      {t('跟随 {cli} 自己的档位设置，要改请到', { cli: defDef.name })}{' '}
                      <button
                        className="cursor-pointer text-accent hover:underline"
                        onClick={() => onSection(`cli:${defCli}`)}
                      >
                        {defDef.name}
                      </button>{' '}
                      {t('里修改。')}
                    </>
                  }
                  stack
                >
                  <TierTable
                    def={defDef}
                    value={drafts[defCli].tiers}
                    defaultModel={drafts[defCli].defaultModel}
                    readOnly
                  />
                </Row>
                {/* 默认模型和思考强度也只展示，在对应 CLI 里改 */}
                <Row
                  title={t('默认模型')}
                  desc={t('Agent 没有指定模型时使用，跟随 {cli} 的设置', { cli: defDef.name })}
                >
                  <ReadValue mono>{defaultModelText(defDef, drafts[defCli])}</ReadValue>
                </Row>
                <Row
                  title={t('默认思考强度')}
                  desc={t('Agent 和档位都没有指定时使用，跟随 {cli} 的设置', { cli: defDef.name })}
                >
                  <ReadValue>{defaultEffortText(defDef, drafts[defCli])}</ReadValue>
                </Row>
              </Group>
            </>
          )}

          {cur.cli && (
            <CliSection
              key={cur.cli.id}
              def={cur.cli}
              draft={drafts[cur.cli.id]}
              status={statusOf(cur.cli.id)}
              isDefault={defCli === cur.cli.id}
              onChange={(d) => setDrafts((ds) => ({ ...ds, [cur.cli!.id]: d }))}
              onDetect={detect}
              detecting={detecting}
            />
          )}

          {cur.id === 'data' && <DataSection />}
          {cur.id === 'update' && <UpdateSection />}

          {cur.id === 'categories' && <ProjectCategoryList />}

          {cur.id === 'assist' && (
            <>
              <p className="text-[13px] leading-relaxed text-subtle">
                {t(
                  '在 Agent 和工作流页面可以用本机 CLI 对话生成或优化配置。CLI 按固定格式输出，面板校验通过后才能应用。',
                )}
              </p>
              <Group>
                <Row title={t('使用的 CLI')} desc={t('默认用「CLI」里设为默认的那个')}>
                  <Select
                    aria-label={t('AI 创建使用的 CLI')}
                    value={assist.cli || defCli}
                    // 选回默认的就不单独记，之后换了默认 CLI 会跟着变
                    // 换 CLI 时模型名不通用，清空回到那个 CLI 的默认模型
                    onChange={(e) =>
                      setAssist({ ...assist, cli: e.target.value === defCli ? '' : e.target.value, model: '' })
                    }
                    options={ordered.map((c) => ({
                      value: c.id,
                      label: `${c.name}${c.id === defCli ? t('（默认）') : ''}`,
                    }))}
                  />
                </Row>
                <Row title={t('模型')} desc={t('默认用这个 CLI 设置里的默认模型')}>
                  <AssistModel
                    key={assist.cli || defCli}
                    cli={assist.cli || defCli}
                    draft={drafts[assist.cli || defCli]}
                    value={assist.model}
                    onChange={(v) => setAssist({ ...assist, model: v })}
                  />
                </Row>
                <Row title={t('创建 Agent 的补充规则')} desc={t('会加进提示词，例如命名习惯、团队约定')} stack>
                  <Textarea
                    rows={4}
                    value={assist.agentRules}
                    onChange={(e) => setAssist({ ...assist, agentRules: e.target.value })}
                    placeholder={t(
                      '例如：\n- 角色设定统一包含「职责 / 工作方式 / 交付标准」三节\n- 前端相关的 Agent 默认用 Claude Code',
                    )}
                    className="font-mono text-[13px]"
                  />
                </Row>
                <Row title={t('创建工作流的补充规则')} stack>
                  <Textarea
                    rows={4}
                    value={assist.workflowRules}
                    onChange={(e) => setAssist({ ...assist, workflowRules: e.target.value })}
                    placeholder={t('例如：\n- 写代码的节点都要配一个代码审查的验收流程\n- 验收最多 2 轮')}
                    className="font-mono text-[13px]"
                  />
                </Row>
              </Group>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** 设置弹窗，参考 Claude 的设置：左边分类，右边一行一项，改动自动保存 */
export function SettingsDialog({
  open,
  section,
  onOpenChange,
}: {
  open: boolean
  section?: string
  onOpenChange: (open: boolean) => void
}) {
  const { settings } = useData()
  const [cur, setCur] = useState(section ?? 'general')
  useEffect(() => {
    if (open) setCur(section ?? 'general')
  }, [open, section])
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/45 animate-[fade-in_150ms_ease-out]" />
        <D.Content
          aria-describedby={undefined}
          // 点设置外面的空白处不关闭，避免改到一半误关；用右上角的关闭按钮或 Esc 关闭
          onInteractOutside={(e) => e.preventDefault()}
          className="fixed top-1/2 left-1/2 z-50 h-[min(840px,calc(100dvh-2rem))] w-[min(1200px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl border border-line-strong bg-card shadow-pop animate-[pop-in_160ms_ease-out] focus:outline-none"
        >
          <D.Title className="sr-only">{t('设置')}</D.Title>
          {settings && <SettingsBody initial={settings} section={cur} onSection={setCur} />}
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}
