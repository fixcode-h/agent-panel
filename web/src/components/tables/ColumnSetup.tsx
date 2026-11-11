import { Fragment, useState } from 'react'
import { Columns3 } from 'lucide-react'
import { t } from '@shared/i18n'
import { colKey, TableColumn, type TableSchema } from '@shared/tables'
import type { ColInfo, ColKind } from '@shared/table-struct'
import { colName } from '@/lib/sheet'
import { cn } from '@/lib/utils'
import { roleShort } from '@/components/files/sheet-roles'
import '@/components/files/sheet-table.css'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, Input, Select } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/menu'

export const kindLabel = (k: ColKind) =>
  ({
    int: t('整数'),
    uint: t('非负整数'),
    float: t('小数'),
    bool: t('布尔'),
    string: t('文字'),
    enum: t('枚举'),
    other: t('未识别'),
  })[k]

const NEW = '__new__'
/** 参数类型的常用写法（下拉里的选项；也能手填别的） */
const TYPES = ['int32', 'uint32', 'int64', 'float', 'double', 'bool', 'string']

/**
 * 「列结构」：当前列在表头里的每一行（修饰、导出端、类型、字段名、注释），手动改参数类型、指定枚举、引用、repeated、取值范围。
 * 按字段名记进项目的表格结构文件（每张表通用），表格文件不动
 */
