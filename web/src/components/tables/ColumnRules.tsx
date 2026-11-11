import { t } from '@shared/i18n'
import type { TableColumn } from '@shared/tables'
import { patternRe } from '@shared/table-struct'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, Input, Select } from '@/components/ui/input'

/**
 * 列结构里的校验规则：正则（整格要符合）、必填、条件必填（同一行另一列是某些值时必填）。
 * when 是条件必填的值的原文（逗号分隔），由列结构一起存
 */
export function ColumnRules({
  d,
  onChange,
  fields,
  when,
  onWhen,
}: {
  d: TableColumn
  onChange: (d: TableColumn) => void
  /** 这张表的其它字段名（条件必填选哪一列） */
  fields: string[]
  when: string
  onWhen: (v: string) => void
}) {
  const badRe = !!d.pattern && !patternRe(d.pattern)
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-dashed px-2.5 py-2">
      <Field
        label={t('格式（正则）')}
        tip={t('整格要符合这个正则，数组列按每一项比；例如 [A-Z]{2}\\d+')}
        error={badRe ? t('正则写得不对') : undefined}
      >
        <Input
          size="sm"
          placeholder="[A-Z]{2}\d+"
          value={d.pattern ?? ''}
          onChange={(e) => onChange({ ...d, pattern: e.target.value || undefined })}
          className="font-mono"
        />
      </Field>
      <Checkbox
        checked={!!d.required}
        onChange={(v) => onChange({ ...d, required: v || undefined })}
        label={t('必填')}
        tip={t('数据行里这一列不能空着')}
      />
      {!d.required && (
        <div className="grid grid-cols-[1fr_1fr] gap-2">
          <Field label={t('当这一列')} tip={t('同一行的这一列是下面这些值时，这一列必填')}>
            <Select
              size="sm"
              value={d.requiredWhen?.field ?? ''}
              onChange={(e) =>
                onChange({
                  ...d,
                  requiredWhen: e.target.value
                    ? { field: e.target.value, values: d.requiredWhen?.values ?? [] }
                    : undefined,
                })
              }
              options={[{ value: '', label: t('不设条件') }, ...fields.map((f) => ({ value: f, label: f }))]}
            />
          </Field>
          <Field label={t('是这些值时必填')}>
            <Input
              size="sm"
              disabled={!d.requiredWhen}
              placeholder="give, reward"
              value={when}
              onChange={(e) => onWhen(e.target.value)}
              className="font-mono"
            />
          </Field>
        </div>
      )}
    </div>
  )
}
