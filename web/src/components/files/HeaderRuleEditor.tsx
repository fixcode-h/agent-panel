import { t } from '@shared/i18n'
import { SHEET_ROLES, type SheetHeader, type SheetRole } from '@shared/sheet-header'
import { cn } from '@/lib/utils'
import { Input, Select } from '@/components/ui/input'
import { roleLabel } from './sheet-roles'
import './sheet-table.css'

/** 表头最多设这么多行 */
export const MAX_HEADER_ROWS = 12

/**
 * 表头规则的编辑：从第几行开始、共几行、每行是什么（决定底色）。
 * 表格上方「调整表头」（单张表）和项目设置 → 表格的「表头」（整个项目的默认）共用
 */
export function HeaderRuleEditor({
  value,
  onChange,
  last = 1000,
  preview,
}: {
  value: SheetHeader
  onChange: (h: SheetHeader) => void
  /** 最多能从第几行开始（表的行数） */
  last?: number
  /** 这一行前几格的字：下拉框悬停时看得出是哪一行 */
  preview?: (r: number) => string
}) {
  const setStart = (v: number) => onChange({ ...value, start: Math.min(Math.max(1, v || 1), last) - 1 })
  const setCount = (v: number) => {
    const n = Math.min(Math.max(0, v || 0), MAX_HEADER_ROWS)
    const roles = value.roles.slice(0, n)
    while (roles.length < n) roles.push('other')
    onChange({ ...value, roles })
  }
  const setRole = (i: number, r: SheetRole) =>
    onChange({ ...value, roles: value.roles.map((x, j) => (j === i ? r : x)) })
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 text-body text-muted">
        {t('从第')}
        <Input
          size="sm"
          type="number"
          min={1}
          max={last}
          aria-label={t('表头从第几行开始')}
          value={value.start + 1}
          onChange={(e) => setStart(Number(e.target.value))}
          className="w-16 font-mono"
        />
        {t('行开始，共')}
        <Input
          size="sm"
          type="number"
          min={0}
          max={MAX_HEADER_ROWS}
          aria-label={t('表头共几行')}
          value={value.roles.length}
          onChange={(e) => setCount(Number(e.target.value))}
          className="w-16 font-mono"
        />
        {t('行')}
      </div>
      {value.roles.length > 0 && (
        <>
          <div className="mt-3 mb-1.5 text-caption text-subtle">{t('每行是什么（决定底色）')}</div>
          <div className="flex flex-col gap-1.5">
            {value.roles.map((r, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="w-6 shrink-0 text-right font-mono text-caption text-subtle">
                  {value.start + i + 1}
                </span>
                <span className={cn('h-4 w-4 shrink-0 rounded-sm sheet-role', `sheet-role-${r}`)} />
                <div className="min-w-0 flex-1">
                  <Select
                    size="sm"
                    aria-label={t('第 {n} 行', { n: value.start + i + 1 })}
                    title={preview?.(value.start + i)}
                    value={r}
                    onChange={(e) => setRole(i, e.target.value as SheetRole)}
                    options={SHEET_ROLES.map((x) => ({ value: x, label: roleLabel(x) }))}
                  />
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
