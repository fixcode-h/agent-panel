import { useEffect, useState } from 'react'
import * as D from '@radix-ui/react-dialog'
import { toast } from 'sonner'
import { Check, Copy, Cpu, FlaskConical, Play, RefreshCw, Settings2, Sparkles, X, type LucideIcon } from 'lucide-react'
import { CLIS, MODEL_TIERS, type CliDefinition, type ModelTier } from '@shared/clis'
import { CliSettings, type CliStatus, type Settings } from '@shared/schema'
import { cliSettings, defaultCli, tierOf } from '@shared/settings'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { cliColor, effortLabel, effortOptions } from '@/lib/cli-style'
import { useAutosave } from '@/lib/useAutosave'
import { cn, joinArgs, splitArgs } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ComboInput, Input, Select, Textarea } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { SaveIndicator } from '@/components/layout/Detail'
import { CommandPreview } from '@/components/agents/CommandPreview'

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

function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T
  onChange: (v: T) => void
  options: { id: T; label: string; disabled?: boolean }[]
  label: string
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex max-w-full flex-wrap rounded-lg bg-field p-0.5">
      {options.map((o) => (
        <button
          key={o.id}
          role="radio"
          aria-checked={value === o.id}
          disabled={o.disabled}
          onClick={() => onChange(o.id)}
          className={cn(
            'h-8 cursor-pointer rounded-md px-3 text-[13px] transition-colors disabled:cursor-not-allowed disabled:opacity-40',
            value === o.id ? 'bg-card font-medium text-fg shadow-card' : 'text-muted hover:text-fg',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
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

/** 高 / 中 / 低三档：每档一个模型和思考强度，留空用灰色的建议值 */
function TierTable({
  def,
  value,
  onChange,
}: {
  def: CliDefinition
  value: CliDraft['tiers']
  onChange: (v: CliDraft['tiers']) => void
}) {
  const set = (t: ModelTier, k: 'model' | 'effort', v: string) => onChange({ ...value, [t]: { ...value[t], [k]: v } })
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
            <ComboInput
              aria-label={`${def.name} ${t.label}档模型`}
              suggestions={def.models.map((m) => ({ value: m.id, label: m.label }))}
              value={value[t.id].model}
              onChange={(v) => set(t.id, 'model', v)}
              placeholder={sug.model}
              className="h-9 font-mono text-[13px]"
              spellCheck={false}
            />
            <Select
              aria-label={`${def.name} ${t.label}档思考强度`}
              value={value[t.id].effort}
              onChange={(e) => set(t.id, 'effort', e.target.value)}
              options={effortOptions(def, sug.effort ? `建议 · ${effortLabel(def, sug.effort)}` : '不指定')}
            />
          </div>
        )
      })}
    </div>
  )
}

/** 默认模型：可以是档位、CLI 自己的默认，或者具体模型 */
function DefaultModel({
  def,
  draft,
  onChange,
}: {
  def: CliDefinition
  draft: CliDraft
  onChange: (v: string) => void
}) {
  const v = draft.defaultModel
  const [custom, setCustom] = useState(() => !!v && !tierOf(v) && !def.models.some((m) => m.id === v))
  const tierModel = (t: ModelTier) => draft.tiers[t].model || def.tiers[t].model
  return (
    <div className="flex flex-col gap-2">
      <Select
        aria-label={`${def.name} 默认模型`}
        value={custom ? '__custom' : v}
        onChange={(e) => {
          const x = e.target.value
          setCustom(x === '__custom')
          if (x !== '__custom') onChange(x)
        }}
        options={[
          ...MODEL_TIERS.map((t) => ({ value: `@${t.id}`, label: `${t.label}档 · ${tierModel(t.id)}` })),
          { value: '', label: 'CLI 自己的默认' },
          ...def.models.map((m) => ({ value: m.id, label: m.label })),
          { value: '__custom', label: '其他模型…' },
        ]}
      />
      {custom && (
        <Input
          autoFocus
          aria-label="模型名"
          value={v}
          onChange={(e) => onChange(e.target.value)}
          placeholder="填写模型名"
          className="h-9 font-mono text-[13px]"
          spellCheck={false}
        />
      )}
    </div>
  )
}

