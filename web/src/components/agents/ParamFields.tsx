import { useState } from 'react'
import { ArrowDown, ArrowUp, GripVertical, Plus, SlidersHorizontal, Trash2, X } from 'lucide-react'
import type { AgentParam, ParamValue, ParamValues } from '@shared/schema'
import { PARAM_TYPES, coerceValue, paramLabel, resolveParams, valueText } from '@shared/agent-role'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { moveItem, useDragSort } from '@/lib/useDragSort'
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
                  'h-7 cursor-pointer rounded-md border px-2 text-[0.78125rem] transition-colors',
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
              {p.ask && <span className="text-[0.6875rem] text-subtle">{t('必填')}</span>}
              {changed && !p.ask && (
                <button
                  type="button"
                  onClick={() => set(p.key, undefined)}
                  className="ml-auto cursor-pointer text-[0.6875rem] text-accent"
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
            {p.description && <span className="text-[0.71875rem] leading-relaxed text-subtle">{p.description}</span>}
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
          'inline-flex h-8 min-w-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-[0.75rem] transition-colors hover:bg-sel data-[state=open]:bg-sel',
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
                <code className={cn('shrink-0 font-mono text-[0.78125rem]', badKey ? 'text-danger' : 'text-accent')}>
                  {`{{${p.key}}}`}
                </code>
                <span className="truncate text-[0.8125rem]">{p.label}</span>
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
                      className={cn('h-9 font-mono text-[0.8125rem]', badKey && 'border-danger')}
                    />
                    {badKey && (
                      <span className="text-[0.71875rem] text-danger">
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
                  <div className="flex flex-col gap-1">
                    <span className="text-xs text-muted">{t('选项')}</span>
                    <OptionsInput value={p.options} onChange={(options) => set(i, { options })} />
                  </div>
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

/** 选项最多几个、每个多长（和 schema 一致） */
const MAX_OPTIONS = 30
const MAX_OPTION_LEN = 60

/**
 * 选项编辑：上面是带序号的选项卡片，可以拖拽排序、点 × 删除；下面的输入框回车添加一个。
 * 粘贴多行文字时每行加一个，方便从别处整段搬过来。
 */
function OptionsInput({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const { itemProps, drag, over } = useDragSort((from, to) => onChange(moveItem(value, from, to)))
  const add = (items: string[]) => {
    const next = [...value]
    const dup: string[] = []
    let full = false
    for (const raw of items) {
      const x = raw.trim().slice(0, MAX_OPTION_LEN)
      if (!x) continue
      if (next.includes(x)) dup.push(x)
      else if (next.length < MAX_OPTIONS) next.push(x)
      else full = true
    }
    if (next.length !== value.length) onChange(next)
    setError(
      dup.length
        ? t('已经有「{name}」了', { name: dup.join(t('、')) })
        : full
          ? t('最多 {n} 个选项', { n: MAX_OPTIONS })
          : '',
    )
    return !dup.length
  }
  return (
    <div className="flex flex-col gap-2">
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label={t('选项')}>
          {value.map((o, i) => (
            <li
              key={o}
              {...itemProps(i, value.length)}
              tabIndex={0}
              title={t('拖动调整顺序（也可以按 Alt + 方向键）')}
              className={cn(
                'group inline-flex h-8 max-w-full cursor-grab items-center gap-1 rounded-lg border bg-card pr-1 pl-1 text-[0.8125rem] transition-colors outline-none select-none focus-visible:border-focus active:cursor-grabbing',
                drag === i && 'opacity-40',
                over === i && drag !== null && drag !== i && 'border-accent bg-accent/10',
              )}
            >
              <GripVertical className="h-3.5 w-3.5 shrink-0 text-subtle opacity-60 group-hover:opacity-100" />
              <span className="grid h-5 min-w-5 shrink-0 place-items-center rounded-md bg-sel px-1 font-mono text-[0.6875rem] text-muted tabular-nums">
                {i + 1}
              </span>
              <span className="truncate px-0.5">{o}</span>
              <button
                type="button"
                draggable={false}
                aria-label={t('删除选项「{name}」', { name: o })}
                title={t('删除')}
                onClick={() => onChange(value.filter((_, j) => j !== i))}
                className="grid h-6 w-6 shrink-0 cursor-pointer place-items-center rounded text-subtle hover:bg-sel hover:text-fg"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <Input
        value={text}
        maxLength={MAX_OPTION_LEN}
        disabled={value.length >= MAX_OPTIONS}
        placeholder={
          value.length >= MAX_OPTIONS
            ? t('最多 {n} 个选项', { n: MAX_OPTIONS })
            : value.length
              ? t('输入新选项，回车添加')
              : t('输入选项，回车添加，例如：快速')
        }
        onChange={(e) => {
          setText(e.target.value)
          if (error) setError('')
        }}
        onKeyDown={(e) => {
          // 输入法选字时的回车不算
          if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
          e.preventDefault()
          if (text.trim() && add([text])) setText('')
        }}
        onPaste={(e) => {
          const s = e.clipboardData.getData('text')
          if (!s.includes('\n')) return
          e.preventDefault()
          add(s.split(/\r?\n/))
        }}
        className={cn('h-9 text-[0.8125rem]', error && 'border-danger')}
        aria-label={t('新选项')}
      />
      {error && <span className="text-[0.71875rem] text-danger">{error}</span>}
    </div>
  )
}
