import { useEffect, useState } from 'react'
import type { CliDefinition } from '@shared/clis'
import { t } from '@shared/i18n'
import { cliMoreApi } from '@/lib/api-cli-more'
import { toast } from '@/lib/toast'
import { Card } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'

/**
 * CLI 自带、默认加载的扩展的开关（ADR 0050 第四期，定义里 packages.builtins）：关掉的写进 CLI 的配置，
 * 终端里的 CLI 也一样不加载。和设置里「codemode 和工具搜索」不同：那个管这次运行给不给模型用，这里管加不加载
 */
export function CliBuiltins({ def }: { def: CliDefinition }) {
  const spec = def.packages?.builtins
  const [state, setState] = useState<Record<string, boolean> | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!spec) return
    cliMoreApi
      .builtins(def.id)
      .then(setState)
      .catch((e) => setError((e as Error).message))
  }, [def.id, spec])
  if (!spec) return null
  const toggle = async (id: string, on: boolean) => {
    try {
      setState(await cliMoreApi.setBuiltin(def.id, id, on))
    } catch (e) {
      toast.error(t('没有改成：{error}', { error: (e as Error).message }))
    }
  }
  return (
    <>
      <p className="pt-2 text-footnote text-subtle">{t('{cli} 自带的扩展', { cli: def.name })}</p>
      {error && <p className="text-footnote text-warning">{t('读取失败：{error}', { error })}</p>}
      <Card as="ul" className="flex flex-col divide-y rounded-lg" aria-label={t('{cli} 自带的扩展', { cli: def.name })}>
        {spec.items.map((x) => (
          <li key={x.id} className="flex items-center gap-3 px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="text-body">{x.label}</p>
              {x.hint && <p className="text-footnote leading-relaxed text-muted">{x.hint}</p>}
            </div>
            <Switch
              checked={state?.[x.id] ?? true}
              disabled={!state}
              onCheckedChange={(v) => void toggle(x.id, v)}
              aria-label={t('{cli} 自带的 {name}', { cli: def.name, name: x.label })}
            />
          </li>
        ))}
      </Card>
    </>
  )
}
