import { useEffect, useState } from 'react'
import { Loader2, Package, RefreshCw, Trash2 } from 'lucide-react'
import type { InstalledPackage } from '@shared/cli-spec'
import type { CliDefinition } from '@shared/clis'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card } from '@/components/ui/card'

type Action = 'install' | 'remove' | 'update' | 'updateAll'

/**
 * CLI 自己的扩展包（例如 Pi 的 pi install）：列表读 CLI 的配置文件，装、删、更新跑 CLI 的命令。
 * 命令的输出原样显示，失败时用户能看到原因
 */
export function CliPackages({ def }: { def: CliDefinition }) {
  const spec = def.packages!
  const [list, setList] = useState<InstalledPackage[] | null>(null)
  const [error, setError] = useState('')
  const [source, setSource] = useState('')
  // 正在跑的操作：哪个动作、对哪个包，同一时间只跑一个
  const [busy, setBusy] = useState<{ action: Action; target: string } | null>(null)
  const [result, setResult] = useState<{ ok: boolean; output: string } | null>(null)
  const load = () =>
    api
      .cliPackages(def.id)
      .then((l) => {
        setList(l)
        setError('')
      })
      .catch((e) => setError((e as Error).message))
  useEffect(() => {
    setList(null)
    setResult(null)
    void load()
    // load 每次渲染都是新的函数，只在换 CLI 时重新读
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [def.id])
  const run = async (action: Action, target = '') => {
    setBusy({ action, target })
    setResult(null)
    try {
      const r = await api.cliPackageAction(def.id, action, target)
      setList(r.packages)
      setResult({ ok: r.ok, output: r.output })
      if (r.ok && action === 'install') setSource('')
    } catch (e) {
      setResult({ ok: false, output: (e as Error).message })
    } finally {
      setBusy(null)
    }
  }
  const spin = (action: Action, target = '') => busy?.action === action && busy.target === target
  return (
    <div className="flex flex-col gap-2">
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (source.trim() && !busy) void run('install', source.trim())
        }}
      >
        <Input
          value={source}
          onChange={(e) => setSource(e.target.value)}
          placeholder={spec.placeholder}
          aria-label={t('包的来源')}
          className="h-9 flex-1 font-mono text-[0.8125rem]"
          spellCheck={false}
        />
        <Button type="submit" variant="secondary" disabled={!source.trim() || !!busy}>
          {spin('install', source.trim()) && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {t('安装')}
        </Button>
      </form>
      <div className="flex items-center text-[0.75rem] text-subtle">
        {list && t('共 {n} 个', { n: list.length })}
        {spec.updateAll && !!list?.length && (
          <button
            onClick={() => void run('updateAll')}
            disabled={!!busy}
            className="ml-auto inline-flex cursor-pointer items-center gap-1 text-accent disabled:cursor-default disabled:opacity-60"
          >
            <RefreshCw className={cn('h-3 w-3', spin('updateAll') && 'animate-spin')} />
            {t('全部更新')}
          </button>
        )}
      </div>
      {error ? (
        <p className="text-[0.75rem] text-warning">{t('读取失败：{error}', { error })}</p>
      ) : !list ? (
        <p className="text-[0.75rem] text-subtle">{t('读取中…')}</p>
      ) : !list.length ? (
        <p className="text-[0.75rem] text-subtle">{t('还没有装扩展包')}</p>
      ) : (
        <Card as="ul" className="flex flex-col divide-y rounded-lg" aria-label={t('已装的扩展包')}>
          {list.map((p) => (
            <li key={p.source} className="group flex items-center gap-2.5 px-3 py-2" title={p.target}>
              <Package className="h-3.5 w-3.5 shrink-0 text-accent" />
              <span className="min-w-0 flex-1 truncate font-mono text-[0.8125rem]">{p.source}</span>
              {spec.update && (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  disabled={!!busy}
                  onClick={() => void run('update', p.target)}
                  aria-label={t('更新 {name}', { name: p.source })}
                  title={t('更新')}
                >
                  <RefreshCw className={cn('h-3.5 w-3.5', spin('update', p.target) && 'animate-spin')} />
                </Button>
              )}
              <Button
                size="icon-sm"
                variant="ghost"
                disabled={!!busy}
                onClick={() => void run('remove', p.target)}
                aria-label={t('卸载 {name}', { name: p.source })}
                title={t('卸载')}
              >
                {spin('remove', p.target) ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" />
                )}
              </Button>
            </li>
          ))}
        </Card>
      )}
      {result?.output && (
        <pre
          className={cn(
            'max-h-40 overflow-auto rounded-lg border px-3 py-2 font-mono text-[0.71875rem] whitespace-pre-wrap',
            result.ok ? 'text-muted' : 'border-danger/40 text-danger',
          )}
        >
          {result.output}
        </pre>
      )}
    </div>
  )
}
