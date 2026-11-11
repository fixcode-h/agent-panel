import { useMemo, useState } from 'react'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { t } from '@shared/i18n'
import { dataStart, type SheetHeader } from '@shared/sheet-header'
import { colName } from '@/lib/sheet'
import {
  VALUE_LIST_MAX,
  condReady,
  distinctValues,
  isNumericColumn,
  type ColFilter,
  type FilterOp,
  type SheetSort,
} from '@/lib/sheet-filter'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input, Select } from '@/components/ui/input'
import { MenuSearch } from '@/components/ui/menu-search'
import { PopoverContent } from '@/components/ui/menu'

const opLabel = (op: FilterOp) =>
  ({
    eq: t('等于'),
    ne: t('不等于'),
    gt: t('大于'),
    lt: t('小于'),
    between: t('介于'),
    contains: t('包含'),
    empty: t('为空'),
    notEmpty: t('不为空'),
  })[op]

const NUM_OPS: FilterOp[] = ['eq', 'ne', 'gt', 'lt', 'between', 'empty', 'notEmpty']
const TEXT_OPS: FilterOp[] = ['contains', 'eq', 'ne', 'empty', 'notEmpty']

/**
 * 一列的筛选和排序（列名上的漏斗点开）：升序 / 降序，按条件（数字列给大于、小于、介于），按值勾选。
 * 改完点「应用」才生效；只决定显示哪些行，表格内容不动
 */
