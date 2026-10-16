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
} from 'lucide-react'
import { CLIS, MODEL_TIERS, type CliDefinition, type ModelTier } from '@shared/clis'
import {
  CliSettings,
  type CliInstallJob,
  type CliModels,
  type CliUpdate,
  type CliStatus,
  type Settings,
} from '@shared/schema'
import { cliSettings, defaultCli, orderClis, tierOf } from '@shared/settings'
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
import { ModelSelect } from '@/components/agents/ModelSelect'
import { ProjectCategoryList } from '@/components/projects/ProjectCategoryList'
import { DialogCloseButton } from '@/components/projects/ProjectSettingsDialog'
import { useAppUpdate } from '@/lib/app-update'

const envToText = (env: CliSettings['env']) => env.map((e) => `${e.key}=${e.value}`).join('\n')
const textToEnv = (t: string) =>
  t
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
      title="复制安装命令"
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
    (t) =>
      t.status === 'running' &&
      agents.some(
        (a) =>
          (a.cli || (settings ? defaultCli(settings) : '')) === def.id &&
          t.steps.some((s) => s.agentId === a.id && s.status === 'running'),
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
  const verb = job.action === 'uninstall' ? '卸载' : job.update ? '更新' : '安装'
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
        <span className="min-w-0 flex-1">
          {job.status === 'running' ? `正在${verb}…` : job.status === 'done' ? `${verb}完成` : `${verb}没有成功`}
        </span>
        <button
          onClick={() => setOpen((o) => !o)}
          className="cursor-pointer rounded-md px-1.5 py-0.5 text-xs text-muted hover:bg-sel hover:text-fg"
        >
          {open ? '收起输出' : '查看输出'}
        </button>
        {job.status !== 'running' && (
          <button
            onClick={onClose}
            aria-label="关闭"
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
          在终端里运行 <CopyText text={job.command} />
        </p>
      )}
      {open && (
        <pre
          ref={pre}
          className="max-h-56 overflow-auto border-t bg-field/60 px-3.5 py-2.5 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-muted"
        >
          <span className="text-subtle">$ {job.command}</span>
          {'\n'}
          {job.log || (job.status === 'running' ? '等待输出…' : '没有输出')}
        </pre>
      )}
    </div>
  )
}

