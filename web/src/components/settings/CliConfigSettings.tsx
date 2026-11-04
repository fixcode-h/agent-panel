import { useEffect, useState } from 'react'
import { defaultLabel, type ConfigSetting, type ConfigValue } from '@shared/cli-config-settings'
import type { CliDefinition } from '@shared/clis'
import { t } from '@shared/i18n'
import { cliMoreApi } from '@/lib/api-cli-more'
import { toast } from '@/lib/toast'
import { Input, Select } from '@/components/ui/input'
import { Row } from './parts'

/** 下拉里「跟随 CLI」那一项的值：不写进文件 */
const FOLLOW = '__follow'

/**
 * CLI 自己配置文件里的设置项（ADR 0050，定义里的 configSettings）：改了马上写进 CLI 的配置文件，
 * 只写改过的键；选回「跟随」就删掉这个键。和设置页别的项不同，不等「保存」——写的是 CLI 自己的文件，终端里也生效
 */
export function CliConfigSettings({ def }: { def: CliDefinition }) {
  const list = def.configSettings ?? []
  const [values, setValues] = useState<Record<string, ConfigValue> | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  useEffect(() => {
    setValues(null)
    cliMoreApi
      .cliConfig(def.id)
      .then((r) => {
        setValues(r.values)
        setError(r.error)
      })
      .catch((e) => setError((e as Error).message))
  }, [def.id])
  const save = async (s: ConfigSetting, value: ConfigValue | null) => {
    setBusy(s.id)
    try {
      const r = await cliMoreApi.saveCliConfig(def.id, s.id, value)
      setValues(r.values)
      setError(r.error)
    } catch (e) {
      toast.error(t('没有改成：{error}', { error: (e as Error).message }))
    } finally {
      setBusy('')
    }
  }
  if (!list.length) return null
  // 数字项旁边另写单位，占位里只写数
  const follow = (s: ConfigSetting) =>
    t('跟随 {cli}（{value}）', {
      cli: def.name,
      value: s.type === 'number' ? String(s.default) : defaultLabel(s, t('开'), t('关')),
    })
  return (
    <>
      {error && <p className="py-2 text-footnote text-warning">{error}</p>}
      {list.map((s) => {
        const v = values?.[s.id]
        const label = `${def.name} ${s.label}`
        return (
          <Row key={s.id} title={s.label} desc={s.hint}>
            {s.type === 'number' ? (
              <NumberField
                key={`${s.id}:${v ?? ''}`}
                value={typeof v === 'number' ? v : undefined}
                placeholder={follow(s)}
                unit={s.unit}
                label={label}
                disabled={!values || busy === s.id}
                onSave={(n) => void save(s, n)}
              />
            ) : (
              <Select
                aria-label={label}
                value={v === undefined ? FOLLOW : String(v)}
                disabled={!values || busy === s.id}
                onChange={(e) => {
                  const x = e.target.value
                  void save(s, x === FOLLOW ? null : s.type === 'boolean' ? x === 'true' : x)
                }}
                options={[
                  { value: FOLLOW, label: follow(s) },
                  ...(s.type === 'boolean'
                    ? [
                        { value: 'true', label: t('开') },
                        { value: 'false', label: t('关') },
                      ]
                    : s.choices.map((c) => ({ value: c.id, label: c.label }))),
                ]}
              />
            )}
          </Row>
        )
      })}
    </>
  )
}

/** 数字项：失焦或回车时写；清空就是跟随 CLI 的默认值 */
function NumberField({
  value,
  placeholder,
  unit,
  label,
  disabled,
  onSave,
}: {
  value: number | undefined
  placeholder: string
  unit: string
  label: string
  disabled: boolean
  onSave: (v: number | null) => void
}) {
  const [text, setText] = useState(value === undefined ? '' : String(value))
  const commit = () => {
    const s = text.trim()
    const n = s ? Number(s) : null
    if (n !== null && !Number.isFinite(n)) return setText(value === undefined ? '' : String(value))
    if ((n ?? undefined) !== value) onSave(n)
  }
  return (
    <div className="flex items-center gap-2">
      <Input
        type="number"
        aria-label={label}
        value={text}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
        className="h-9 w-40 text-right font-mono text-body"
      />
      {unit && <span className="text-footnote text-subtle">{unit}</span>}
    </div>
  )
}
