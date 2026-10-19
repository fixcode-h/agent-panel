import { useState } from 'react'
import { ArrowDown, ArrowUp, Plus, SlidersHorizontal, Trash2 } from 'lucide-react'
import type { AgentParam, ParamValue, ParamValues } from '@shared/schema'
import { PARAM_TYPES, coerceValue, paramLabel, resolveParams, valueText } from '@shared/agent-role'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input, Select } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Checkbox } from '@/components/ui/checkbox'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/menu'

/** 一个参数的输入控件：按类型是下拉、多选、开关、文本或数字 */
export function ParamControl({
  param: p,
  value,
  onChange,
  placeholder,
}: {
  param: AgentParam
  value: ParamValue | undefined
  onChange: (v: ParamValue | undefined) => void
  /** 没填时显示的提示（例如「默认：xxx」） */
  placeholder?: string
}) {
  const v = coerceValue(p, value)
  switch (p.type) {
    case 'bool':
      return (
        <Switch
          checked={v === true}
          onCheckedChange={(x) => onChange(x)}
          aria-label={paramLabel(p)}
          className="self-start"
        />
      )
    case 'multi':
      return (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={paramLabel(p)}>
          {p.options.map((o) => {
            const on = Array.isArray(v) && v.includes(o)
            return (
              <button
                key={o}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  const cur = Array.isArray(v) ? v : []
                  onChange(on ? cur.filter((x) => x !== o) : [...cur, o])
                }}
                className={cn(
                  'h-7 cursor-pointer rounded-md border px-2 text-[12.5px] transition-colors',
                  on ? 'border-accent bg-accent-soft text-accent' : 'border-line-strong text-muted hover:text-fg',
                )}
              >
                {o}
              </button>
            )
          })}
          {!p.options.length && <span className="text-xs text-subtle">{t('还没有选项')}</span>}
        </div>
      )
    case 'select':
      return (
        <Select
          aria-label={paramLabel(p)}
          value={typeof v === 'string' ? v : ''}
          placeholder={placeholder ?? t('请选择')}
          onChange={(e) => onChange(e.target.value || undefined)}
          options={p.options.map((o) => ({ value: o, label: o }))}
        />
      )
    case 'number':
      return (
        <Input
          type="number"
          aria-label={paramLabel(p)}
          value={value === undefined ? '' : String(v ?? '')}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
          className="h-9"
        />
      )
    default:
      return (
        <Input
          aria-label={paramLabel(p)}
          value={typeof v === 'string' ? v : ''}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value || undefined)}
          className="h-9"
        />
      )
  }
}

/**
 * 填参数：节点上、对话里共用。值只存改过的，没填的用默认值；
 * 要问用户（没有默认值）的参数没填时标红。
 */
export function ParamsForm({
  params,
  values,
  onChange,
  compact,
}: {
  params: AgentParam[]
  values: ParamValues
  onChange: (v: ParamValues) => void
  compact?: boolean
}) {
  const { missing } = resolveParams(params, values)
  const set = (key: string, v: ParamValue | undefined) => {
    const next = { ...values }
    if (v === undefined) delete next[key]
    else next[key] = v
    onChange(next)
  }
  return (
    <div className={cn('flex flex-col', compact ? 'gap-3' : 'gap-4')}>
      {params.map((p) => {
        const lack = missing.some((m) => m.key === p.key)
        const changed = p.key in values
        return (
          <div key={p.key} className="flex flex-col gap-1.5">
            <span className="flex items-center gap-2 text-xs">
              <span className={cn('font-medium', lack ? 'text-danger' : 'text-muted')}>{paramLabel(p)}</span>
              {p.ask && <span className="text-[11px] text-subtle">{t('必填')}</span>}
              {changed && !p.ask && (
                <button
                  type="button"
                  onClick={() => set(p.key, undefined)}
                  className="ml-auto cursor-pointer text-[11px] text-accent"
                >
                  {t('恢复默认')}
                </button>
              )}
            </span>
            <ParamControl
              param={p}
              value={changed ? values[p.key] : p.ask ? undefined : p.default}
              onChange={(v) => set(p.key, v)}
              placeholder={!p.ask && p.default !== undefined ? t('默认：{v}', { v: valueText(p.default) }) : undefined}
            />
            {p.description && <span className="text-[11.5px] leading-relaxed text-subtle">{p.description}</span>}
          </div>
        )
      })}
    </div>
  )
}

