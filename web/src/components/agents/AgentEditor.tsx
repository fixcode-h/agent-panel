import { useEffect, useState } from 'react'
import { Check, Crown, Terminal, Users } from 'lucide-react'
import type { AgentInput, CliStatus } from '@shared/schema'
import { previewCommand } from '@shared/clis'
import { Button } from '@/components/ui/button'
import { Dialog, SheetContent } from '@/components/ui/dialog'
import { Field, Input, Textarea } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { cliStyle } from '@/lib/cli-style'
import { cn } from '@/lib/utils'

export const emptyAgent = (cli = 'claude'): AgentInput => ({
  name: '',
  description: '',
  cli,
  model: '',
  role: 'sub',
  instructions: '',
  extraArgs: [],
  enabled: true,
})

/** 按空格拆参数，支持用引号包住含空格的值 */
const splitArgs = (s: string) =>
  (s.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((a) => a.replace(/^(["'])(.*)\1$/, '$2'))
const joinArgs = (a: string[]) => a.map((x) => (/\s/.test(x) ? `"${x}"` : x)).join(' ')

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
  const nameError = touched && !form.name.trim() ? '名称不能为空' : undefined

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
        title={mode === 'create' ? '新建 Agent' : '编辑 Agent'}
        description="选择这个 Agent 使用的本机 CLI 和模型，并写清楚它负责什么。"
        footer={
          <>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" form="agent-form" disabled={saving}>
              <Check className="h-4 w-4" />
              {saving ? '保存中…' : '保存'}
            </Button>
          </>
        }
      >
        <form id="agent-form" onSubmit={submit} className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
            <Field label="名称" error={nameError}>
              <Input
                autoFocus
                value={form.name}
                placeholder="例如：架构师、前端开发、代码审查"
                onChange={(e) => set('name', e.target.value)}
                onBlur={() => setTouched(true)}
              />
            </Field>
            <Field label="启用">
              <div className="flex h-9 items-center">
                <Switch checked={form.enabled} onCheckedChange={(v) => set('enabled', v)} />
              </div>
            </Field>
          </div>

          <Field label="简介">
            <Input
              value={form.description}
              placeholder="一句话说明它的职责"
              onChange={(e) => set('description', e.target.value)}
            />
          </Field>

          <div className="space-y-1.5">
            <span className="text-xs font-medium">角色</span>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  { id: 'main', label: '主 Agent', hint: '接收任务、拆分并调度子 Agent', icon: Crown },
                  { id: 'sub', label: '子 Agent', hint: '执行主 Agent 分派的具体步骤', icon: Users },
                ] as const
              ).map((r) => (
                <button
                  type="button"
                  key={r.id}
                  onClick={() => set('role', r.id)}
                  className={cn(
                    'flex items-start gap-3 rounded-xl border p-3 text-left transition-colors',
                    form.role === r.id ? 'border-accent bg-accent-soft' : 'hover:bg-surface-2',
                  )}
                >
                  <r.icon className={cn('mt-0.5 h-4 w-4', form.role === r.id ? 'text-accent' : 'text-muted')} />
                  <div>
                    <div className="text-sm font-medium">{r.label}</div>
                    <div className="text-xs text-muted">{r.hint}</div>
                  </div>
                </button>
              ))}
            </div>
            <p className="text-xs text-muted">同一时间只有一个主 Agent，设为主 Agent 会把原来的主 Agent 改为子 Agent。</p>
          </div>

          <div className="space-y-1.5">
            <span className="text-xs font-medium">CLI</span>
            <div className="grid grid-cols-2 gap-2">
              {clis.map((c) => (
                <button
                  type="button"
                  key={c.id}
                  onClick={() => setForm((f) => ({ ...f, cli: c.id, model: f.cli === c.id ? f.model : '' }))}
                  className={cn(
                    'flex items-center gap-3 rounded-xl border p-3 text-left transition-colors',
                    form.cli === c.id ? 'border-accent bg-accent-soft' : 'hover:bg-surface-2',
                  )}
                >
                  <span className={cn('h-2.5 w-2.5 rounded-full', cliStyle(c.id).dot)} />
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{c.name}</div>
                    <div className={cn('truncate text-xs', c.installed ? 'text-success' : 'text-warning')}>
                      {c.installed ? `已安装 ${c.version ?? ''}` : '本机未检测到'}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>

          <Field label="模型" hint="点选常用模型，或直接填写 CLI 支持的任意模型名；留空则使用 CLI 默认模型。">
            <Input
              value={form.model}
              placeholder="留空使用默认模型"
              className="font-mono"
              onChange={(e) => set('model', e.target.value)}
            />
          </Field>
          {cli && cli.models.length > 0 && (
            <div className="-mt-3 flex flex-wrap gap-1.5">
              {cli.models.map((m) => (
                <button
                  type="button"
                  key={m.id}
                  title={m.label}
                  onClick={() => set('model', m.id)}
                  className={cn(
                    'rounded-md border px-2 py-1 font-mono text-[11px] transition-colors',
                    form.model === m.id ? 'border-accent bg-accent-soft text-accent' : 'text-muted hover:text-fg',
                  )}
                >
                  {m.id}
                </button>
              ))}
            </div>
          )}

          <Field label="角色设定" hint="执行任务时会作为前置说明交给这个 Agent。">
            <Textarea
              rows={6}
              value={form.instructions}
              placeholder="例如：你是资深前端工程师，负责按照设计稿实现页面，完成后运行测试并汇报结果。"
              onChange={(e) => set('instructions', e.target.value)}
            />
          </Field>

          <Field label="额外参数" hint="追加给 CLI 的参数，用空格分隔，含空格的值用引号包住。">
            <Input
              value={args}
              className="font-mono"
              placeholder="例如：--permission-mode acceptEdits"
              onChange={(e) => setArgs(e.target.value)}
            />
          </Field>

          <div className="rounded-xl border bg-bg p-4">
            <div className="mb-2 flex items-center gap-2 text-xs text-muted">
              <Terminal className="h-3.5 w-3.5" />
              命令预览
            </div>
            <code className="block break-all font-mono text-xs leading-relaxed text-fg/90">
              {previewCommand(form.cli, form.model, splitArgs(args))}
            </code>
          </div>
        </form>
      </SheetContent>
    </Dialog>
  )
}
