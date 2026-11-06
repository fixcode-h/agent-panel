import { RotateCcw } from 'lucide-react'
import { t } from '@shared/i18n'
import type { CliDefinition } from '@shared/clis'
import { Input } from '@/components/ui/input'
import { IconButton } from '@/components/ui/icon-button'
import { HelpTip } from '@/components/ui/help-tip'
import { Row } from './parts'

/**
 * CLI 定义自带的环境变量：键和默认值来自 CLI 定义，用户改过的值存成同名覆盖。
 * 定义里有的键只在这里出现，下面的自由编辑区只放用户自己加的键，同一个键只有一个编辑入口。
 */
export function DefaultEnv({
  def,
  overrides,
  onChange,
}: {
  def: CliDefinition
  overrides: Record<string, string>
  onChange: (v: Record<string, string>) => void
}) {
  const entries = Object.entries(def.env ?? {})
  if (!entries.length) return null
  // 改成默认值等于没有改过：不存覆盖，「恢复默认」就是删掉这一条
  const set = (key: string, value: string, fallback: string) => {
    const next = { ...overrides }
    if (value === fallback) delete next[key]
    else next[key] = value
    onChange(next)
  }
  return (
    <Row
      title={t('默认环境变量')}
      desc={t('每次运行都会带上，可以改值')}
      hint={t(
        '这些是 {cli} 的 CLI 配置里自带的，每次运行都会传给 {cli}。改过的值存成同名覆盖，点右边的按钮恢复默认。',
        { cli: def.name },
      )}
      stack
    >
      <div className="flex flex-col gap-2">
        {entries.map(([key, fallback]) => {
          const changed = Object.hasOwn(overrides, key)
          // 有中文名的只显示中文名，变量名和说明放问号里（用户看不懂一串大写的变量名）；没登记的照旧显示变量名
          const note = def.envNotes?.[key]
          return (
            <div key={key} className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
              <span className="flex min-w-0 shrink-0 flex-col sm:w-[300px]">
                {note ? (
                  <span className="flex items-center gap-1.5 text-body text-muted">
                    {note.label}
                    <HelpTip>
                      {note.hint && <p>{note.hint}</p>}
                      <p className="pt-1">
                        {t('环境变量')} <code className="font-mono break-all">{key}</code>
                      </p>
                    </HelpTip>
                  </span>
                ) : (
                  <code className="font-mono text-body break-all text-muted" title={key}>
                    {key}
                  </code>
                )}
                {changed && !!fallback && (
                  <span className="text-caption break-all text-subtle">{t('默认 {value}', { value: fallback })}</span>
                )}
              </span>
              <div className="relative min-w-0 flex-1">
                <Input
                  aria-label={t('{key} 的值', { key: note?.label ?? key })}
                  className="h-9 pr-8 font-mono text-body"
                  value={changed ? overrides[key] : fallback}
                  onChange={(e) => set(key, e.target.value, fallback)}
                  spellCheck={false}
                />
                {changed && (
                  <IconButton
                    icon={RotateCcw}
                    label={t('恢复默认')}
                    onClick={() => set(key, fallback, fallback)}
                    className="absolute top-1/2 right-1.5 -translate-y-1/2"
                  />
                )}
              </div>
            </div>
          )
        })}
      </div>
    </Row>
  )
}
