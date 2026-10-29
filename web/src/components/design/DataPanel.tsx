import { AlertTriangle, ChevronDown, Database, Plus, Trash2, X } from 'lucide-react'
import type { DesignImage } from '@shared/design'
import {
  DATA_TYPES,
  checkData,
  dataUsage,
  findDataSet,
  listWidgets,
  type DataField,
  type DataListWidget,
  type DataRow,
  type DataSet,
  type DataType,
  type DesignData,
} from '@shared/design-data'
import type { Component, Widget } from '@shared/umg'
import { Button } from '@/components/ui/button'
import { Input, Select } from '@/components/ui/input'
import { IconButton } from '@/components/ui/icon-button'
import { Checkbox } from '@/components/ui/checkbox'
import { EmptyPanel } from '@/components/ui/empty-panel'
import { t } from '@shared/i18n'
import { Thumb } from './fields'
import { cn } from '@/lib/utils'
import { useScopedSetting } from '@/lib/useScopedSetting'

/** 集合卡片折叠到只剩卡片头；按设计各自记住，键是 design-data-collapsed:<设计 id> */
const COLLAPSE_KEY = 'design-data-collapsed'

/**
 * 数据面板：编辑画板用的运行时假数据（数据结构 + 示例行），画板按它渲染。
 * 数据结构由 AI 搭界面时给出（design 工具的 set_data），在这里直接改行、加行、改字段；
 * 这份数据不会导出。
 */
