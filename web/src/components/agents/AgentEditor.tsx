import { useEffect, useState } from 'react'
import { Check, Crown, Users } from 'lucide-react'
import type { AgentInput, CliStatus } from '@shared/schema'
import { Button } from '@/components/ui/button'
import { Dialog, SheetContent } from '@/components/ui/dialog'
import { Field, Input, Section, Textarea } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { AGENT_ICONS } from '@/lib/agent-icons'
import { cliStyle } from '@/lib/cli-style'
import { cn } from '@/lib/utils'
import { AgentAvatar } from './AgentAvatar'
import { CommandPreview } from './CommandPreview'

export const emptyAgent = (cli = 'claude'): AgentInput => ({
  name: '',
  description: '',
  cli,
  model: '',
  role: 'sub',
  icon: 'bot',
  instructions: '',
  extraArgs: [],
  enabled: true,
})

/** 按空格拆参数，支持用引号包住含空格的值 */
const splitArgs = (s: string) =>
  (s.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((a) => a.replace(/^(["'])(.*)\1$/, '$2'))
const joinArgs = (a: string[]) => a.map((x) => (/\s/.test(x) ? `"${x}"` : x)).join(' ')

/** 可选卡片（角色、CLI 共用） */
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
      className={cn(
        'relative flex items-start gap-3 rounded-xl border p-3.5 text-left transition-all',
        selected
          ? 'border-accent bg-accent-soft ring-4 ring-ring/25'
          : 'border-border-strong hover:border-subtle/60 hover:bg-surface-2/60',
      )}
    >
      {children}
      {selected && (
        <span className="absolute right-2.5 top-2.5 grid h-4 w-4 place-items-center rounded-full bg-accent text-white">
          <Check className="h-2.5 w-2.5" strokeWidth={3} />
        </span>
      )}
    </button>
  )
}

interface Props {
  open: boolean
  mode: 'create' | 'edit'
  initial: AgentInput
  clis: CliStatus[]
  onOpenChange: (open: boolean) => void
  onSubmit: (input: AgentInput) => Promise<void>
}

export function AgentEditor({ open, mode, initial, clis, onOpenChange, onSubmit }: Props) {
  const [form, setForm] = useState(initial)
  const [args, setArgs] = useState('')
  const [saving, setSaving] = useState(false)
  const [touched, setTouched] = useState(false)

  useEffect(() => {
    if (open) {
      setForm(initial)
      setArgs(joinArgs(initial.extraArgs))
      setTouched(false)
    }
  }, [open, initial])

  const set = <K extends keyof AgentInput>(k: K, v: AgentInput[K]) => setForm((f) => ({ ...f, [k]: v }))
  const cli = clis.find((c) => c.id === form.cli)
  const nameError = touched && !form.name.trim() ? '给它起个名字' : undefined

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setTouched(true)
    if (!form.name.trim()) return
    setSaving(true)
    try {
      await onSubmit({ ...form, extraArgs: splitArgs(args) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <SheetContent
        icon={<AgentAvatar icon={form.icon} cli={form.cli} size="md" dim={!form.enabled} />}
        title={form.name.trim() || (mode === 'create' ? '新建 Agent' : '编辑 Agent')}
        description={`${form.role === 'main' ? '主 Agent' : '子 Agent'} · ${cli?.name ?? form.cli}${form.model ? ` · ${form.model}` : ''}`}
        footer={
          <>
            <label className="mr-auto flex cursor-pointer items-center gap-2 text-[13px] text-muted">
              <Switch checked={form.enabled} onCheckedChange={(v) => set('enabled', v)} />
              {form.enabled ? '已启用' : '已停用'}
            </label>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" form="agent-form" disabled={saving}>
              <Check className="h-4 w-4" />
              {saving ? '保存中…' : mode === 'create' ? '创建' : '保存'}
            </Button>
          </>
        }
      >
        <form id="agent-form" onSubmit={submit} className="space-y-8">
          <Section title="基本信息">
            <Field label="名称" error={nameError}>
              <Input
                autoFocus
                value={form.name}
                placeholder="例如：架构师、前端开发、代码审查"
                onChange={(e) => set('name', e.target.value)}
                onBlur={() => setTouched(true)}
              />
            </Field>
            <Field label="简介">
              <Input
                value={form.description}
                placeholder="一句话说明它负责什么"
                onChange={(e) => set('description', e.target.value)}
              />
            </Field>
            <div>
              <span className="mb-1.5 block text-[12px] font-medium text-fg/85">图标</span>
              <div className="grid grid-cols-8 gap-1.5">
                {AGENT_ICONS.map(({ id, label, icon: Icon }) => (
                  <button
                    type="button"
                    key={id}
                    title={label}
                    onClick={() => set('icon', id)}
                    className={cn(
                      'grid h-10 place-items-center rounded-[10px] border transition-all',
                      form.icon === id
                        ? 'border-accent bg-accent-soft text-accent ring-4 ring-ring/25'
                        : 'border-border-strong text-muted hover:bg-surface-2 hover:text-fg',
                    )}
                  >
                    <Icon className="h-4 w-4" />
                  </button>
                ))}
              </div>
            </div>
          </Section>

          <div className="h-px bg-border" />

          <Section title="角色" desc="同一时间只有一个主 Agent，设为主 Agent 会把原来的主 Agent 改为子 Agent。">
            <div className="grid grid-cols-2 gap-2.5">
              {(
                [
                  { id: 'main', label: '主 Agent', hint: '理解需求、拆分任务、调度子 Agent', icon: Crown },
                  { id: 'sub', label: '子 Agent', hint: '执行主 Agent 分派的具体步骤', icon: Users },
                ] as const
              ).map((r) => (
                <OptionCard key={r.id} selected={form.role === r.id} onClick={() => set('role', r.id)}>
                  <div
                    className={cn(
                      'grid h-8 w-8 shrink-0 place-items-center rounded-lg',
                      form.role === r.id ? 'bg-accent text-white' : 'bg-surface-2 text-muted',
                    )}
                  >
                    <r.icon className="h-4 w-4" />
                  </div>
                  <div className="pr-4">
                    <div className="text-[13px] font-medium">{r.label}</div>
                    <div className="mt-0.5 text-[11.5px] leading-snug text-subtle">{r.hint}</div>
                  </div>
                </OptionCard>
              ))}
            </div>
          </Section>

          <div className="h-px bg-border" />

          <Section title="运行环境" desc="选择用哪个本机 CLI 驱动这个 Agent，以及使用的模型。">
            <div className="grid grid-cols-2 gap-2.5">
              {clis.map((c) => (
                <OptionCard
                  key={c.id}
                  selected={form.cli === c.id}
                  onClick={() => setForm((f) => ({ ...f, cli: c.id, model: f.cli === c.id ? f.model : '' }))}
                >
                  <div className={cn('h-8 w-8 shrink-0 rounded-lg bg-gradient-to-br ring-1 ring-inset ring-white/20', cliStyle(c.id).tile)} />
                  <div className="min-w-0 pr-4">
                    <div className="text-[13px] font-medium">{c.name}</div>
                    <div className={cn('mt-0.5 truncate text-[11.5px]', c.installed ? 'text-success' : 'text-warning')}>
                      {c.installed ? `已安装 · ${c.version?.split(' ')[0] ?? ''}` : '本机未检测到'}
                    </div>
                  </div>
                </OptionCard>
              ))}
            </div>
            <Field label="模型" hint="点选常用模型，或填写 CLI 支持的任意模型名；留空则用 CLI 默认模型。">
              <Input
                value={form.model}
                placeholder="留空使用默认模型"
                className="font-mono text-[12.5px]"
                onChange={(e) => set('model', e.target.value)}
              />
            </Field>
            {cli && cli.models.length > 0 && (
              <div className="-mt-1 flex flex-wrap gap-1.5">
                {cli.models.map((m) => (
                  <button
                    type="button"
                    key={m.id}
                    title={m.label}
                    onClick={() => set('model', m.id)}
                    className={cn(
                      'h-7 rounded-full border px-3 font-mono text-[11.5px] transition-all',
                      form.model === m.id
                        ? 'border-accent bg-accent text-white'
                        : 'border-border-strong text-muted hover:border-subtle/60 hover:text-fg',
                    )}
                  >
                    {m.id}
                  </button>
                ))}
              </div>
            )}
          </Section>

          <div className="h-px bg-border" />

          <Section title="行为">
            <Field label="角色设定" hint="执行任务时会作为前置说明交给这个 Agent。">
              <Textarea
                rows={5}
                value={form.instructions}
                placeholder="例如：你是资深前端工程师，负责按照设计稿实现页面，完成后运行测试并汇报结果。"
                onChange={(e) => set('instructions', e.target.value)}
              />
            </Field>
            <Field label="额外参数" hint="追加给 CLI 的参数，用空格分隔，含空格的值用引号包住。">
              <Input
                value={args}
                className="font-mono text-[12.5px]"
                placeholder="例如：--permission-mode acceptEdits"
                onChange={(e) => setArgs(e.target.value)}
              />
            </Field>
            <CommandPreview cli={form.cli} model={form.model} extraArgs={splitArgs(args)} />
          </Section>
        </form>
      </SheetContent>
    </Dialog>
  )
}
