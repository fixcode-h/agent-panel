import { useState } from 'react'
import { ArrowDown, ArrowUp, GripVertical, Link2, Plus, SlidersHorizontal, Trash2, X } from 'lucide-react'
import type { AgentParam, ParamValue, ParamValues } from '@shared/schema'
import {
  PARAM_TYPES,
  coerceValue,
  condDepOk,
  paramLabel,
  resolveParams,
  shownParam,
  valueText,
} from '@shared/agent-role'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { moveItem, useDragSort } from '@/lib/useDragSort'
import { Button } from '@/components/ui/button'
import { Input, Select } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Checkbox } from '@/components/ui/checkbox'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/menu'
import { HelpTip } from '@/components/ui/help-tip'
import { Segmented } from '@/components/ui/segmented'
import { ChipGroup } from '@/components/ui/chip-group'
import { IconButton } from '@/components/ui/icon-button'

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
        <div className="flex flex-wrap gap-1.5">
          <ChipGroup
            multiple
            label={paramLabel(p)}
            value={Array.isArray(v) ? v : []}
            onChange={(next) => onChange(next)}
            options={p.options.map((o) => ({ id: o, label: o }))}
          />
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
 * 一项参数的一行：左边标签（旁边跟「必填」「恢复默认」这类小字）+ ⓘ 说明，右边控件。
 * 下拉、开关、数字放得下就排同一行；文本、多选放不下，控件另起一行（stacked）。
 * 角色设置和项目设置都用它，两处不用各写一套样式。
 */
