import { useState } from 'react'
import { toast } from 'sonner'
import { Check, Copy, FlaskConical, Play, RefreshCw } from 'lucide-react'
import { CLIS, type CliDefinition } from '@shared/clis'
import type { CliSettings, CliStatus, Settings } from '@shared/schema'
import { cliSettings } from '@shared/settings'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { cliColor } from '@/lib/cli-style'
import { useAutosave } from '@/lib/useAutosave'
import { cn, joinArgs, splitArgs } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Field, FormSection, Input, Textarea } from '@/components/ui/input'
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
      className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border bg-field px-2 py-1 font-mono text-xs text-muted hover:text-fg"
      title="复制安装命令"
    >
      {text}
      {done ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
    </button>
  )
}

function CliCard({
  def,
  draft,
  status,
  onChange,
  onDetect,
  detecting,
}: {
  def: CliDefinition
  draft: CliDraft
  status?: CliStatus
  onChange: (d: CliDraft) => void
  onDetect: () => void
  detecting: boolean
}) {
  const set = <K extends keyof CliDraft>(k: K, v: CliDraft[K]) => onChange({ ...draft, [k]: v })
  const perm = def.permissions.find((p) => p.id === draft.permission) ?? def.permissions[0]
  const ok = status?.installed
  return (
    <section className={cn('rounded-xl border bg-card', !draft.enabled && 'opacity-75')}>
      <header className="flex flex-wrap items-center gap-3 border-b px-4 py-3.5">
        <span className="h-9 w-9 shrink-0 rounded-[9px]" style={{ background: cliColor(def.id) }} />
        <div className="min-w-0 flex-[1_1_200px]">
          <h3 className="font-semibold">{def.name}</h3>
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
        <label className="flex cursor-pointer items-center gap-2 text-[13px] text-muted">
          <Switch checked={draft.enabled} onCheckedChange={(v) => set('enabled', v)} aria-label={`启用 ${def.name}`} />
          启用
        </label>
      </header>

      <div className="flex flex-col gap-4 p-4">
        {status && !ok && (
          <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
            安装命令 <CopyText text={def.installHint} />
            <span className="text-subtle">安装后点「重新检测」。</span>
          </p>
        )}
        <div className="flex flex-wrap gap-4">
          <Field label="可执行文件" className="flex-[2_1_280px]" hint={`留空时从 PATH 查找 ${def.command}；找不到时填完整路径`}>
            <Input
              value={draft.command}
              onChange={(e) => set('command', e.target.value)}
              placeholder={def.command}
              className="font-mono text-[13px]"
              spellCheck={false}
            />
          </Field>
          <Field label="默认模型" className="flex-[1_1_200px]" hint="Agent 没有指定模型时使用">
            <Input
              value={draft.defaultModel}
              onChange={(e) => set('defaultModel', e.target.value)}
              placeholder="CLI 自己的默认"
              className="font-mono text-[13px]"
              spellCheck={false}
            />
          </Field>
        </div>
        {def.models.length > 0 && (
          <div className="-mt-2 flex flex-wrap gap-1.5">
            {def.models.map((m) => (
              <button
                key={m.id}
                type="button"
                title={m.label}
                onClick={() => set('defaultModel', draft.defaultModel === m.id ? '' : m.id)}
                className={cn(
                  'cursor-pointer rounded-full border px-2.5 py-0.5 font-mono text-xs',
                  draft.defaultModel === m.id ? 'border-accent bg-accent-soft text-accent' : 'text-muted hover:text-fg',
                )}
              >
                {m.id}
              </button>
            ))}
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-muted">权限</span>
          <div role="radiogroup" aria-label={`${def.name} 权限`} className="flex flex-wrap gap-1.5">
            {def.permissions.map((p) => (
              <button
                key={p.id}
                role="radio"
                aria-checked={perm.id === p.id}
                onClick={() => set('permission', p.id)}
                className={cn(
                  'cursor-pointer rounded-lg border px-3 py-1.5 text-[13px]',
                  perm.id === p.id ? 'border-accent bg-accent-soft text-accent' : 'bg-field text-muted hover:text-fg',
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
          <span className={cn('text-xs', /任意命令|不使用沙箱/.test(perm.hint) ? 'text-warning' : 'text-subtle')}>
            {perm.hint}
          </span>
        </div>

        <div className="flex flex-wrap gap-4">
          <Field label="额外参数" className="flex-[1_1_280px]" hint="每次调用都会追加，Agent 自己的参数排在后面">
            <Input
              value={draft.args}
              onChange={(e) => set('args', e.target.value)}
              placeholder="例如 --add-dir ../shared"
              className="font-mono text-[13px]"
              spellCheck={false}
            />
          </Field>
          <Field label="环境变量" className="flex-[1_1_280px]" hint="每行一个 KEY=VALUE，只传给这个 CLI">
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
          </Field>
        </div>
        <CommandPreview cli={def.id} model="" extraArgs={[]} title="实际调用（任务描述从 stdin 传入）" />
      </div>
    </section>
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
          permission: eff.permission,
          args: joinArgs(eff.extraArgs),
          envText: envToText(eff.env),
        },
      ]
    }),
  )

function SettingsForm({ initial }: { initial: Settings }) {
  const { setSettings, clis, refreshClis } = useData()
  const [execution, setExecution] = useState(initial.execution)
  const [timeout, setTimeoutMin] = useState(String(initial.stepTimeoutMinutes))
  const [drafts, setDrafts] = useState(() => toDraft(initial))
  const [detecting, setDetecting] = useState(false)
  const demo = !!import.meta.env.VITE_DEMO

  const minutes = Number(timeout)
  const valid = Number.isInteger(minutes) && minutes >= 1 && minutes <= 600
  const value: Settings = {
    execution,
    stepTimeoutMinutes: valid ? minutes : initial.stepTimeoutMinutes,
    clis: Object.fromEntries(
      Object.entries(drafts).map(([id, d]) => [
        id,
        {
          enabled: d.enabled,
          command: d.command.trim(),
          defaultModel: d.defaultModel.trim(),
          permission: d.permission,
          extraArgs: splitArgs(d.args),
          env: textToEnv(d.envText),
        },
      ]),
    ),
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

  const modes = [
    { id: 'real' as const, icon: Play, title: '真实执行', desc: '在项目目录里调用本机 CLI，Agent 会真正读写文件、执行命令' },
    { id: 'simulate' as const, icon: FlaskConical, title: '模拟执行', desc: '只生成示例输出，不调用 CLI，用来熟悉界面' },
  ]

  return (
    <main className="flex min-w-0 flex-1 flex-col md:h-full md:overflow-y-auto">
      <header className="flex flex-wrap items-center gap-3 border-b bg-bg px-4 py-5 md:px-8">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold">设置</h1>
          <p className="text-[13px] text-muted">执行方式和本机 CLI。改动会自动保存，对之后启动的任务生效。</p>
        </div>
        <SaveIndicator {...save} invalid={valid ? undefined : '超时时间需要是 1 到 600 的整数'} />
      </header>
      <div className="flex max-w-[880px] flex-col gap-7 px-4 pt-6 pb-12 md:px-8 md:pt-7">
        <FormSection title="执行方式">
          {demo && (
            <p className="-mt-2 text-xs text-warning">在线演示没有本机环境，只能模拟执行；下载到本机运行后可以真实执行。</p>
          )}
          <div role="radiogroup" aria-label="执行方式" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {modes.map((m) => {
              const on = execution === m.id
              return (
                <button
                  key={m.id}
                  role="radio"
                  aria-checked={on}
                  disabled={demo && m.id === 'real'}
                  onClick={() => setExecution(m.id)}
                  className={cn(
                    'flex cursor-pointer items-start gap-3 rounded-xl border p-3.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                    on ? 'border-accent bg-accent-soft' : 'bg-card hover:border-line-strong',
                  )}
                >
                  <span
                    className={cn(
                      'grid h-8 w-8 shrink-0 place-items-center rounded-lg',
                      on ? 'bg-accent text-white' : 'bg-field text-muted',
                    )}
                  >
                    <m.icon className="h-4 w-4" />
                  </span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-[13px] font-medium">{m.title}</span>
                    <span className="text-xs leading-relaxed text-subtle">{m.desc}</span>
                  </span>
                </button>
              )
            })}
          </div>
          <Field label="单个步骤最长运行时间（分钟）" className="max-w-[260px]" hint="超时后会停止这一步，任务标记为失败">
            <Input type="number" min={1} max={600} value={timeout} onChange={(e) => setTimeoutMin(e.target.value)} />
          </Field>
        </FormSection>

        <FormSection title="CLI">
          <p className="-mt-2 text-xs leading-relaxed text-subtle">
            每个 Agent 选择用哪个 CLI 运行。这里配置 CLI 本身：在哪里、默认用什么模型、允许做什么，以及额外的参数和环境变量。
          </p>
          {CLIS.map((def) => (
            <CliCard
              key={def.id}
              def={def}
              draft={drafts[def.id]}
              status={clis.find((c) => c.id === def.id)}
              onChange={(d) => setDrafts((ds) => ({ ...ds, [def.id]: d }))}
              onDetect={detect}
              detecting={detecting}
            />
          ))}
        </FormSection>
      </div>
    </main>
  )
}

export function SettingsPage() {
  const { settings } = useData()
  return settings ? <SettingsForm initial={settings} /> : null
}