export function DataPanel({
  data,
  root,
  components,
  images,
  imageUrl,
  scope,
  onChange,
  onBind,
}: {
  data: DesignData
  root: Widget
  components: Component[]
  images: DesignImage[]
  imageUrl: (img: DesignImage) => string | undefined
  /** 折叠状态按这个范围各自记住（设计 id） */
  scope: string
  /** key 相同的连续修改合成一步撤销 */
  onChange: (next: DesignData, key: string) => void
  /** 列表控件换绑集合：key 是集合 id，空字符串是解绑 */
  onBind: (where: { tree: string; id: string }, key: string) => void
}) {
  const usage = dataUsage(root, components, data)
  const lists = listWidgets(root, components)
  const setOf = (key: string) => findDataSet(data, key)
  const issues = checkData(data, { imageIds: new Set(images.map((i) => i.id)), root, components })
  /** 换绑下拉的选项：除了已经绑在这个集合上的控件都能选，选了就从原来的集合挪过来 */
  const bindOptions = (setId: string): { value: string; label: string; where: { tree: string; id: string } }[] =>
    lists
      .filter((w) => setOf(w.set)?.id !== setId)
      .map((w) => {
        const cur = w.set ? (setOf(w.set)?.name ?? w.set) : ''
        return {
          value: JSON.stringify([w.tree, w.id]),
          label: cur ? `${w.label}（${t('当前 {name}', { name: cur })}）` : w.label,
          where: { tree: w.tree, id: w.id },
        }
      })
  // DataPanel 在切到画板时会卸载，折叠状态存在浏览器里，切回来还保持；新设计默认全部展开
  const [collapsedSets, setCollapsedSets] = useScopedSetting<Record<string, boolean>>(
    COLLAPSE_KEY,
    scope,
    (v) => {
      try {
        const x = JSON.parse(v ?? '{}')
        return x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, boolean>) : {}
      } catch {
        return {}
      }
    },
    (v) => JSON.stringify(v),
    () => ({}),
  )
  const edit = (fn: (d: DesignData) => DesignData, key: string) => onChange(fn(structuredClone(data)), key)

  const setSet = (id: string, fn: (s: DataSet) => DataSet, key: string) =>
    edit((d) => ({ sets: d.sets.map((s) => (s.id === id ? fn(s) : s)) }), key)

  const addSet = () => {
    let n = data.sets.length + 1
    while (data.sets.some((s) => s.id === `data_${n}`)) n++
    edit(
      (d) => ({ sets: [...d.sets, { id: `data_${n}`, name: `Data${n}`, label: '', fields: [], rows: [] }] }),
      'data:add',
    )
  }

  const addField = (s: DataSet) =>
    setSet(
      s.id,
      (x) => {
        let n = x.fields.length + 1
        while (x.fields.some((f) => f.key === `field${n}`)) n++
        return { ...x, fields: [...x.fields, { key: `field${n}`, label: '', type: 'string', widget: '', note: '' }] }
      },
      `data:field:${s.id}`,
    )

  const toggleSet = (id: string) => setCollapsedSets({ ...collapsedSets, [id]: !collapsedSets[id] })

  const addRow = (s: DataSet) =>
    setSet(
      s.id,
      (x) => {
        const row: DataRow = {}
        for (const f of x.fields)
          row[f.key] = f.example ?? (f.type === 'boolean' ? false : f.type === 'number' ? 0 : '')
        return { ...x, rows: [...x.rows, row] }
      },
      `data:row:${s.id}`,
    )

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-bg">
      <div className="flex min-h-10 items-center gap-3 border-b px-4 py-1.5">
        <span className="inline-flex items-center gap-1.5 text-[0.8125rem] font-medium">
          <Database className="h-3.5 w-3.5 text-accent" />
          {t('运行时假数据')}
        </span>
        <span className="hidden text-[0.75rem] text-subtle sm:inline">{t('只影响画板预览，导出时剔除')}</span>
        <div className="ml-auto">
          <Button size="sm" variant="ghost" onClick={addSet}>
            <Plus className="h-3.5 w-3.5" />
            {t('新建集合')}
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {issues.length > 0 && (
          <div className="mx-auto mb-4 flex max-w-[980px] gap-2 rounded-xl bg-danger/8 px-3 py-2 text-[0.75rem] text-danger">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div className="min-w-0">
              <p className="font-medium">{t('数据绑定有问题')}</p>
              <ul className="mt-1 list-disc pl-4 leading-relaxed">
                {issues.map((e, i) => (
                  <li key={`${i}:${e}`}>{e}</li>
                ))}
              </ul>
            </div>
          </div>
        )}
        {!data.sets.length ? (
          <EmptyPanel as="div" size="square" className="mx-auto mt-12 max-w-[420px]">
            <Database className="mx-auto h-6 w-6 text-subtle" />
            <p className="mt-3 text-[0.8125rem] font-medium text-fg">{t('还没有运行时数据')}</p>
            <p className="mt-1.5 text-[0.75rem] leading-relaxed text-muted">
              {t(
                '让 AI 搭界面时会一起给出这个界面需要的数据结构；有了集合以后，列表控件按行渲染，格子里就能看到物品、选中和锁定状态。也可以先手动新建一个集合。',
              )}
            </p>
            <Button className="mt-4" size="sm" onClick={addSet}>
              <Plus className="h-3.5 w-3.5" />
              {t('新建集合')}
            </Button>
          </EmptyPanel>
        ) : (
          <div className="mx-auto flex max-w-[980px] flex-col gap-4">
            {data.sets.map((s) => (
              <SetCard
                key={s.id}
                set={s}
                where={usage.get(s.id) ?? []}
                bound={lists.filter((w) => setOf(w.set)?.id === s.id)}
                bindOptions={bindOptions(s.id)}
                onBind={onBind}
                images={images}
                imageUrl={imageUrl}
                collapsed={!!collapsedSets[s.id]}
                onToggle={() => toggleSet(s.id)}
                onRemove={() => edit((d) => ({ sets: d.sets.filter((x) => x.id !== s.id) }), `data:remove:${s.id}`)}
                onRename={(label) => setSet(s.id, (x) => ({ ...x, label }), `data:label:${s.id}`)}
                addField={() => addField(s)}
                removeField={(key) =>
                  setSet(
                    s.id,
                    (x) => ({ ...x, fields: x.fields.filter((f) => f.key !== key) }),
                    `data:field:${s.id}:${key}`,
                  )
                }
                editField={(key, patch) =>
                  setSet(
                    s.id,
                    (x) => ({ ...x, fields: x.fields.map((f) => (f.key === key ? { ...f, ...patch } : f)) }),
                    `data:field:${s.id}:${key}`,
                  )
                }
                addRow={() => addRow(s)}
                removeRow={(i) =>
                  setSet(s.id, (x) => ({ ...x, rows: x.rows.filter((_, k) => k !== i) }), `data:row:${s.id}:${i}`)
                }
                setCell={(i, key, value) =>
                  setSet(
                    s.id,
                    (x) => ({ ...x, rows: x.rows.map((r, k) => (k === i ? { ...r, [key]: value } : r)) }),
                    `data:cell:${s.id}:${i}:${key}`,
                  )
                }
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** 字段类型的界面名：写成字面量，漏翻检查才能对上 */
const typeLabel = (x: DataType) =>
  ({
    string: t('文字'),
    number: t('数字'),
    boolean: t('开关'),
    image: t('图片'),
    color: t('颜色'),
  })[x]

function SetCard({
  set,
  where,
  bound,
  bindOptions,
  onBind,
  images,
  imageUrl,
  collapsed,
  onToggle,
  onRemove,
  onRename,
  addField,
  removeField,
  editField,
  addRow,
  removeRow,
  setCell,
}: {
  set: DataSet
  where: string[]
  /** 已经绑在这个集合上的列表控件 */
  bound: DataListWidget[]
  bindOptions: { value: string; label: string; where: { tree: string; id: string } }[]
  onBind: (where: { tree: string; id: string }, key: string) => void
  images: DesignImage[]
  imageUrl: (img: DesignImage) => string | undefined
  /** 折叠后只显示卡片头 */
  collapsed: boolean
  onToggle: () => void
  onRemove: () => void
  onRename: (label: string) => void
  addField: () => void
  removeField: (key: string) => void
  editField: (key: string, patch: Partial<DataField>) => void
  addRow: () => void
  removeRow: (i: number) => void
  setCell: (i: number, key: string, value: string | number | boolean) => void
}) {
  const cols = `2rem repeat(${Math.max(1, set.fields.length)}, minmax(112px, 1fr)) 2rem`
  return (
    <section className="overflow-hidden rounded-xl bg-card shadow-card">
      {/* 整行都能折叠/展开；改名输入框和删除按钮阻止冒泡，避免误触 */}
      <header
        className={cn('flex cursor-pointer items-center gap-2 px-3 py-2', !collapsed && 'border-b')}
        onClick={onToggle}
      >
        <IconButton
          label={collapsed ? t('展开集合') : t('收起集合')}
          aria-expanded={!collapsed}
          onClick={(e) => {
            e.stopPropagation()
            onToggle()
          }}
        >
          <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', collapsed && '-rotate-90')} />
        </IconButton>
        <Input
          size="xs"
          aria-label={t('集合名称')}
          className="w-[180px] min-w-0 font-medium"
          value={set.label || set.name}
          placeholder={set.name}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onRename(e.target.value)}
        />
        <span className="rounded bg-field px-1.5 py-0.5 font-mono text-[0.6875rem] text-subtle">{set.id}</span>
        <span className="min-w-0 truncate text-[0.6875rem] text-subtle">
          {where.length ? t('用在 {where}', { where: where.join('、') }) : t('还没有控件绑定这个集合')}
        </span>
        <span className="ml-auto shrink-0 text-[0.6875rem] text-subtle">{t('{n} 行', { n: set.rows.length })}</span>
        <IconButton
          icon={Trash2}
          tone="danger"
          label={t('删除集合')}
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
        />
      </header>
      {!collapsed && (
        <>
          <div className="flex flex-wrap items-center gap-1.5 border-b px-3 py-1.5">
            <span className="text-[0.6875rem] text-subtle">{t('绑定到列表控件')}</span>
            {bound.map((w) => (
              <span
                key={w.id}
                className="inline-flex items-center gap-1 rounded bg-field py-0.5 pr-0.5 pl-1.5 text-[0.6875rem]"
              >
                {w.label}
                <IconButton
                  icon={X}
                  size="2xs"
                  tone="danger"
                  label={t('解除绑定')}
                  onClick={() => onBind({ tree: w.tree, id: w.id }, '')}
                  className="h-4 w-4"
                />
              </span>
            ))}
            {bindOptions.length ? (
              <Select
                aria-label={t('绑定到列表控件')}
                size="xs"
                className="ml-auto w-[220px]"
                value=""
                placeholder={t('选择列表控件…')}
                options={bindOptions}
                onChange={(e) => {
                  const hit = bindOptions.find((o) => o.value === e.target.value)
                  if (hit) onBind(hit.where, set.id)
                }}
              />
            ) : (
              <span className="ml-auto text-[0.6875rem] text-subtle">{t('没有可绑定的列表控件')}</span>
            )}
          </div>
          {!set.fields.length ? (
            <div className="px-3 py-4 text-[0.75rem] text-muted">
              {t('这个集合还没有字段：加上字段以后，行里的值才能绑定到控件。')}
              <Button className="ml-2" size="sm" variant="ghost" onClick={addField}>
                <Plus className="h-3.5 w-3.5" />
                {t('添加字段')}
              </Button>
            </div>
          ) : (
            <>
              <div className="grid items-center gap-1.5 border-b px-3 py-1.5" style={{ gridTemplateColumns: cols }}>
                <span className="text-[0.6875rem] text-subtle">#</span>
                {set.fields.map((f) => (
                  <FieldHead
                    key={f.key}
                    field={f}
                    onEdit={(p) => editField(f.key, p)}
                    onRemove={() => removeField(f.key)}
                  />
                ))}
                <Button size="sm" variant="ghost" onClick={addField} title={t('添加字段')} aria-label={t('添加字段')}>
                  <Plus className="h-3.5 w-3.5" />
                </Button>
              </div>
              <div className="flex flex-col">
                {set.rows.map((row, i) => (
                  <div
                    key={i}
                    className="grid items-center gap-1.5 border-b px-3 py-1 last:border-b-0"
                    style={{ gridTemplateColumns: cols }}
                  >
                    <span className="text-[0.6875rem] text-subtle">{i + 1}</span>
                    {set.fields.map((f) => (
                      <Cell
                        key={f.key}
                        field={f}
                        value={row[f.key]}
                        images={images}
                        imageUrl={imageUrl}
                        onChange={(v) => setCell(i, f.key, v)}
                      />
                    ))}
                    <IconButton icon={Trash2} tone="danger" label={t('删除这一行')} onClick={() => removeRow(i)} />
                  </div>
                ))}
              </div>
              <footer className="flex items-center gap-2 px-3 py-2">
                <Button size="sm" variant="ghost" onClick={addRow}>
                  <Plus className="h-3.5 w-3.5" />
                  {t('添加一行')}
                </Button>
                {!set.rows.length && (
                  <span className="text-[0.6875rem] text-subtle">{t('没有行时，绑定的列表在画板里是空的')}</span>
                )}
              </footer>
            </>
          )}
        </>
      )}
    </section>
  )
}

function FieldHead({
  field,
  onEdit,
  onRemove,
}: {
  field: DataField
  onEdit: (patch: Partial<DataField>) => void
  onRemove: () => void
}) {
  return (
    <div className="flex min-w-0 items-center gap-1">
      {/* 字段名是控件绑定用的 key，改名会让绑定断开：这里只显示，由 AI 或重新生成调整 */}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          className="truncate font-mono text-[0.6875rem] text-muted"
          title={[field.label, field.widget].filter(Boolean).join(' · ') || field.key}
        >
          {field.key}
        </span>
        <Select
          aria-label={t('字段类型')}
          className="h-6 min-w-0 text-[0.625rem]"
          value={field.type}
          onChange={(e) => onEdit({ type: e.target.value as DataType })}
          options={DATA_TYPES.map((x) => ({ value: x, label: typeLabel(x) }))}
        />
      </div>
      <IconButton icon={Trash2} size="2xs" tone="danger" label={t('删除这个字段')} onClick={onRemove} />
    </div>
  )
}

function Cell({
  field,
  value,
  images,
  imageUrl,
  onChange,
}: {
  field: DataField
  value: string | number | boolean | undefined
  images: DesignImage[]
  imageUrl: (img: DesignImage) => string | undefined
  onChange: (v: string | number | boolean) => void
}) {
  if (field.type === 'boolean')
    return (
      <Checkbox
        ariaLabel={field.label || field.key}
        checked={value === true || value === 'true'}
        onChange={onChange}
        label={
          <span className="text-[0.75rem] text-muted">{value === true || value === 'true' ? t('是') : t('否')}</span>
        }
        className="h-7 items-center gap-1.5"
      />
    )
  if (field.type === 'number')
    return (
      <Input
        size="xs"
        type="number"
        aria-label={field.label || field.key}
        className="min-w-0"
        value={typeof value === 'number' ? value : Number(value) || 0}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
      />
    )
  if (field.type === 'image') {
    const cur = typeof value === 'string' ? value : ''
    const img = cur.startsWith('img:') ? images.find((i) => i.id === cur.slice(4)) : undefined
    return (
      <div className="flex min-w-0 items-center gap-1">
        {img && <Thumb src={imageUrl(img)} className="h-6 w-6" />}
        <Select
          aria-label={field.label || field.key}
          size="xs"
          className="min-w-0"
          value={cur}
          onChange={(e) => onChange(e.target.value)}
          options={[{ value: '', label: t('（空）') }, ...images.map((i) => ({ value: `img:${i.id}`, label: i.name }))]}
        />
      </div>
    )
  }
  if (field.type === 'color')
    return (
      <div className="flex min-w-0 items-center gap-1">
        <input
          type="color"
          aria-label={field.label || field.key}
          className="h-7 w-7 shrink-0 cursor-pointer rounded-md border border-line-strong bg-field p-0"
          value={/^#[0-9a-f]{6}/i.test(String(value ?? '')) ? String(value).slice(0, 7) : '#ffffff'}
          onChange={(e) => onChange(`${e.target.value.toUpperCase()}FF`)}
        />
        <Input
          size="xs"
          aria-label={`${field.label || field.key} 颜色值`}
          className="min-w-0 font-mono"
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    )
  return (
    <Input
      size="xs"
      aria-label={field.label || field.key}
      className="min-w-0"
      value={String(value ?? '')}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}