/** 高 / 中 / 低三档：每档一个模型和思考强度，留空用灰色的建议值 */
function TierTable({
  def,
  value,
  onChange,
  readOnly,
}: {
  def: CliDefinition
  value: CliDraft['tiers']
  onChange?: (v: CliDraft['tiers']) => void
  /** 只展示：「默认 CLI」里跟随那个 CLI 自己的档位设置 */
  readOnly?: boolean
}) {
  const set = (t: ModelTier, k: 'model' | 'effort', v: string) => onChange?.({ ...value, [t]: { ...value[t], [k]: v } })
  return (
    <div className="overflow-hidden rounded-xl border">
      <div className="hidden grid-cols-[120px_1fr_170px] gap-3 border-b bg-field/50 px-3.5 py-2 text-xs text-subtle sm:grid">
        <span>档位</span>
        <span>模型</span>
        <span>思考强度</span>
      </div>
      {MODEL_TIERS.map((t) => {
        const sug = def.tiers[t.id]
        return (
          <div
            key={t.id}
            className="grid grid-cols-1 gap-2 border-b px-3.5 py-3 last:border-b-0 sm:grid-cols-[120px_1fr_170px] sm:items-center sm:gap-3"
          >
            <span className="flex items-center gap-2">
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-accent-soft text-xs font-semibold text-accent">
                {t.label}
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="text-[13px]">{t.label}档</span>
                <span className="truncate text-[11px] text-subtle">{t.hint}</span>
              </span>
            </span>
            {readOnly ? (
              <>
                <span className="truncate font-mono text-[13px]">{value[t.id].model || sug.model}</span>
                <span className="truncate text-[13px] text-muted">
                  {(value[t.id].effort || sug.effort) &&
                    `${value[t.id].effort || sug.effort} · ${effortLabel(def, value[t.id].effort || sug.effort)}`}
                </span>
              </>
            ) : (
              <>
                {/* 档位自己的模型下拉不列档位；留空是内置的建议值，标（默认） */}
                <ModelSelect
                  aria-label={`${def.name} ${t.label}档模型`}
                  def={def}
                  value={value[t.id].model}
                  onChange={(v) => set(t.id, 'model', v)}
                  defaultValue={sug.model}
                />
                <Select
                  aria-label={`${def.name} ${t.label}档思考强度`}
                  value={value[t.id].effort === sug.effort ? '' : value[t.id].effort}
                  onChange={(e) => set(t.id, 'effort', e.target.value)}
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
  const t = tierOf(v)
  if (t) return `${t.label}档 · ${d.tiers[t.id].model || def.tiers[t.id].model}`
  if (v) return v
  const m = cliDefaultModel(def)?.id
  return m ? `${m}（默认）` : '自动（默认）'
}

function defaultEffortText(def: CliDefinition, d: CliDraft) {
  const e = d.defaultEffort || cliDefaultModel(def)?.defaultEffort
  if (!e) return 'auto · 自动（默认）'
  return `${e} · ${effortLabel(def, e)}${d.defaultEffort ? '' : '（默认）'}`
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
    high: { model: draft.tiers.high.model || def.tiers.high.model },
    medium: { model: draft.tiers.medium.model || def.tiers.medium.model },
    low: { model: draft.tiers.low.model || def.tiers.low.model },
  }
  return (
    <ModelSelect
      aria-label={`${def.name} 默认模型`}
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
        正在从本机 {cli.name} 读取可用的模型…
      </p>
    )
  // 账号登录列出账号能用的全部模型；API 方式列出配置文件里配的模型
  const how =
    data.auth === 'account'
      ? `已用${data.from ? ` ${data.from} ` : '账号'}登录，`
      : data.auth === 'api'
        ? `用的是 API 方式，${data.from ? `下面是 ${data.from} 里配置的模型，` : '配置文件里没有写模型，'}`
        : ''
  const text =
    data.source === 'cli'
      ? `${how}已从本机 ${cli.name} 读到 ${data.models.length} 个可用模型。`
      : data.auth === 'api' && !data.error
        ? `${how}下面是常用的别名和型号，也可以直接填写模型名。`
        : data.error
          ? `没能从 ${cli.name} 读到模型列表（${data.error}），下面是内置的建议，也可以直接填写模型名。`
          : cli.id === 'claude'
            ? `${cli.name} 没有列出模型的命令，下面是常用的别名和型号，也可以直接填写完整的模型名。`
            : '下面是内置的建议，也可以直接填写模型名。'
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
                系统默认
              </span>
            )}
          </p>
          <p
            className={cn('truncate text-xs', !status ? 'text-subtle' : ok ? 'text-success' : 'text-warning')}
            title={status?.error}
          >
            {!status ? '检测中…' : ok ? `已安装 · ${status.version}` : `没有检测到：${status.error ?? ''}`}
          </p>
        </div>
        {status && !ok && (
          <Button size="sm" onClick={() => installer.start('install')} disabled={installer.running}>
            {installer.running ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            安装
          </Button>
        )}
        {status && ok && (
          <>
            {(update?.available || (installer.running && installer.job?.action === 'install')) && (
              <Button
                variant="secondary"
                size="sm"
                title={update ? `当前 ${update.current}，npm 上最新是 ${update.latest}` : undefined}
                onClick={() => installer.start('install')}
                disabled={installer.running}
              >
                {installer.running && installer.job?.action === 'install' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ArrowUpCircle className="h-3.5 w-3.5" />
                )}
                {installer.running ? '更新中' : `更新到 ${update?.latest}`}
              </Button>
            )}
            <Button variant="danger-outline" size="sm" onClick={() => setRemoving(true)} disabled={installer.running}>
              {installer.running && installer.job?.action === 'uninstall' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
              卸载
            </Button>
          </>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="重新检测"
          title="重新检测"
          onClick={() => {
            onDetect()
            if (ok) void checkUpdate(true)
          }}
          disabled={detecting || installer.running}
        >
          <RefreshCw className={cn('h-3.5 w-3.5', detecting && 'animate-spin')} />
        </Button>
        <Switch checked={draft.enabled} onCheckedChange={(v) => set('enabled', v)} aria-label={`启用 ${def.name}`} />
      </div>
      {installer.job ? (
        <InstallLog key={installer.job.id} job={installer.job} onClose={installer.clear} />
      ) : (
        status &&
        !ok && (
          <p className="flex flex-wrap items-center gap-2 pt-3 text-xs text-muted">
            点「安装」用 npm 安装，或者在终端里运行 <CopyText text={def.installHint} />
            <span className="text-subtle">自己装好后点右边的刷新重新检测。</span>
          </p>
        )
      )}
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={`卸载 ${def.name}？`}
        description={
          <>
            会运行 <code className="font-mono text-[12px]">npm uninstall -g {def.npmPackage}</code>
            。用这个 CLI 的 Agent 之后都无法执行，直到重新安装。登录信息和它自己的配置不会被删除。
          </>
        }
        blocked={installer.busy ? '有任务正在用它执行，请等任务完成或先停止。' : undefined}
        confirmText="卸载"
        onConfirm={() => {
          setRemoving(false)
          return installer.start('uninstall')
        }}
      />

      <Group title="模型">
        <ModelSource cli={def} data={models} />
        <Row title="三档模型" desc="Agent 选了高、中、低档时使用的模型和思考强度。留空用灰色的建议值。" stack>
          <TierTable def={full} value={draft.tiers} onChange={(v) => set('tiers', v)} />
        </Row>
        <Row title="默认模型" desc="Agent 没有指定模型时使用，可以选一个档位">
          <DefaultModel def={full} draft={draft} onChange={(v) => set('defaultModel', v)} />
        </Row>
        <Row title="默认思考强度" desc="Agent 和档位都没有指定时使用">
          <Select
            aria-label={`${def.name} 默认思考强度`}
            value={draft.defaultEffort === cliDefaultModel(full)?.defaultEffort ? '' : draft.defaultEffort}
            onChange={(e) => set('defaultEffort', e.target.value)}
            options={defaultEffortOptions(full, cliDefaultModel(full)?.defaultEffort)}
          />
        </Row>
      </Group>

      <Group title="运行">
        <Row
          title="权限"
          desc={<span className={cn(/任意命令|不使用沙箱/.test(perm.hint) && 'text-warning')}>{perm.hint}</span>}
          stack
        >
          <Segmented
            label={`${def.name} 权限`}
            value={perm.id}
            onChange={(v) => set('permission', v)}
            options={def.permissions.map((p) => ({ id: p.id, label: p.label }))}
          />
        </Row>
        <Row title="可执行文件" desc={`留空时从 PATH 查找 ${def.command}`}>
          <Input
            value={draft.command}
            onChange={(e) => set('command', e.target.value)}
            placeholder={def.command}
            className="h-9 font-mono text-[13px]"
            spellCheck={false}
          />
        </Row>
        <Row title="额外参数" desc="每次调用都会追加，Agent 自己的参数排在后面">
          <Input
            value={draft.args}
            onChange={(e) => set('args', e.target.value)}
            placeholder="例如 --add-dir ../shared"
            className="h-9 font-mono text-[13px]"
            spellCheck={false}
          />
        </Row>
        <Row title="环境变量" desc="每行一个 KEY=VALUE，只传给这个 CLI">
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
            title="实际调用（任务描述从 stdin 传入）"
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

interface Section {
  id: string
  label: string
  icon?: LucideIcon
  cli?: CliDefinition
}

const sectionsFor = (clis: CliDefinition[]): Section[] => [
  { id: 'general', label: '常规', icon: Settings2 },
  { id: 'categories', label: '项目分类', icon: Layers },
  { id: 'models', label: '默认 CLI', icon: Cpu },
  ...clis.map((c) => ({ id: `cli:${c.id}`, label: c.name, cli: c })),
  { id: 'assist', label: 'AI 创建', icon: Sparkles },
  { id: 'update', label: '版本更新', icon: ArrowUpCircle },
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
      const verb = j.action === 'uninstall' ? '卸载' : j.update ? '更新' : '安装'
      if (j.status === 'done') toast.success(`${name} 已${verb}`)
      else toast.error(`${name} ${verb}失败`)
    })
    void resumeInstallJobs()
  }, [refreshClis])
  // 打开设置就开始读各个 CLI 的模型列表，切到 CLI 页时多半已经读好（Command Code 第一次要几秒）
  useEffect(() => {
    for (const c of CLIS) loadCliModels(c.id).catch(() => {})
  }, [])

  const minutes = Number(timeout)
  const valid = Number.isInteger(minutes) && minutes >= 1 && minutes <= 600
  const tier = (t: { model: string; effort: string }) => ({ model: t.model.trim(), effort: t.effort })
  const value: Settings = {
    openBrowser,
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
  const defDef = useCliDef(defCli) ?? CLIS.find((c) => c.id === defCli)!

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <nav
        aria-label="设置分类"
        className="flex shrink-0 gap-0.5 overflow-x-auto border-b bg-rail p-2 md:w-[220px] md:flex-col md:overflow-visible md:border-r md:border-b-0 md:p-3"
      >
        <span className="hidden px-2.5 pt-1 pb-3 font-serif text-[20px] font-semibold md:block">设置</span>
        {SECTIONS.map((s, i) => {
          const on = s.id === cur.id
          const st = s.cli && statusOf(s.cli.id)
          return (
            <div key={s.id} className="contents">
              {s.cli && !SECTIONS[i - 1]?.cli && (
                <span className="hidden items-center justify-between px-2.5 pt-3 pb-1 text-[11px] text-subtle md:flex">
                  CLI
                  <span className="text-[10.5px] text-subtle/80">拖动调整顺序</span>
                </span>
              )}
              <button
                onClick={() => onSection(s.id)}
                aria-current={on ? 'page' : undefined}
                title={s.cli ? '拖动调整顺序，或按 Alt + ↑ / ↓' : undefined}
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
                  'flex h-9 shrink-0 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] whitespace-nowrap transition-colors',
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
                {s.id === 'update' && update && (
                  <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-accent" title="有新版本" />
                )}
                {st && (
                  <span
                    className={cn(
                      'ml-auto hidden h-1.5 w-1.5 shrink-0 rounded-full md:block',
                      !st.enabled ? 'bg-line-strong' : st.installed ? 'bg-success' : 'bg-warning',
                    )}
                  />
                )}
              </button>
            </div>
          )
        })}
      </nav>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center gap-3 px-5 pt-5 pb-3 md:px-8 md:pt-7">
          <h2 className="min-w-0 flex-1 truncate font-serif text-[20px] font-semibold">{cur.label}</h2>
          <SaveIndicator {...save} invalid={valid ? undefined : '超时时间需要是 1 到 600 的整数'} />
          <DialogCloseButton label="关闭设置" />
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-10 md:px-8">
          {cur.id === 'general' && (
            <Group>
              {demo && (
                <p className="mb-2 flex gap-2.5 rounded-xl border p-3.5 text-[13px] leading-relaxed text-subtle">
                  <FlaskConical className="mt-0.5 h-4 w-4 shrink-0" />
                  在线演示没有本机环境，任务的输出都是示例；下载到本机运行后会真正调用 CLI。
                </p>
              )}
              <Row title="单个步骤最长运行时间" desc="分钟。超时后会停止这一步，任务标记为失败。">
                <div className="flex flex-col gap-1">
                  <Input
                    inputMode="numeric"
                    value={timeout}
                    onChange={(e) => setTimeoutMin(e.target.value.replace(/[^\d]/g, ''))}
                    aria-invalid={!valid}
                    className={cn('h-9', !valid && 'border-danger focus:border-danger focus:ring-danger/20')}
                    aria-label="单个步骤最长运行时间（分钟）"
                  />
                  {!valid && <span className="text-xs text-danger">填 1 到 600 之间的整数</span>}
                </div>
              </Row>
              {!demo && (
                <Row title="启动后打开浏览器" desc="启动面板服务后，自动用默认浏览器打开 http://127.0.0.1:8787。">
                  <Switch aria-label="启动后打开浏览器" checked={openBrowser} onCheckedChange={setOpenBrowser} />
                </Row>
              )}
              <Row title="任务完成时通知我" desc="页面不在前台时，任务完成或失败会弹出系统通知。需要浏览器允许通知。">
                <Switch
                  aria-label="任务完成时通知我"
                  checked={notify}
                  disabled={!notifySupported()}
                  onCheckedChange={async (on) => {
                    const ok = await setNotify(on)
                    setNotifyOn(ok)
                    if (on && !ok) toast.error('浏览器没有允许通知，可以在地址栏左侧的网站设置里打开')
                  }}
                />
              </Row>
            </Group>
          )}

          {cur.id === 'models' && (
            <>
              <p className="text-[13px] leading-relaxed text-subtle">
                Agent 可以不指定 CLI，选「系统默认」时用这里的 CLI；模型可以只选高、中、低一档，执行时换成那个 CLI
                对应档位的模型和思考强度。改这里就能让所有用默认设置的 Agent 一起切换。
              </p>
              <div role="radiogroup" aria-label="默认 CLI" className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
                {ordered.map((c) => {
                  const on = defCli === c.id
                  const st = statusOf(c.id)
                  return (
                    <button
                      key={c.id}
                      role="radio"
                      aria-checked={on}
                      onClick={() => setDefCli(c.id)}
                      className={cn(
                        'flex cursor-pointer items-center gap-2.5 rounded-xl border p-3 text-left transition-colors',
                        on ? 'border-accent bg-accent-soft' : 'hover:border-line-strong',
                      )}
                    >
                      <span className="h-7 w-7 shrink-0 rounded-[7px]" style={{ background: cliColor(c.id) }} />
                      <span className="flex min-w-0 flex-col">
                        <span className={cn('text-[13px] font-medium', on && 'text-accent')}>{c.name}</span>
                        <span
                          className={cn(
                            'truncate text-xs',
                            !st ? 'text-subtle' : st.installed ? 'text-success' : 'text-warning',
                          )}
                        >
                          {!st ? '检测中…' : !st.enabled ? '已停用' : st.installed ? '已安装' : '未安装'}
                        </span>
                      </span>
                      {on && <Check className="ml-auto h-4 w-4 shrink-0 text-accent" />}
                    </button>
                  )
                })}
              </div>
              <Group title={`${defDef.name} 的模型`}>
                <Row
                  title="三档模型"
                  desc={
                    <>
                      跟随 {defDef.name} 自己的档位设置，要改请到{' '}
                      <button
                        className="cursor-pointer text-accent hover:underline"
                        onClick={() => onSection(`cli:${defCli}`)}
                      >
                        {defDef.name}
                      </button>{' '}
                      里修改。
                    </>
                  }
                  stack
                >
                  <TierTable def={defDef} value={drafts[defCli].tiers} readOnly />
                </Row>
                {/* 默认模型和思考强度也只展示，在对应 CLI 里改 */}
                <Row title="默认模型" desc={`Agent 没有指定模型时使用，跟随 ${defDef.name} 的设置`}>
                  <ReadValue mono>{defaultModelText(defDef, drafts[defCli])}</ReadValue>
                </Row>
                <Row title="默认思考强度" desc={`Agent 和档位都没有指定时使用，跟随 ${defDef.name} 的设置`}>
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

          {cur.id === 'update' && <UpdateSection />}

          {cur.id === 'categories' && <ProjectCategoryList />}

          {cur.id === 'assist' && (
            <>
              <p className="text-[13px] leading-relaxed text-subtle">
                在 Agent 和工作流页面可以用本机 CLI 对话生成或优化配置。CLI 按固定格式输出，面板校验通过后才能应用。
              </p>
              <Group>
                <Row title="使用的 CLI" desc="默认用「CLI」里设为默认的那个">
                  <Select
                    aria-label="AI 创建使用的 CLI"
                    value={assist.cli || defCli}
                    // 选回默认的就不单独记，之后换了默认 CLI 会跟着变
                    onChange={(e) => setAssist({ ...assist, cli: e.target.value === defCli ? '' : e.target.value })}
                    options={ordered.map((c) => ({
                      value: c.id,
                      label: `${c.name}${c.id === defCli ? '（默认）' : ''}`,
                    }))}
                  />
                </Row>
                <Row title="模型" desc="留空使用该 CLI 的默认模型">
                  <Input
                    value={assist.model}
                    onChange={(e) => setAssist({ ...assist, model: e.target.value })}
                    placeholder="例如 opus"
                    className="h-9 font-mono text-[13px]"
                    spellCheck={false}
                  />
                </Row>
                <Row title="创建 Agent 的补充规则" desc="会加进提示词，例如命名习惯、团队约定" stack>
                  <Textarea
                    rows={4}
                    value={assist.agentRules}
                    onChange={(e) => setAssist({ ...assist, agentRules: e.target.value })}
                    placeholder={
                      '例如：\n- 角色设定统一包含「职责 / 工作方式 / 交付标准」三节\n- 前端相关的 Agent 默认用 Claude Code'
                    }
                    className="font-mono text-[13px]"
                  />
                </Row>
                <Row title="创建工作流的补充规则" stack>
                  <Textarea
                    rows={4}
                    value={assist.workflowRules}
                    onChange={(e) => setAssist({ ...assist, workflowRules: e.target.value })}
                    placeholder={'例如：\n- 写代码的节点都要配一个代码审查的验收流程\n- 验收最多 2 轮'}
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
          className="fixed top-1/2 left-1/2 z-50 h-[min(720px,calc(100dvh-2rem))] w-[min(980px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl border border-line-strong bg-card shadow-pop animate-[pop-in_160ms_ease-out] focus:outline-none"
        >
          <D.Title className="sr-only">设置</D.Title>
          {settings && <SettingsBody initial={settings} section={cur} onSection={setCur} />}
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}