export function ColumnSetup({
  info,
  file,
  schema,
  files,
  onSchema,
}: {
  info: ColInfo | undefined
  file: string
  schema: TableSchema
  /** 引用时能选的表格文件 */
  files: string[]
  onSchema: (s: TableSchema) => void
}) {
  const [open, setOpen] = useState(false)
  const key = info?.field ? colKey(file, '*', info.field) : ''
  const own = key ? schema.columns[key] : undefined
  const [d, setD] = useState<TableColumn>({})
  const [newEnum, setNewEnum] = useState('')
  const [allow, setAllow] = useState('')
  const reset = () => {
    setD(own ?? {})
    setNewEnum('')
    setAllow((own?.allow ?? []).join(', '))
  }
  const num = (v: string) => (v.trim() === '' || !Number.isFinite(Number(v)) ? undefined : Number(v))
  const save = () => {
    if (!key) return
    const enumName = d.enum === NEW ? newEnum.trim() : d.enum
    const col = TableColumn.parse({
      ...d,
      type: d.type?.trim() || undefined,
      enum: enumName || undefined,
      ref: d.ref?.trim() || undefined,
      allow: allow
        .split(/[,，]/)
        .map((x) => x.trim())
        .filter(Boolean),
      note: d.note?.trim() || undefined,
    })
    if (!col.allow?.length) delete col.allow
    const columns = { ...schema.columns }
    const empty = Object.values(col).every((v) => v === undefined || v === false)
    if (empty) delete columns[key]
    else columns[key] = col
    const enums = enumName && !schema.enums[enumName] ? { ...schema.enums, [enumName]: { values: [] } } : schema.enums
    onSchema({ ...schema, columns, enums })
    setOpen(false)
  }
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        if (o) reset()
        setOpen(o)
      }}
    >
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" className="h-7" disabled={!info}>
          <Columns3 className="h-3.5 w-3.5" />
          {t('列结构')}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[360px] p-3" align="end">
        {!info ? null : (
          <div className="flex flex-col gap-3">
            <div className="flex items-baseline gap-2">
              <span className="shrink-0 text-body font-medium whitespace-nowrap">
                {t('{col} 列', { col: colName(info.col) })}
              </span>
              <span className="min-w-0 truncate font-mono text-footnote text-muted">
                {info.field || t('（没有字段名）')}
              </span>
              <span className="ml-auto shrink-0 font-mono text-caption text-subtle">
                {info.type || '-'} · {kindLabel(info.kind)}
                {info.list ? ' · repeated' : ''}
              </span>
            </div>
            {info.head.length > 0 && (
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg bg-sel px-2.5 py-2 text-caption">
                {info.head.map((h, i) => (
                  <Fragment key={i}>
                    <dt className="flex items-center gap-1.5 text-subtle">
                      <span className={cn('h-2.5 w-2.5 rounded-[3px] sheet-role', `sheet-role-${h.role}`)} />
                      {roleShort(h.role)}
                    </dt>
                    <dd className="min-w-0 truncate font-mono text-fg" title={h.text}>
                      {h.text || '—'}
                    </dd>
                  </Fragment>
                ))}
              </dl>
            )}
            {!info.field ? (
              <p className="rounded-lg bg-sel px-2.5 py-2 text-caption leading-relaxed text-subtle">
                {t('这张表没有认出字段名行：先在「调整表头」里把字段名那一行标出来，列结构按字段名记。')}
              </p>
            ) : (
              <>
                <Field
                  label={t('参数类型')}
                  tip={t('表头类型行写错或没写时，按这里的类型检查和编辑；只记在结构文件里，表格不改')}
                >
                  <Input
                    size="sm"
                    list="table-col-types"
                    placeholder={info.head.find((h) => h.role === 'type')?.text || 'uint32'}
                    value={d.type ?? ''}
                    onChange={(e) => setD({ ...d, type: e.target.value })}
                    className="font-mono"
                  />
                  <datalist id="table-col-types">
                    {[...TYPES, ...Object.keys(schema.enums)].map((x) => (
                      <option key={x} value={x} />
                    ))}
                  </datalist>
                </Field>
                <Field label={t('枚举')} tip={t('选了枚举后，这一列改格子时是下拉选择，填了不在枚举里的值会标红')}>
                  <Select
                    size="sm"
                    value={d.enum ?? ''}
                    onChange={(e) => setD({ ...d, enum: e.target.value || undefined })}
                    options={[
                      {
                        value: '',
                        label: info.enumName && !d.enum ? t('按类型名：{e}', { e: info.enumName }) : t('不是枚举'),
                      },
                      ...Object.keys(schema.enums).map((e) => ({ value: e, label: e })),
                      { value: NEW, label: t('新建枚举…') },
                    ]}
                  />
                </Field>
                {d.enum === NEW && (
                  <Input
                    size="sm"
                    autoFocus
                    placeholder={info.type || 'MyEnum'}
                    value={newEnum}
                    onChange={(e) => setNewEnum(e.target.value)}
                  />
                )}
                <Field
                  label={t('引用')}
                  tip={t('这一列填的是别的表的主键，写成「文件#字段」，例如 Config/Item.xlsx#ID；改格子时从那张表里选')}
                >
                  <Input
                    size="sm"
                    list="table-ref-files"
                    placeholder="Config/Item.xlsx#ID"
                    value={d.ref ?? ''}
                    onChange={(e) => setD({ ...d, ref: e.target.value })}
                    className="font-mono"
                  />
                  <datalist id="table-ref-files">
                    {files.map((f) => (
                      <option key={f} value={`${f}#ID`} />
                    ))}
                  </datalist>
                </Field>
                <div className="grid grid-cols-2 gap-2">
                  <Field label={t('最小值')}>
                    <Input
                      size="sm"
                      type="number"
                      value={d.min ?? ''}
                      onChange={(e) => setD({ ...d, min: num(e.target.value) })}
                    />
                  </Field>
                  <Field label={t('最大值')}>
                    <Input
                      size="sm"
                      type="number"
                      value={d.max ?? ''}
                      onChange={(e) => setD({ ...d, max: num(e.target.value) })}
                    />
                  </Field>
                </div>
                <Field label={t('也允许的值')} tip={t('不在范围、枚举里也算对的特殊值，逗号分隔，例如 -1 表示未配置')}>
                  <Input
                    size="sm"
                    placeholder="-1"
                    value={allow}
                    onChange={(e) => setAllow(e.target.value)}
                    className="font-mono"
                  />
                </Field>
                <Checkbox
                  checked={d.list ?? info.list}
                  onChange={(v) => setD({ ...d, list: v })}
                  label={t('一格多个值（repeated，用「{sep}」分隔）', { sep: schema.style.listSep })}
                />
                <Field label={t('说明')}>
                  <Input size="sm" value={d.note ?? ''} onChange={(e) => setD({ ...d, note: e.target.value })} />
                </Field>
              </>
            )}
            <p className="rounded-lg bg-sel px-2.5 py-2 text-caption leading-relaxed text-subtle">
              {t('按字段名记在项目的表格结构文件里（这个文件的每张表通用），表格文件不改。')}
            </p>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
                {t('取消')}
              </Button>
              <Button size="sm" onClick={save} disabled={!info.field || (d.enum === NEW && !newEnum.trim())}>
                {t('确定')}
              </Button>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
