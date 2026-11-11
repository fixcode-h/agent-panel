import { useEffect, useState } from 'react'
import { ListTree } from 'lucide-react'
import { toast } from '@/lib/toast'
import { t } from '@shared/i18n'
import { SHEET_ROLES, type SheetHeader } from '@shared/sheet-header'
import { TYPE_NAMES, type TableSchema } from '@shared/tables'
import { tablesApi } from '@/lib/tables-api'
import { Button } from '@/components/ui/button'
import { Segmented } from '@/components/ui/segmented'
import { Input, Select } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { roleShort } from '@/components/files/sheet-roles'
import '@/components/files/sheet-table.css'
import { HeaderRuleEditor } from '@/components/files/HeaderRuleEditor'
import { EnumsDialog } from '@/components/tables/EnumsDialog'

/** 没设过时给的起点：常见的游戏配置表 5 行表头 */
const START: SheetHeader = { start: 0, roles: ['modifier', 'side', 'type', 'name', 'comment'] }

/**
 * 项目设置 → 表格的「表头」：整个项目的表头从第几行开始、共几行、每行是什么，每种表头行能填什么（选通用枚举）。
 * 存在表格结构文件（style.header），不在项目设置里，所以有自己的「保存」；单张表在表格页「调整表头」覆盖
 */
export function ProjectTablesHeader({ projectId }: { projectId: string }) {
  const [schema, setSchema] = useState<TableSchema | null>(null)
  const [draft, setDraft] = useState<SheetHeader | null>(null)
  const [roleEnums, setRoleEnums] = useState<TableSchema['style']['roleEnums']>({})
  const [marks, setMarks] = useState('')
  const [sep, setSep] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    tablesApi
      .schema(projectId)
      .then((s) => {
        setSchema(s)
        setDraft(s.style.header ?? null)
        setRoleEnums(s.style.roleEnums ?? {})
        setMarks((s.style.arrayMarks ?? []).join(', '))
        setSep(s.style.listSep ?? ';')
      })
      .catch((e) => setError((e as Error).message))
  }, [projectId])
  if (error) return <p className="text-footnote text-danger">{error}</p>
  if (!schema) return null
  const saved = schema.style.header ?? null
  const markList = marks
    .split(/[,，\s]+/)
    .map((x) => x.trim())
    .filter(Boolean)
  const changed =
    JSON.stringify(saved) !== JSON.stringify(draft) ||
    JSON.stringify(schema.style.arrayMarks ?? []) !== JSON.stringify(markList) ||
    (schema.style.listSep ?? ';') !== (sep || ';') ||
    JSON.stringify(schema.style.roleEnums ?? {}) !== JSON.stringify(roleEnums)
  const enumNames = Object.keys(schema.enums).sort()
  const save = async () => {
    setBusy(true)
    try {
      const next = {
        ...schema,
        style: { ...schema.style, header: draft ?? undefined, roleEnums, arrayMarks: markList, listSep: sep || ';' },
      }
      setSchema(await tablesApi.saveSchema(projectId, next))
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
          value={draft ? 'fixed' : 'auto'}
          onChange={(v) => setDraft(v === 'auto' ? null : (saved ?? START))}
          options={[
            { id: 'auto', label: t('每张表自动识别') },
            { id: 'fixed', label: t('全部按固定行数') },
          ]}
        />
      </div>
      {draft && <HeaderRuleEditor value={draft} onChange={setDraft} withLabels />}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-footnote text-muted">
        <label className="flex items-center gap-2">
          {t('修饰行里表示数组的值')}
          <Input
            size="sm"
            value={marks}
            placeholder="repeated"
            onChange={(e) => setMarks(e.target.value)}
            className="w-44 font-mono"
          />
        </label>
        <label className="flex items-center gap-2">
          {t('数组默认分隔符')}
          <Input
            size="sm"
            value={sep}
            maxLength={4}
            placeholder=";"
            onChange={(e) => setSep(e.target.value)}
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
                  value={roleEnums[role] ?? ''}
                  onChange={(e) => {
                    const v = e.target.value
                    setRoleEnums((m) => {
                      const next = { ...m }
                      if (v) next[role] = v
                      else delete next[role]
                      return next
                    })
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
 * 项目设置 → 表格的「通用枚举」：整个项目所有表格共用的枚举库（结构文件 enums.json）。
 * 任何一张表的列在「列结构」里选它，或类型行写了同名类型，就按它下拉、检查
 */
export function ProjectTablesEnums({ projectId }: { projectId: string }) {
  const [schema, setSchema] = useState<TableSchema | null>(null)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    tablesApi
      .schema(projectId)
      .then(setSchema)
      .catch((e) => setError((e as Error).message))
  }, [projectId])
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
              setSchema(await tablesApi.saveSchema(projectId, { ...schema, enums }))
              toast.success(t('通用枚举已保存'))
            } catch (e) {
              toast.error((e as Error).message)
            }
          }}
        />
      )}
    </div>
  )
}
