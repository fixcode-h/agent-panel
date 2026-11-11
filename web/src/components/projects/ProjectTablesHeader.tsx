import { useState } from 'react'
import { ListTree, Plus, Trash2 } from 'lucide-react'
import { toast } from '@/lib/toast'
import { t } from '@shared/i18n'
import { SHEET_ROLES, type SheetHeader } from '@shared/sheet-header'
import { styleHeaders, TYPE_NAMES, type TableSchema } from '@shared/tables'
import { saveTableSchema, useSchemaDraft, useTableSchema } from '@/lib/table-schema'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Segmented } from '@/components/ui/segmented'
import { Input, Select } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { roleShort } from '@/components/files/sheet-roles'
import '@/components/files/sheet-table.css'
import { HeaderRuleEditor } from '@/components/files/HeaderRuleEditor'
import { EnumsDialog } from '@/components/tables/EnumsDialog'
import { EnumRenameDialog } from '@/components/tables/EnumRenameDialog'
import { findEnumRenames, type EnumRename } from '@shared/table-enum-rename'

/** 没设过时给的起点：常见的游戏配置表 5 行表头 */
const START: SheetHeader = { start: 0, roles: ['modifier', 'side', 'type', 'name', 'comment'] }

type Style = TableSchema['style']
interface Draft {
  /** 几套表头；空 = 每张表自动识别 */
  headers: SheetHeader[]
  roleEnums: Style['roleEnums']
  /** 编辑中的原文（逗号分隔） */
  marks: string
  sep: string
  /** 按文件指定的表头（通配） */
  exceptions: Style['exceptions']
}
const toDraft = (s: TableSchema): Draft => ({
  headers: styleHeaders(s.style),
  roleEnums: s.style.roleEnums ?? {},
  marks: (s.style.arrayMarks ?? []).join(', '),
  sep: s.style.listSep ?? ';',
  exceptions: s.style.exceptions ?? [],
})

/**
 * 项目设置 → 表格的「表头」：整个项目的几套表头（各表行数不一样时设多套，每张表按内容自动挑最合的一套），
 * 每种表头行能填什么（选通用枚举）。存在表格结构文件（style.headers），不在项目设置里，所以有自己的「保存」；
 * 单张表在表格页「调整表头」覆盖。AI 分析写进结构文件后这里跟着更新
 */