/** 输入框旁边的「参数」按钮：点开填参数；有必填没填时变成警告色 */
export function ParamsChip({
  params,
  values,
  onChange,
  open,
  onOpenChange,
}: {
  params: AgentParam[]
  values: ParamValues
  onChange: (v: ParamValues) => void
  open?: boolean
  onOpenChange?: (o: boolean) => void
}) {
  if (!params.length) return null
  const { missing, values: used } = resolveParams(params, values)
  const summary = params
    .filter((p) => !missing.includes(p))
    .map((p) => `${paramLabel(p)}：${valueText(used[p.key]) || '—'}`)
    .join('；')
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        title={missing.length ? t('还有参数没选：{list}', { list: missing.map(paramLabel).join(t('、')) }) : summary}
        className={cn(
          'inline-flex h-8 min-w-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-[12px] transition-colors hover:bg-sel data-[state=open]:bg-sel',
          missing.length ? 'text-warning' : 'text-subtle hover:text-fg',
        )}
      >
        <SlidersHorizontal className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">
          {missing.length ? t('选参数（{n}）', { n: missing.length }) : t('参数 · {n}', { n: params.length })}
        </span>
      </PopoverTrigger>
      <PopoverContent align="start" className="max-h-[min(480px,70vh)] w-[300px] overflow-y-auto p-3">
        <p className="mb-3 text-xs leading-relaxed text-subtle">{t('这个 Agent 会按参数决定做法，没改的用默认值。')}</p>
        <ParamsForm params={params} values={values} onChange={onChange} compact />
      </PopoverContent>
    </Popover>
  )
}

const KEY_RE = /^[A-Za-z_一-龥][\w一-龥-]*$/