function CliSection({
  def,
  draft,
  status,
  isDefault,
  onChange,
  onMakeDefault,
  onDetect,
  detecting,
}: {
  def: CliDefinition
  draft: CliDraft
  status?: CliStatus
  isDefault: boolean
  onChange: (d: CliDraft) => void
  onMakeDefault: () => void
  onDetect: () => void
  detecting: boolean
}) {
  const set = <K extends keyof CliDraft>(k: K, v: CliDraft[K]) => onChange({ ...draft, [k]: v })
  const perm = def.permissions.find((p) => p.id === draft.permission) ?? def.permissions[0]
  const ok = status?.installed
  return (
    <>
      <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-field/40 p-3.5">
        <span className="h-10 w-10 shrink-0 rounded-[10px]" style={{ background: cliColor(def.id) }} />
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
        <Button variant="secondary" size="sm" onClick={onDetect} disabled={detecting}>
          <RefreshCw className={cn('h-3.5 w-3.5', detecting && 'animate-spin')} />
          重新检测
        </Button>
        <Switch checked={draft.enabled} onCheckedChange={(v) => set('enabled', v)} aria-label={`启用 ${def.name}`} />
      </div>
      {status && !ok && (
        <p className="flex flex-wrap items-center gap-2 pt-3 text-xs text-muted">
          安装命令 <CopyText text={def.installHint} />
          <span className="text-subtle">安装后点「重新检测」。</span>
        </p>
      )}

      <Group title="模型">
        <Row title="三档模型" desc="Agent 选了高、中、低档时使用的模型和思考强度。留空用灰色的建议值。" stack>
          <TierTable def={def} value={draft.tiers} onChange={(v) => set('tiers', v)} />
        </Row>
        <Row title="默认模型" desc="Agent 没有指定模型时使用，可以选一个档位">
          <DefaultModel def={def} draft={draft} onChange={(v) => set('defaultModel', v)} />
        </Row>
        <Row title="默认思考强度" desc="Agent 和档位都没有指定时使用">
          <Select
            aria-label={`${def.name} 默认思考强度`}
            value={draft.defaultEffort}
            onChange={(e) => set('defaultEffort', e.target.value)}
            options={effortOptions(def, 'CLI 自己的默认')}
          />
        </Row>
        {!isDefault && (
          <Row title="设为系统默认" desc="Agent 的 CLI 选「系统默认」时使用这个 CLI">
            <Button variant="secondary" size="sm" onClick={onMakeDefault}>
              设为默认 CLI
            </Button>
          </Row>
        )}
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
          <CommandPreview cli={def.id} model="" extraArgs={[]} title="实际调用（任务描述从 stdin 传入）" />
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

const SECTIONS: Section[] = [
  { id: 'general', label: '常规', icon: Settings2 },
  { id: 'models', label: '默认 CLI', icon: Cpu },
  ...CLIS.map((c) => ({ id: `cli:${c.id}`, label: c.name, cli: c })),
  { id: 'assist', label: 'AI 创建', icon: Sparkles },
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
  const [execution, setExecution] = useState(initial.execution)
  const [timeout, setTimeoutMin] = useState(String(initial.stepTimeoutMinutes))
  const [drafts, setDrafts] = useState(() => toDraft(initial))
  const [detecting, setDetecting] = useState(false)
  const [assist, setAssist] = useState(initial.assist)
  const [defCli, setDefCli] = useState(() => defaultCli(initial))
  const demo = !!import.meta.env.VITE_DEMO

  const minutes = Number(timeout)
  const valid = Number.isInteger(minutes) && minutes >= 1 && minutes <= 600
  const tier = (t: { model: string; effort: string }) => ({ model: t.model.trim(), effort: t.effort })
  const value: Settings = {
    execution,
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
    valid,
  )

  const detect = async () => {
    setDetecting(true)
    try {
      await refreshClis()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setDetecting(false)
    }
  }

  const cur = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0]
  const statusOf = (id: string) => clis.find((c) => c.id === id)
  const defDef = CLIS.find((c) => c.id === defCli)!

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
                <span className="hidden px-2.5 pt-3 pb-1 text-[11px] text-subtle md:block">CLI</span>
              )}
              <button
                onClick={() => onSection(s.id)}
                aria-current={on ? 'page' : undefined}
                className={cn(
                  'flex h-9 shrink-0 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] whitespace-nowrap transition-colors',
                  on ? 'bg-sel font-medium text-fg' : 'text-muted hover:bg-sel/70 hover:text-fg',
                )}
              >
                {s.cli ? (
                  <span className="h-4 w-4 shrink-0 rounded-[4px]" style={{ background: cliColor(s.cli.id) }} />
                ) : (
                  s.icon && <s.icon className="h-4 w-4 shrink-0" strokeWidth={1.8} />
                )}
                <span className="truncate">{s.label}</span>
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
          <D.Close
            aria-label="关闭设置"
            className="grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-lg text-subtle hover:bg-sel hover:text-fg"
          >
            <X className="h-4 w-4" />
          </D.Close>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-10 md:px-8">
          {cur.id === 'general' && (
            <Group>
              <Row
                title="执行方式"
                desc={
                  demo
                    ? '在线演示没有本机环境，只能模拟执行；下载到本机运行后可以真实执行。'
                    : execution === 'real'
                      ? '在项目目录里调用本机 CLI，Agent 会真正读写文件、执行命令。'
                      : '只生成示例输出，不调用 CLI，用来熟悉界面。'
                }
              >
                <Segmented
                  label="执行方式"
                  value={execution}
                  onChange={setExecution}
                  options={[
                    { id: 'real', label: '真实执行', disabled: demo },
                    { id: 'simulate', label: '模拟执行' },
                  ]}
                />
              </Row>
              <Row title="单个步骤最长运行时间" desc="分钟。超时后会停止这一步，任务标记为失败。">
                <Input
                  type="number"
                  min={1}
                  max={600}
                  value={timeout}
                  onChange={(e) => setTimeoutMin(e.target.value)}
                  className="h-9"
                  aria-label="单个步骤最长运行时间（分钟）"
                />
              </Row>
              <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                {[
                  {
                    icon: Play,
                    t: '真实执行',
                    d: '工作流里每个节点调用对应 Agent 的 CLI，输出、改动的文件和验收结论都会记录在任务里。',
                  },
                  {
                    icon: FlaskConical,
                    t: '模拟执行',
                    d: '用固定的示例回复跑完整个流程，包括验收不通过再修改，适合先熟悉工作流怎么运转。',
                  },
                ].map((x) => (
                  <div key={x.t} className="flex gap-3 rounded-xl border p-3.5">
                    <x.icon className="mt-0.5 h-4 w-4 shrink-0 text-subtle" />
                    <p className="text-[13px] leading-relaxed text-subtle">
                      <span className="font-medium text-fg">{x.t}：</span>
                      {x.d}
                    </p>
                  </div>
                ))}
              </div>
            </Group>
          )}

          {cur.id === 'models' && (
            <>
              <p className="text-[13px] leading-relaxed text-subtle">
                Agent 可以不指定 CLI，选「系统默认」时用这里的 CLI；模型可以只选高、中、低一档，执行时换成那个 CLI
                对应档位的模型和思考强度。改这里就能让所有用默认设置的 Agent 一起切换。
              </p>
              <div role="radiogroup" aria-label="默认 CLI" className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
                {CLIS.map((c) => {
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
                <Row title="三档模型" desc="每个 CLI 都有自己的三档，在左侧对应的 CLI 里也能改。" stack>
                  <TierTable
                    def={defDef}
                    value={drafts[defCli].tiers}
                    onChange={(v) => setDrafts((ds) => ({ ...ds, [defCli]: { ...ds[defCli], tiers: v } }))}
                  />
                </Row>
                <Row title="默认模型" desc="Agent 没有指定模型时使用">
                  <DefaultModel
                    key={defCli}
                    def={defDef}
                    draft={drafts[defCli]}
                    onChange={(v) => setDrafts((ds) => ({ ...ds, [defCli]: { ...ds[defCli], defaultModel: v } }))}
                  />
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
              onMakeDefault={() => setDefCli(cur.cli!.id)}
              onDetect={detect}
              detecting={detecting}
            />
          )}

          {cur.id === 'assist' && (
            <>
              <p className="text-[13px] leading-relaxed text-subtle">
                在 Agent 和工作流页面可以用本机 CLI 对话生成或优化配置。CLI 按固定格式输出，面板校验通过后才能应用。
              </p>
              <Group>
                <Row title="使用的 CLI" desc="自动时用第一个已安装的 CLI">
                  <Select
                    aria-label="AI 创建使用的 CLI"
                    value={assist.cli}
                    onChange={(e) => setAssist({ ...assist, cli: e.target.value })}
                    options={[{ value: '', label: '自动' }, ...CLIS.map((c) => ({ value: c.id, label: c.name }))]}
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
          className="fixed top-1/2 left-1/2 z-50 h-[min(720px,calc(100dvh-2rem))] w-[min(980px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl border border-line-strong bg-card shadow-pop animate-[pop-in_160ms_ease-out] focus:outline-none"
        >
          <D.Title className="sr-only">设置</D.Title>
          {settings && <SettingsBody initial={settings} section={cur} onSection={setCur} />}
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}