export function ParamRow({
  label,
  hint,
  stacked,
  controlClass,
  children,
}: {
  /** 标签内容（参数名和它旁边的小字），已经组装好 */
  label: React.ReactNode
  /** ⓘ 里显示的说明；没有就不显示问号 */
  hint?: React.ReactNode
  /** 控件另起一行 */
  stacked?: boolean
  /** 控件容器额外样式：默认只按内容撑开，要限宽时由调用方给 */
  controlClass?: string
  children: React.ReactNode
}) {
  const head = (
    <span className="flex min-w-0 items-center gap-1.5 text-xs">
      {label}
      {hint && <HelpTip>{hint}</HelpTip>}
    </span>
  )
  if (stacked) {
    return (
      <div className="flex flex-col gap-1.5">
        {head}
        {children}
      </div>
    )
  }
  return (
    <div className="flex min-h-9 items-center justify-between gap-4">
      {head}
      <div className={cn('flex shrink-0 justify-end', controlClass)}>{children}</div>
    </div>
  )
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
  // 联动：前面参数没选到的不显示，选项跟着前面的取值缩小
  const { missing, hidden, options } = resolveParams(params, values)
  const set = (key: string, v: ParamValue | undefined) => {
    const next = { ...values }
    if (v === undefined) delete next[key]
    else next[key] = v
    onChange(next)
  }
  return (
    <div className={cn('flex flex-col', compact ? 'gap-2.5' : 'gap-3')}>
      {params.map((raw) => {
        if (hidden.includes(raw.key)) return null
        const p = shownParam(raw, options)
        const lack = missing.some((m) => m.key === p.key)
        const changed = p.key in values
        // 开关、下拉和数字跟标签放在同一行（控件靠右），文本、多选放不下才单独占一行
        const inline = p.type === 'bool' || p.type === 'select' || p.type === 'number'
        return (
          <ParamRow
            key={p.key}
            label={
              <>
                <span className={cn('truncate font-medium', lack ? 'text-danger' : 'text-muted')}>{paramLabel(p)}</span>
                {p.ask && <span className="shrink-0 text-[0.6875rem] text-subtle">{t('必填')}</span>}
                {changed && !p.ask && (
                  <Button variant="link" onClick={() => set(p.key, undefined)} className="shrink-0 text-[0.6875rem]">
                    {t('恢复默认')}
                  </Button>
                )}
              </>
            }
            hint={p.description}
            stacked={!inline}
            controlClass={p.type !== 'bool' ? 'w-[min(14rem,50%)]' : undefined}
          >
            <ParamControl
              param={p}
              value={changed ? values[p.key] : p.ask ? undefined : p.default}
              onChange={(v) => set(p.key, v)}
              placeholder={!p.ask && p.default !== undefined ? t('默认：{v}', { v: valueText(p.default) }) : undefined}
            />
          </ParamRow>
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
  const { missing, hidden, values: used } = resolveParams(params, values)
  const summary = params
    .filter((p) => !missing.includes(p) && !hidden.includes(p.key))
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
          {missing.length
            ? t('选参数（{n}）', { n: missing.length })
            : t('参数 · {n}', { n: params.length - hidden.length })}
        </span>
      </PopoverTrigger>
      <PopoverContent align="start" className="max-h-[min(480px,70vh)] w-[300px] overflow-y-auto p-3">
        <p className="mb-3 text-xs leading-relaxed text-subtle">{t('这个角色会按参数决定做法，没改的用默认值。')}</p>
        <ParamsForm params={params} values={values} onChange={onChange} compact />
      </PopoverContent>
    </Popover>
  )
}

const KEY_RE = /^[A-Za-z_一-龥][\w一-龥-]*$/

/** 参数改名或删除后，引用它的联动规则跟着改（to 为空表示删掉了，去掉这些规则） */
function relink(params: AgentParam[], from: string, to: string): AgentParam[] {
  return params.map((x) => {
    let next = x
    if (x.when?.key === from) next = { ...next, when: to ? { ...x.when, key: to } : undefined }
    if (x.optionsBy?.key === from) next = { ...next, optionsBy: to ? { ...x.optionsBy, key: to } : undefined }
    return next
  })
}

/**
 * Agent 页编辑参数的定义：名字、类型、选项、默认值、是否必须问用户，以及和前面参数的联动。
 * onRename：参数名改了（新旧名都不和别的参数重名时）通知外面，把角色设定里的 {{旧名}} 一起改掉。
 */
export function ParamsEditor({
  value,
  onChange,
  onRename,
}: {
  value: AgentParam[]
  onChange: (v: AgentParam[]) => void
  onRename?: (from: string, to: string) => void
}) {
  const [openKey, setOpenKey] = useState<number | null>(null)
  const set = (i: number, p: Partial<AgentParam>) => onChange(value.map((x, j) => (j === i ? { ...x, ...p } : x)))
  const rename = (i: number, to: string) => {
    const from = value[i].key
    const others = value.filter((_, j) => j !== i).map((x) => x.key)
    // 撞名时不联动：不然两个参数的引用会被合到一起，再改名就分不开了
    const linked = !!from && !!to && from !== to && !others.includes(from) && !others.includes(to)
    const next = value.map((x, j) => (j === i ? { ...x, key: to } : x))
    onChange(linked ? relink(next, from, to) : next)
    if (linked) onRename?.(from, to)
  }
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
          <div key={i} className="rounded-xl bg-card shadow-card">
            <div className="flex items-center gap-2 px-3 py-2">
              <button
                type="button"
                onClick={() => setOpenKey(open ? null : i)}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
                aria-expanded={open}
              >
                <code className={cn('shrink-0 font-mono text-[0.75rem]', badKey ? 'text-danger' : 'text-accent-text')}>
                  {`{{${p.key}}}`}
                </code>
                <span className="truncate text-[0.8125rem]">{p.label}</span>
                {(p.when || p.optionsBy) && (
                  <span
                    className={cn(
                      'inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 text-[0.6875rem]',
                      brokenLink(value, i) ? 'bg-danger/10 text-danger' : 'bg-accent-soft text-accent-text',
                    )}
                    title={linkSummary(value, i)}
                  >
                    <Link2 className="h-3 w-3" />
                    {t('联动')}
                  </span>
                )}
                <span className="ml-auto shrink-0 text-xs text-subtle">
                  {PARAM_TYPES.find((x) => x.id === p.type)?.label}
                  {' · '}
                  {p.ask ? t('每次询问') : t('默认：{v}', { v: valueText(p.default) || '—' })}
                </span>
              </button>
              <IconButton icon={ArrowUp} size="sm" label={t('上移')} onClick={() => move(i, -1)} />
              <IconButton icon={ArrowDown} size="sm" label={t('下移')} onClick={() => move(i, 1)} />
              <IconButton
                icon={Trash2}
                size="sm"
                label={t('删除参数')}
                onClick={() => {
                  const rest = value.filter((_, j) => j !== i)
                  // 还有同名参数时规则照旧指向它；否则引用这个参数的联动规则一起去掉
                  onChange(rest.some((x) => x.key === p.key) ? rest : relink(rest, p.key, ''))
                  setOpenKey(null)
                }}
              />
            </div>
            {open && (
              <div className="flex flex-col gap-3 border-t px-3 py-3">
                <div className="flex flex-wrap gap-3">
                  <label className="flex flex-[1_1_140px] flex-col gap-1">
                    <span className="text-xs text-muted">{t('参数名（在角色设定里写 {{参数名}}）')}</span>
                    <Input
                      value={p.key}
                      maxLength={40}
                      onChange={(e) => rename(i, e.target.value.trim())}
                      className={cn('h-9 font-mono text-[0.8125rem]', badKey && 'border-danger')}
                    />
                    {badKey && (
                      <span className="text-[0.6875rem] text-danger">
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
                <ParamLinks params={value} index={i} onChange={(patch) => set(i, patch)} />
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
                'group inline-flex h-8 max-w-full cursor-grab items-center gap-1 rounded-lg bg-card shadow-card pr-1 pl-1 text-[0.8125rem] transition-colors outline-none select-none focus-visible:border-focus active:cursor-grabbing',
                drag === i && 'opacity-40',
                over === i && drag !== null && drag !== i && 'border-accent bg-accent/10',
              )}
            >
              <GripVertical className="h-3.5 w-3.5 shrink-0 text-subtle opacity-60 group-hover:opacity-100" />
              <span className="grid h-5 min-w-5 shrink-0 place-items-center rounded-md bg-sel px-1 font-mono text-[0.6875rem] text-muted tabular-nums">
                {i + 1}
              </span>
              <span className="truncate px-0.5">{o}</span>
              <IconButton
                icon={X}
                draggable={false}
                label={t('删除选项「{name}」', { name: o })}
                title={t('删除')}
                onClick={() => onChange(value.filter((_, j) => j !== i))}
              />
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
      {error && <span className="text-[0.6875rem] text-danger">{error}</span>}
    </div>
  )
}

/** 能被后面的参数依赖的：前面的单选、多选（要有选项）和开关 */
const linkable = (params: AgentParam[], i: number) =>
  params
    .slice(0, i)
    .filter((x, j, a) => a.findIndex((y) => y.key === x.key) === j)
    .filter((x) => x.type === 'bool' || ((x.type === 'select' || x.type === 'multi') && x.options.length > 0))

/** 依赖参数的可选值：开关是打开 / 关闭 */
const depChoices = (dep: AgentParam) =>
  dep.type === 'bool'
    ? [
        { value: 'true', label: t('打开') },
        { value: 'false', label: t('关闭') },
      ]
    : dep.options.map((o) => ({ value: o, label: o }))

/** 联动规则指向的参数已经不在前面了（被删、改名或者被拖到后面），规则不生效 */
function brokenLink(params: AgentParam[], i: number) {
  const p = params[i]
  return (!!p.when && !condDepOk(params, i, p.when.key)) || (!!p.optionsBy && !condDepOk(params, i, p.optionsBy.key))
}

/** 显示条件写成界面上的一句话（提示词里用 shared 的 condText，那边不翻译） */
function condLabel(c: NonNullable<AgentParam['when']>, params: AgentParam[]) {
  const dep = params.find((x) => x.key === c.key)
  const name = dep ? paramLabel(dep) : c.key
  if (!c.values.length) return c.not ? t('「{name}」为空时', { name }) : t('「{name}」有值时', { name })
  if (dep?.type === 'bool' && c.values.length === 1)
    return (c.values[0] === 'true') !== c.not ? t('「{name}」打开时', { name }) : t('「{name}」关闭时', { name })
  const list = c.values.join(' / ')
  return c.not ? t('「{name}」不是 {list} 时', { name, list }) : t('「{name}」是 {list} 时', { name, list })
}

/** 折叠时标签上的提示：「只在 xx 时显示；选项跟着 yy 变」 */
function linkSummary(params: AgentParam[], i: number) {
  const p = params[i]
  const dep = (k: string) => params.find((x) => x.key === k)
  return [
    p.when && t('只在{cond}显示', { cond: condLabel(p.when, params) }),
    p.optionsBy &&
      t('选项跟着「{name}」变', { name: dep(p.optionsBy.key) ? paramLabel(dep(p.optionsBy.key)!) : p.optionsBy.key }),
    brokenLink(params, i) && t('依赖的参数不在它前面，规则暂不生效'),
  ]
    .filter(Boolean)
    .join(t('；'))
}

/** 一排可以点选的小块：联动规则里选依赖参数的取值、选这时可选的选项都用它 */
function Chips({
  items,
  picked,
  onToggle,
  label,
}: {
  items: { value: string; label: string }[]
  picked: (v: string) => boolean
  onToggle: (v: string) => void
  label: string
}) {
  const cur = items.filter((o) => picked(o.value)).map((o) => o.value)
  return (
    <ChipGroup
      multiple
      label={label}
      value={cur}
      // ChipGroup 给的是点完之后的整组；这里的调用方按「点了哪一块」处理，找出变了的那一个
      onChange={(next) => {
        const hit = next.find((x) => !cur.includes(x)) ?? cur.find((x) => !next.includes(x))
        if (hit !== undefined) onToggle(hit)
      }}
      options={items.map((o) => ({ id: o.value, label: o.label }))}
    />
  )
}

/**
 * 和前面参数的联动：
 * - 显示条件：前面某个参数取某些值时才显示（不满足时不问、按空值处理）；
 * - 选项跟随（单选 / 多选才有）：前面某个参数取不同值时，这里能选的选项不同。
 * 只能依赖排在前面的参数，保证从上往下填的时候前面的已经定了。
 */
function ParamLinks({
  params,
  index,
  onChange,
}: {
  params: AgentParam[]
  index: number
  onChange: (patch: Partial<AgentParam>) => void
}) {
  const p = params[index]
  const deps = linkable(params, index)
  const whenDep = p.when ? params.slice(0, index).find((x) => x.key === p.when!.key) : undefined
  const byDep = p.optionsBy ? params.slice(0, index).find((x) => x.key === p.optionsBy!.key) : undefined
  const canBy = (p.type === 'select' || p.type === 'multi') && p.options.length > 0
  const depOptions = (list: AgentParam[]) => [
    { value: '', label: t('不联动') },
    ...list.map((d) => ({ value: d.key, label: `${paramLabel(d)}（${d.key}）` })),
  ]
  const broken = brokenLink(params, index)
  if (!deps.length && !p.when && !p.optionsBy)
    return (
      <div className="flex flex-col gap-1">
        <span className="text-xs text-muted">{t('联动')}</span>
        <p className="text-[0.6875rem] text-subtle">
          {t('前面还没有单选、多选或开关参数。把它排在这类参数后面，就能按前面的选择决定显示它、或者换一组选项。')}
        </p>
      </div>
    )
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v])
  return (
    <div className="flex flex-col gap-3 rounded-lg bg-field px-3 py-2.5">
      <div className="flex items-center gap-1.5">
        <Link2 className="h-3.5 w-3.5 text-subtle" />
        <span className="text-xs font-medium text-muted">{t('联动')}</span>
        <HelpTip>
          {t(
            '按前面参数的选择决定这个参数：不满足显示条件时不显示、不用填，角色设定里按空值处理；选项跟随可以让前面选不同值时这里给不同的选项。',
          )}
        </HelpTip>
      </div>
      {broken && (
        <p className="-mt-1 text-[0.6875rem] text-danger">
          {t('依赖的参数不在它前面了（删掉、改名或者排到了后面），规则暂不生效。重新选一下，或者把它挪回去。')}
        </p>
      )}
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-muted">{t('显示条件')}</span>
          <div className="w-[min(16rem,100%)]">
            <Select
              aria-label={t('显示条件')}
              value={p.when?.key ?? ''}
              onChange={(e) => {
                const key = e.target.value
                const dep = deps.find((d) => d.key === key)
                onChange({
                  when: dep
                    ? { key, values: dep.type === 'bool' ? ['true'] : dep.options.slice(0, 1), not: false }
                    : undefined,
                })
              }}
              options={
                p.when && !whenDep
                  ? [...depOptions(deps), { value: p.when.key, label: t('{key}（不在前面）', { key: p.when.key }) }]
                  : depOptions(deps)
              }
            />
          </div>
        </div>
        {p.when && whenDep && (
          <div className="flex flex-col gap-1.5 pl-0.5">
            {whenDep.type === 'bool' ? (
              <Segmented
                label={t('开关状态')}
                value={(p.when.values[0] === 'false') !== p.when.not ? 'false' : 'true'}
                onChange={(v) => onChange({ when: { key: p.when!.key, values: [v], not: false } })}
                options={[
                  { id: 'true', label: t('打开时显示') },
                  { id: 'false', label: t('关闭时显示') },
                ]}
              />
            ) : (
              <>
                <Segmented
                  label={t('条件')}
                  value={p.when.not ? 'not' : 'is'}
                  onChange={(v) => onChange({ when: { ...p.when!, not: v === 'not' } })}
                  options={[
                    { id: 'is', label: t('选了其中一个时') },
                    { id: 'not', label: t('都没选时') },
                  ]}
                />
                <Chips
                  label={t('条件取值')}
                  items={depChoices(whenDep)}
                  picked={(v) => p.when!.values.includes(v)}
                  onToggle={(v) => onChange({ when: { ...p.when!, values: toggle(p.when!.values, v) } })}
                />
                {!p.when.values.length && (
                  <span className="text-[0.6875rem] text-subtle">
                    {p.when.not
                      ? t('没选取值：「{name}」为空时显示', { name: paramLabel(whenDep) })
                      : t('没选取值：「{name}」有值就显示', { name: paramLabel(whenDep) })}
                  </span>
                )}
              </>
            )}
          </div>
        )}
      </div>
      {canBy && (
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-muted">{t('选项跟随')}</span>
            <div className="w-[min(16rem,100%)]">
              <Select
                aria-label={t('选项跟随')}
                value={p.optionsBy?.key ?? ''}
                onChange={(e) => onChange({ optionsBy: e.target.value ? { key: e.target.value, map: {} } : undefined })}
                options={
                  p.optionsBy && !byDep
                    ? [
                        ...depOptions(deps),
                        { value: p.optionsBy.key, label: t('{key}（不在前面）', { key: p.optionsBy.key }) },
                      ]
                    : depOptions(deps)
                }
              />
            </div>
          </div>
          {p.optionsBy && byDep && (
            <div className="flex flex-col gap-2 pl-0.5">
              <p className="text-[0.6875rem] text-subtle">
                {t('「{name}」选不同值时这里能选哪些；默认全部可选，一个都不选表示这时不显示这个参数。', {
                  name: paramLabel(byDep),
                })}
              </p>
              {depChoices(byDep).map((c) => {
                const map = p.optionsBy!.map
                const limited = c.value in map
                const cur = limited ? map[c.value] : p.options
                const setRow = (list: string[] | undefined) => {
                  const next = { ...map }
                  if (list === undefined) delete next[c.value]
                  else next[c.value] = p.options.filter((o) => list.includes(o))
                  onChange({ optionsBy: { key: p.optionsBy!.key, map: next } })
                }
                return (
                  <div key={c.value} className="flex flex-col gap-1">
                    <div className="flex items-center gap-2 text-[0.6875rem]">
                      <span className="font-medium text-muted">{t('选「{v}」时', { v: c.label })}</span>
                      {limited ? (
                        <Button variant="link" onClick={() => setRow(undefined)}>
                          {t('恢复全部可选')}
                        </Button>
                      ) : (
                        <span className="text-subtle">{t('全部可选')}</span>
                      )}
                    </div>
                    <Chips
                      label={t('选「{v}」时的选项', { v: c.label })}
                      items={p.options.map((o) => ({ value: o, label: o }))}
                      picked={(o) => cur.includes(o)}
                      onToggle={(o) => {
                        const next = toggle(cur, o)
                        // 又选回全部时去掉这一行，等于不限制，之后加的新选项也能选
                        setRow(next.length === p.options.length ? undefined : next)
                      }}
                    />
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