export function SheetColumnFilter({
  col,
  rows,
  header,
  filter,
  sort,
  onApply,
  onSort,
}: {
  col: number
  rows: string[][]
  header: SheetHeader
  filter?: ColFilter
  sort: SheetSort | null
  onApply: (f: ColFilter | undefined) => void
  onSort: (s: SheetSort | null) => void
}) {
  const from = dataStart(header)
  const numeric = useMemo(() => isNumericColumn(rows, from, col), [rows, from, col])
  const values = useMemo(() => distinctValues(rows, from, col), [rows, from, col])
  const ops = numeric ? NUM_OPS : TEXT_OPS
  const [op, setOp] = useState<FilterOp>(filter?.cond?.op ?? ops[0])
  const [a, setA] = useState(filter?.cond?.a ?? '')
  const [b, setB] = useState(filter?.cond?.b ?? '')
  /** 勾着的值；null 表示全选（不按值筛） */
  const [picked, setPicked] = useState<Set<string> | null>(filter?.values ? new Set(filter.values) : null)
  const [query, setQuery] = useState('')
  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? values.list.filter((v) => v.value.toLowerCase().includes(q)) : values.list
  }, [values, query])

  // 列标题：表头里字段名那一行，再带上类型（有的话）
  const at = (role: 'name' | 'type' | 'comment') => {
    const i = header.roles.indexOf(role)
    return i >= 0 ? (rows[header.start + i]?.[col] ?? '') : ''
  }
  const name = at('name') || at('comment')
  const type = at('type')

  const toggle = (v: string, on: boolean) => {
    const next = new Set(picked ?? values.list.map((x) => x.value))
    if (on) next.add(v)
    else next.delete(v)
    setPicked(next.size === values.total ? null : next)
  }
  const apply = () => {
    const cond = { op, a, b }
    const f: ColFilter = {
      ...(picked && { values: [...picked] }),
      ...(condReady(cond) && { cond }),
    }
    onApply(f.values || f.cond ? f : undefined)
  }
  const sortBtn = (desc: boolean) => {
    const on = sort?.desc === desc
    const Icon = desc ? ArrowDown : ArrowUp
    return (
      <button
        type="button"
        aria-pressed={on}
        onClick={() => onSort(on ? null : { col, desc })}
        className={cn(
          'flex h-8 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-(--c-menu-itemRadius) text-body transition-colors',
          on ? 'bg-sel text-fg' : 'text-muted hover:bg-hover hover:text-fg',
        )}
      >
        <Icon className="h-3.5 w-3.5" />
        {desc ? t('降序') : t('升序')}
      </button>
    )
  }
  const allOn = picked === null

  return (
    <PopoverContent className="w-72 p-2" align="start">
      <div className="px-1.5 pt-0.5 pb-2">
        <div className="truncate text-body font-medium text-fg">
          <span className="mr-1.5 font-mono text-subtle">{colName(col)}</span>
          {name}
        </div>
        {type && <div className="truncate font-mono text-caption text-subtle">{type}</div>}
      </div>
      <div className="flex gap-1">
        {sortBtn(false)}
        {sortBtn(true)}
      </div>
      <div className="my-2 h-px bg-line" />
      <div className="px-1.5 pb-1 text-caption text-subtle">{t('按条件')}</div>
      <div className="flex flex-col gap-1.5 px-0.5">
        <Select
          size="sm"
          aria-label={t('比较方式')}
          value={op}
          onChange={(e) => setOp(e.target.value as FilterOp)}
          options={ops.map((o) => ({ value: o, label: opLabel(o) }))}
        />
        {op !== 'empty' && op !== 'notEmpty' && (
          <div className="flex gap-1.5">
            <Input
              size="sm"
              aria-label={op === 'between' ? t('最小值') : t('值')}
              placeholder={op === 'between' ? t('最小值') : t('值')}
              inputMode={numeric ? 'decimal' : undefined}
              value={a}
              onChange={(e) => setA(e.target.value)}
              className="min-w-0 flex-1 font-mono"
            />
            {op === 'between' && (
              <Input
                size="sm"
                aria-label={t('最大值')}
                placeholder={t('最大值')}
                inputMode={numeric ? 'decimal' : undefined}
                value={b}
                onChange={(e) => setB(e.target.value)}
                className="min-w-0 flex-1 font-mono"
              />
            )}
          </div>
        )}
      </div>
      <div className="my-2 h-px bg-line" />
      <div className="flex items-center justify-between px-1.5 pb-1 text-caption text-subtle">
        <span>{t('按值')}</span>
        <span className="tabular-nums">{t('{n} 个不同的值', { n: values.total })}</span>
      </div>
      <MenuSearch value={query} onChange={setQuery} placeholder={t('搜索值')} autoFocus={false} />
      <div className="scroll-fade flex max-h-56 flex-col overflow-y-auto">
        {!query && (
          <ValueRow
            label={t('全选')}
            count={values.list.reduce((n, v) => n + v.count, 0)}
            checked={allOn}
            onChange={(on) => setPicked(on ? null : new Set())}
          />
        )}
        {list.map((v) => (
          <ValueRow
            key={v.value}
            label={v.value || <span className="text-subtle">{t('（空）')}</span>}
            count={v.count}
            mono
            checked={allOn || picked.has(v.value)}
            onChange={(on) => toggle(v.value, on)}
          />
        ))}
        {!list.length && <p className="px-2 py-3 text-body text-subtle">{t('没有匹配的值')}</p>}
      </div>
      {values.total > VALUE_LIST_MAX && (
        <p className="px-1.5 pt-1 text-caption text-subtle">
          {t('只列出最常见的 {n} 个值，其余的用条件筛选。', { n: VALUE_LIST_MAX })}
        </p>
      )}
      <div className="mt-2 flex justify-end gap-1.5">
        <Button size="sm" variant="ghost" onClick={() => onApply(undefined)}>
          {t('清除')}
        </Button>
        <Button size="sm" onClick={apply}>
          {t('应用')}
        </Button>
      </div>
    </PopoverContent>
  )
}

function ValueRow({
  label,
  count,
  checked,
  mono,
  onChange,
}: {
  label: React.ReactNode
  count: number
  checked: boolean
  mono?: boolean
  onChange: (on: boolean) => void
}) {
  return (
    <div className="flex items-center gap-2 rounded-(--c-menu-itemRadius) px-1.5 py-1 hover:bg-hover">
      <Checkbox
        checked={checked}
        onChange={onChange}
        label={<span className={cn('truncate', mono && 'font-mono')}>{label}</span>}
        className="min-w-0 flex-1"
      />
      <span className="shrink-0 text-caption text-subtle tabular-nums">{count}</span>
    </div>
  )
}
