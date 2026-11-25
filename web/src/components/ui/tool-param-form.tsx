import type { ToolParam } from '@shared/custom-tools/schema'
import { t } from '@shared/i18n'
import { Field, Input, Select } from './input'
import { Switch } from './switch'

export type ParamValues = Record<string, string | boolean>

/** 表单的初始值：按参数的默认值 */
export const paramDefaults = (params: ToolParam[]): ParamValues =>
  Object.fromEntries(
    params.map((p) => [
      p.name,
      p.type === 'boolean' ? p.default === true || p.default === 'true' : String(p.default ?? ''),
    ]),
  )

/** 交给接口的参数：空串不传（用默认值） */
export const paramArgs = (v: ParamValues) => Object.fromEntries(Object.entries(v).filter(([, x]) => x !== ''))

/**
 * 按自建工具的参数定义生成的表单（ADR 0082）：试运行、以后「/」菜单里直接运行都用它。
 * 文本、数字、路径是输入框，选项是下拉，开关是开关；标签是参数的中文名，没写时用参数名
 */
export function ToolParamForm({
  params,
  values,
  onChange,
}: {
  params: ToolParam[]
  values: ParamValues
  onChange: (v: ParamValues) => void
}) {
  if (!params.length) return <p className="text-footnote text-subtle">{t('这个工具没有参数。')}</p>
  const set = (k: string, v: string | boolean) => onChange({ ...values, [k]: v })
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {params.map((p) => {
        const label = `${p.label || p.name}${p.required ? ' *' : ''}`
        const hint = p.desc || undefined
        if (p.type === 'boolean')
          return (
            <Field key={p.name} label={label} hint={hint}>
              <Switch checked={values[p.name] === true} onCheckedChange={(v) => set(p.name, v)} aria-label={label} />
            </Field>
          )
        if (p.type === 'enum')
          return (
            <Field key={p.name} label={label} hint={hint}>
              <Select
                value={String(values[p.name] ?? '')}
                onChange={(e) => set(p.name, e.target.value)}
                options={[
                  ...(p.required ? [] : [{ value: '', label: t('（默认）') }]),
                  ...p.options.map((o) => ({ value: o, label: o })),
                ]}
              />
            </Field>
          )
        return (
          <Field key={p.name} label={label} hint={hint}>
            <Input
              value={String(values[p.name] ?? '')}
              inputMode={p.type === 'number' ? 'decimal' : undefined}
              className={p.type === 'path' ? 'font-mono' : undefined}
              placeholder={p.default !== undefined ? String(p.default) : ''}
              onChange={(e) => set(p.name, e.target.value)}
            />
          </Field>
        )
      })}
    </div>
  )
}