export function ProjectTablesHeader({ projectId }: { projectId: string }) {
  const { schema, error } = useTableSchema(projectId)
  const { draft: d, changed, setDraft, reset } = useSchemaDraft(schema, toDraft)
  const [busy, setBusy] = useState(false)
  if (error) return <p className="text-footnote text-danger">{error}</p>
  if (!schema || !d) return null
  const set = (p: Partial<Draft>) => setDraft((x) => ({ ...x, ...p }))
  const setHeader = (i: number, h: SheetHeader) => set({ headers: d.headers.map((x, j) => (j === i ? h : x)) })
  const markList = d.marks
    .split(/[,，\s]+/)
    .map((x) => x.trim())
    .filter(Boolean)
  const enumNames = Object.keys(schema.enums).sort()
  const save = async () => {
    setBusy(true)
    try {
      // 空表头（0 行）的那套没意义，保存时去掉；旧字段 header 写第一套，旧版本的面板也认得
      const headers = d.headers.filter((h) => h.roles.length)
      const saved = await saveTableSchema(projectId, (cur) => ({
        ...cur,
        style: {
          ...cur.style,
          headers,
          header: headers[0],
          roleEnums: d.roleEnums,
          arrayMarks: markList,
          listSep: d.sep || ';',
          exceptions: d.exceptions
            .map((e) => ({ ...e, glob: e.glob.trim() }))
            .filter((e) => e.glob && e.header.roles.length),
        },
      }))
      reset(saved)
      toast.success(t('表头设置已保存'))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col gap-3">
      <div>
        <Segmented
          label={t('表头')}
          value={d.headers.length ? 'fixed' : 'auto'}
          onChange={(v) =>
            set({
              headers: v === 'auto' ? [] : styleHeaders(schema.style).length ? styleHeaders(schema.style) : [START],
            })
          }
          options={[
            { id: 'auto', label: t('每张表自动识别') },
            { id: 'fixed', label: t('按设定的表头') },
          ]}
        />
      </div>
      {d.headers.length > 0 && (
        <div className="flex flex-col gap-2">
          {d.headers.length > 1 && (
            <p className="text-caption text-subtle">
              {t('设了 {n} 套：每张表按内容自动挑最合的一套，一样合时用排在前面的。', { n: d.headers.length })}
            </p>
          )}
          {d.headers.map((h, i) => (
            <div key={i} className="rounded-(--c-card-radius) border px-3 py-2.5">
              <div className="mb-2 flex items-center gap-2">
                <span className="text-footnote font-medium">{t('第 {n} 套表头', { n: i + 1 })}</span>
                <span className="flex-1" />
                {d.headers.length > 1 && (
                  <IconButton
                    icon={Trash2}
                    size="xs"
                    tone="danger"
                    label={t('删掉第 {n} 套表头', { n: i + 1 })}
                    onClick={() => set({ headers: d.headers.filter((_, j) => j !== i) })}
                  />
                )}
              </div>
              <HeaderRuleEditor value={h} onChange={(x) => setHeader(i, x)} withLabels />
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={d.headers.length >= 20}
              onClick={() => set({ headers: [...d.headers, { start: 0, roles: ['type', 'name', 'comment'] }] })}
            >
              <Plus className="h-3.5 w-3.5" />
              {t('加一套表头')}
            </Button>
            <span className="text-caption text-subtle">
              {t('各表的表头行数不一样（比如配置表 5 行、枚举表 3 行）时加几套，不用按文件一张张设。')}
            </span>
          </div>
        </div>
      )}
      <ExceptionList value={d.exceptions} onChange={(exceptions) => set({ exceptions })} />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-footnote text-muted">
        <label className="flex items-center gap-2">
          {t('修饰行里表示数组的值')}
          <Input
            size="sm"
            value={d.marks}
            placeholder="repeated"
            onChange={(e) => set({ marks: e.target.value })}
            className="w-44 font-mono"
          />
        </label>
        <label className="flex items-center gap-2">
          {t('数组默认分隔符')}
          <Input
            size="sm"
            value={d.sep}
            maxLength={4}
            placeholder=";"
            onChange={(e) => set({ sep: e.target.value })}
            className="w-14 text-center font-mono"
          />
        </label>
        <span className="text-caption text-subtle">
          {t('类型写成 int[]、list<int> 也算数组；单独的列在「列结构」里改')}
        </span>
      </div>
      <div>
        <div className="mb-1.5 text-caption text-subtle">
          {t('每种表头行能填什么：选一个通用枚举，表头格子改的时候是下拉，填错标红；没字段名的备注列不查')}
        </div>
        <div className="grid gap-x-4 gap-y-1.5 md:grid-cols-2">
          {SHEET_ROLES.filter((r) => r !== 'name' && r !== 'comment').map((role) => (
            <label key={role} className="flex items-center gap-2 text-footnote text-muted">
              <span className={cn('h-3.5 w-3.5 shrink-0 rounded-sm sheet-role', `sheet-role-${role}`)} />
              <span className="w-24 shrink-0 truncate">{roleShort(role)}</span>
              <span className="min-w-0 flex-1">
                <Select
                  size="sm"
                  aria-label={t('{role}行能填什么', { role: roleShort(role) })}
                  value={d.roleEnums[role] ?? ''}
                  onChange={(e) => {
                    const v = e.target.value
                    const next = { ...d.roleEnums }
                    if (v) next[role] = v
                    else delete next[role]
                    set({ roleEnums: next })
                  }}
                  options={[
                    { value: '', label: t('不限') },
                    { value: TYPE_NAMES, label: t('基础类型和通用枚举名') },
                    ...enumNames.map((n) => ({ value: n, label: t('枚举 {e}', { e: n }) })),
                  ]}
                />
              </span>
            </label>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Button size="sm" disabled={!changed || busy} onClick={() => void save()}>
          {t('保存表头')}
        </Button>
        <span className="text-caption text-subtle">
          {t('存在表格结构文件里，表格文件不动；个别表不一样时在表格页「调整表头」单独改。')}
        </span>
      </div>
    </div>
  )
}

/**
 * 按文件指定表头：内容上分不出来、必须按目录 / 文件名指定的（AI 分析也会写到这里）。
 * 优先于上面的几套表头；单张表在表格页「调整表头」设的又优先于这里
 */
function ExceptionList({
  value,
  onChange,
}: {
  value: TableSchema['style']['exceptions']
  onChange: (v: TableSchema['style']['exceptions']) => void
}) {
  const put = (i: number, e: TableSchema['style']['exceptions'][number]) =>
    onChange(value.map((x, j) => (j === i ? e : x)))
  return (
    <div className="flex flex-col gap-2">
      {value.map((e, i) => (
        <div key={i} className="rounded-(--c-card-radius) border px-3 py-2.5">
          <div className="mb-2 flex items-center gap-2">
            <span className="shrink-0 text-footnote font-medium">{t('这些文件')}</span>
            <Input
              size="sm"
              aria-label={t('第 {n} 条按文件指定的通配', { n: i + 1 })}
              value={e.glob}
              placeholder="Config/Enum/*.xlsx"
              onChange={(ev) => put(i, { ...e, glob: ev.target.value })}
              className="min-w-0 flex-1 font-mono"
            />
            <IconButton
              icon={Trash2}
              size="xs"
              tone="danger"
              label={t('删掉第 {n} 条按文件指定', { n: i + 1 })}
              onClick={() => onChange(value.filter((_, j) => j !== i))}
            />
          </div>
          <HeaderRuleEditor value={e.header} onChange={(header) => put(i, { ...e, header })} withLabels />
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={value.length >= 100}
          onClick={() => onChange([...value, { glob: '', header: { start: 0, roles: ['type', 'name', 'comment'] } }])}
        >
          <Plus className="h-3.5 w-3.5" />
          {t('按文件指定表头')}
        </Button>
        <span className="text-caption text-subtle">
          {t('内容上分不出来的（比如某个目录的表都是另一种表头）按通配指定，优先于上面的几套。')}
        </span>
      </div>
    </div>
  )
}

/**
 * 项目设置 → 表格的「通用枚举」：整个项目所有表格共用的枚举库（结构文件 enums.json）。
 * 任何一张表的列在「列结构」里选它，或类型行写了同名类型，就按它下拉、检查
 */
export function ProjectTablesEnums({ projectId }: { projectId: string }) {
  const { schema, error } = useTableSchema(projectId)
  const [open, setOpen] = useState(false)
  const [renames, setRenames] = useState<EnumRename[] | null>(null)
  if (error) return <p className="text-footnote text-danger">{error}</p>
  if (!schema) return null
  const names = Object.keys(schema.enums).sort()
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {names.length ? (
          names.slice(0, 24).map((n) => (
            <span
              key={n}
              className="inline-flex h-6 items-center gap-1 rounded-(--c-badge-radius) bg-sel px-2 font-mono text-caption text-muted"
            >
              {n}
              <span className="text-subtle">{schema.enums[n].values.length}</span>
            </span>
          ))
        ) : (
          <span className="text-footnote text-subtle">{t('还没有通用枚举')}</span>
        )}
        {names.length > 24 && <span className="text-caption text-subtle">{t('等 {n} 个', { n: names.length })}</span>}
      </div>
      <div>
        <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
          <ListTree className="h-4 w-4" />
          {t('管理通用枚举')}
        </Button>
      </div>
      {open && (
        <EnumsDialog
          open
          schema={schema}
          onOpenChange={setOpen}
          onSave={async (enums) => {
            try {
              await saveTableSchema(projectId, (cur) => ({ ...cur, enums }))
              toast.success(t('通用枚举已保存'))
              const r = findEnumRenames(schema.enums, enums)
              if (r.length) setRenames(r)
            } catch (e) {
              toast.error((e as Error).message)
            }
          }}
        />
      )}
      {renames && <EnumRenameDialog projectId={projectId} renames={renames} onClose={() => setRenames(null)} />}
    </div>
  )
}