/** Agent 页编辑参数的定义：名字、类型、选项、默认值、是否必须问用户 */
export function ParamsEditor({ value, onChange }: { value: AgentParam[]; onChange: (v: AgentParam[]) => void }) {
  const [openKey, setOpenKey] = useState<number | null>(null)
  const set = (i: number, p: Partial<AgentParam>) => onChange(value.map((x, j) => (j === i ? { ...x, ...p } : x)))
  const move = (i: number, d: number) => {
    const j = i + d
    if (j < 0 || j >= value.length) return
    const next = [...value]
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange(next)
  }
  const add = () => {
    let n = value.length + 1
    while (value.some((p) => p.key === `param${n}`)) n++
    onChange([
      ...value,
      { key: `param${n}`, label: '', type: 'select', options: [], ask: false, description: '', default: undefined },
    ])
    setOpenKey(value.length)
  }
  const dupKeys = new Set(value.map((p) => p.key).filter((k, i, a) => a.indexOf(k) !== i))
  return (
    <div className="flex flex-col gap-2">
      {value.map((p, i) => {
        const open = openKey === i
        const badKey = !KEY_RE.test(p.key) || dupKeys.has(p.key)
        return (
          <div key={i} className="rounded-xl border bg-card">
            <div className="flex items-center gap-2 px-3 py-2">
              <button
                type="button"
                onClick={() => setOpenKey(open ? null : i)}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
                aria-expanded={open}
              >
                <code className={cn('shrink-0 font-mono text-[12.5px]', badKey ? 'text-danger' : 'text-accent')}>
                  {`{{${p.key}}}`}
                </code>
                <span className="truncate text-[13px]">{p.label}</span>
                <span className="ml-auto shrink-0 text-xs text-subtle">
                  {PARAM_TYPES.find((x) => x.id === p.type)?.label}
                  {' · '}
                  {p.ask ? t('每次询问') : t('默认：{v}', { v: valueText(p.default) || '—' })}
                </span>
              </button>
              <Button variant="ghost" size="icon-sm" aria-label={t('上移')} onClick={() => move(i, -1)}>
                <ArrowUp className="h-3.5 w-3.5" />
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label={t('下移')} onClick={() => move(i, 1)}>
                <ArrowDown className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('删除参数')}
                onClick={() => {
                  onChange(value.filter((_, j) => j !== i))
                  setOpenKey(null)
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
            {open && (
              <div className="flex flex-col gap-3 border-t px-3 py-3">
                <div className="flex flex-wrap gap-3">
                  <label className="flex flex-[1_1_140px] flex-col gap-1">
                    <span className="text-xs text-muted">{t('参数名（在角色设定里写 {{参数名}}）')}</span>
                    <Input
                      value={p.key}
                      maxLength={40}
                      onChange={(e) => set(i, { key: e.target.value.trim() })}
                      className={cn('h-9 font-mono text-[13px]', badKey && 'border-danger')}
                    />
                    {badKey && (
                      <span className="text-[11.5px] text-danger">
                        {dupKeys.has(p.key) ? t('参数名重复') : t('参数名只能用字母、数字、下划线、横线和中文')}
                      </span>
                    )}
                  </label>
                  <label className="flex flex-[1_1_140px] flex-col gap-1">
                    <span className="text-xs text-muted">{t('显示名')}</span>
                    <Input
                      value={p.label}
                      maxLength={40}
                      placeholder={p.key}
                      onChange={(e) => set(i, { label: e.target.value })}
                      className="h-9"
                    />
                  </label>
                  <label className="flex flex-[1_1_140px] flex-col gap-1">
                    <span className="text-xs text-muted">{t('类型')}</span>
                    <Select
                      aria-label={t('类型')}
                      value={p.type}
                      onChange={(e) => set(i, { type: e.target.value as AgentParam['type'], default: undefined })}
                      options={PARAM_TYPES.map((x) => ({ value: x.id, label: x.label }))}
                    />
                  </label>
                </div>
                {(p.type === 'select' || p.type === 'multi') && (
                  <label className="flex flex-col gap-1">
                    <span className="text-xs text-muted">{t('选项（每行一个）')}</span>
                    <OptionsInput value={p.options} onChange={(options) => set(i, { options })} />
                  </label>
                )}
                <Checkbox
                  checked={p.ask}
                  onChange={(ask) => set(i, { ask })}
                  label={t('没有默认值，每次都要选')}
                  hint={t('对话开始前先问你选；工作流里必须在节点上填好。')}
                />
                {!p.ask && (
                  <div className="flex flex-col gap-1">
                    <span className="text-xs text-muted">{t('默认值')}</span>
                    <ParamControl param={p} value={p.default} onChange={(d) => set(i, { default: d })} />
                  </div>
                )}
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-muted">{t('说明')}</span>
                  <Input
                    value={p.description}
                    maxLength={200}
                    placeholder={t('选的时候看的提示，例如：严格模式会逐行检查')}
                    onChange={(e) => set(i, { description: e.target.value })}
                    className="h-9"
                  />
                </label>
              </div>
            )}
          </div>
        )
      })}
      <Button variant="secondary" size="sm" className="self-start" onClick={add} disabled={value.length >= 30}>
        <Plus className="h-3.5 w-3.5" />
        {t('添加参数')}
      </Button>
    </div>
  )
}

/** 选项的多行输入：边打边存会把正在输入的空行吃掉，所以本地留一份文字，失焦时再整理 */
function OptionsInput({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [text, setText] = useState(value.join('\n'))
  const tidy = (s: string) => [
    ...new Set(
      s
        .split('\n')
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  ]
  return (
    <textarea
      rows={Math.min(8, Math.max(3, value.length + 1))}
      value={text}
      onChange={(e) => {
        setText(e.target.value)
        onChange(tidy(e.target.value).slice(0, 30))
      }}
      onBlur={() => setText(tidy(text).join('\n'))}
      placeholder={t('例如：\n快速\n标准\n严格')}
      className="w-full resize-y rounded-lg border border-line-strong bg-field px-3 py-2 text-[13px] leading-relaxed outline-none focus:border-focus"
    />
  )
}
