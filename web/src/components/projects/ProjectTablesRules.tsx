import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { t } from '@shared/i18n'
import type { TableSchema } from '@shared/tables'
import { saveTableSchema, useSchemaDraft, useTableSchema } from '@/lib/table-schema'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Field, Input } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'

type Style = TableSchema['style']
interface Draft {
  saveCheck: Style['saveCheck']
  /** 每组：通配、逗号分隔的字段名（编辑中的原文） */
  uniques: { glob: string; fields: string }[]
}

const toDraft = ({ style: s }: { style: Style }): Draft => ({
  saveCheck: s.saveCheck ?? 'warn',
  uniques: (s.uniques ?? []).map((u) => ({ glob: u.glob, fields: u.fields.join(', ') })),
})
const splitFields = (s: string) =>
  s
    .split(/[,，\s+]+/)
    .map((x) => x.trim())
    .filter(Boolean)

/**
 * 项目设置 → 表格的「校验」：保存前有不合规的格子时怎么办，组合唯一（几列合起来不能重复）。
 * 存在表格结构文件（style），有自己的「保存」：保存前重新读一遍结构文件，只改这两项，不盖掉别处刚改的
 */
export function ProjectTablesRules({ projectId }: { projectId: string }) {
  const { schema, error } = useTableSchema(projectId)
  const { draft: d, saved, changed, setDraft, reset } = useSchemaDraft(schema, toDraft)
  const setD = (x: Draft) => setDraft(() => x)
  const [busy, setBusy] = useState(false)
  if (error) return <p className="text-footnote text-danger">{error}</p>
  if (!d) return null
  const uniques = d.uniques
    .map((u) => ({ glob: u.glob.trim(), fields: splitFields(u.fields) }))
    .filter((u) => u.glob && u.fields.length >= 2)
  const bad = d.uniques.some((u) => (u.glob.trim() || u.fields.trim()) && splitFields(u.fields).length < 2)
  const save = async () => {
    setBusy(true)
    try {
      reset(
        await saveTableSchema(projectId, (cur) => ({
          ...cur,
          style: { ...cur.style, saveCheck: d.saveCheck, uniques },
        })),
      )
      toast.success(t('已保存校验规则'))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const setU = (i: number, p: Partial<Draft['uniques'][number]>) =>
    setD({ ...d, uniques: d.uniques.map((u, j) => (j === i ? { ...u, ...p } : u)) })
  return (
    <div className="flex flex-col gap-4">
      <Field
        label={t('保存前检查')}
        tip={t('改过的格子不合规（类型、枚举、引用、正则、必填、重复……）时怎么办。只看这次改到的格子和行。')}
      >
        <div>
          <Segmented
            label={t('保存前检查')}
            value={d.saveCheck}
            onChange={(v) => setD({ ...d, saveCheck: v })}
            options={[
              { id: 'warn', label: t('提醒，可以照样保存') },
              { id: 'block', label: t('不合规就不让保存') },
              { id: 'off', label: t('不查') },
            ]}
          />
        </div>
      </Field>
      <Field
        label={t('组合唯一')}
        tip={t('这些表格里几列合起来不能重复，比如同一个角色的同一等级只能有一行。文件用通配，字段名逗号分隔。')}
      >
        <div className="flex flex-col gap-2">
          {d.uniques.map((u, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                aria-label={t('第 {n} 组的文件', { n: i + 1 })}
                placeholder="Config/RoleLevel*.xlsx"
                value={u.glob}
                onChange={(e) => setU(i, { glob: e.target.value })}
                className="flex-1 font-mono text-footnote"
              />
              <Input
                aria-label={t('第 {n} 组的字段', { n: i + 1 })}
                placeholder="RoleID, Level"
                value={u.fields}
                onChange={(e) => setU(i, { fields: e.target.value })}
                className="flex-1 font-mono text-footnote"
              />
              <IconButton
                icon={Trash2}
                label={t('删掉这一组')}
                onClick={() => setD({ ...d, uniques: d.uniques.filter((_, j) => j !== i) })}
              />
            </div>
          ))}
          <div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setD({ ...d, uniques: [...d.uniques, { glob: '', fields: '' }] })}
            >
              <Plus className="h-3.5 w-3.5" />
              {t('添加一组')}
            </Button>
          </div>
          {bad && <p className="text-caption text-warning">{t('每组至少写两个字段名，不然不会保存这一组。')}</p>}
        </div>
      </Field>
      <div className="flex items-center justify-end gap-2">
        {changed && (
          <span className="mr-auto text-caption text-subtle">{t('校验规则存在表格结构文件里，单独保存')}</span>
        )}
        <Button size="sm" variant="secondary" disabled={!changed || busy} onClick={() => saved && setD(saved)}>
          {t('还原')}
        </Button>
        <Button size="sm" disabled={!changed || busy} onClick={() => void save()}>
          {t('保存校验规则')}
        </Button>
      </div>
    </div>
  )
}
