import { useEffect, useState } from 'react'
import { Loader2, Package, ShieldAlert, Trash2 } from 'lucide-react'
import type { InstalledPackage } from '@shared/cli-spec'
import type { CliDefinition } from '@shared/clis'
import { t } from '@shared/i18n'
import { cliMoreApi } from '@/lib/api-cli-more'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

/**
 * 这个项目的插件（ADR 0050 第四期，定义里 packages.local）：装进项目自己的配置（Pi 的 .pi/settings.json），
 * 只有这个项目里的对话加载，也跟着项目进版本管理、给同事用。项目配置要信任了才加载，没选「信任」时提示
 */
export function ProjectPackages({
  def,
  projectId,
  trusted,
}: {
  def: CliDefinition
  projectId: string
  /** 项目设置里这个 CLI 选了「信任」：没信任时项目里的插件不会加载 */
  trusted: boolean
}) {
  const local = def.packages?.local
  const [list, setList] = useState<InstalledPackage[] | null>(null)
  const [error, setError] = useState('')
  const [source, setSource] = useState('')
  const [busy, setBusy] = useState('')
  const [result, setResult] = useState<{ ok: boolean; output: string } | null>(null)
  useEffect(() => {
    if (!local) return
    setList(null)
    cliMoreApi
      .projectPackages(def.id, projectId)
      .then((l) => {
        setList(l)
        setError('')
      })
      .catch((e) => setError((e as Error).message))
  }, [def.id, projectId, local])
  if (!local) return null
  const run = async (action: 'install' | 'remove', target: string) => {
    setBusy(`${action}:${target}`)
    setResult(null)
    try {
      const r = await cliMoreApi.projectPackageAction(def.id, projectId, action, target)
      setList(r.packages)
      setResult({ ok: r.ok, output: r.output })
      if (r.ok && action === 'install') setSource('')
    } catch (e) {
      setResult({ ok: false, output: (e as Error).message })
    } finally {
      setBusy('')
    }
  }
  return (
    <section className="flex flex-col gap-2 pt-6">
      <h3 className="text-body font-medium">{t('这个项目的插件')}</h3>
      <p className="text-footnote text-muted">
        {t(
          '装在项目的 {file} 里，只有这个项目的对话加载，也会跟着项目给同事用。插件会在本机执行代码，只装信得过的来源',
          {
            file: local.file,
          },
        )}
      </p>
      {!trusted && (
        <p className="flex items-start gap-1.5 text-footnote text-warning">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {t('上面的「项目配置」没选「信任」，面板里运行的 {cli} 不会加载这里的插件', { cli: def.name })}
        </p>
      )}
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
          placeholder={def.packages?.placeholder}
          aria-label={t('项目插件的来源')}
          className="h-9 flex-1 font-mono text-body"
          spellCheck={false}
        />
        <Button type="submit" variant="secondary" disabled={!source.trim() || !!busy}>
          {busy === `install:${source.trim()}` && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {t('安装')}
        </Button>
      </form>
      {error ? (
        <p className="text-footnote text-warning">{t('读取失败：{error}', { error })}</p>
      ) : !list ? (
        <p className="text-footnote text-subtle">{t('读取中…')}</p>
      ) : !list.length ? (
        <p className="text-footnote text-subtle">{t('这个项目还没有装插件')}</p>
      ) : (
        <Card as="ul" className="flex flex-col divide-y rounded-lg" aria-label={t('这个项目的插件')}>
          {list.map((p) => (
            <li key={p.source} className="flex items-center gap-2.5 px-3 py-2" title={p.target}>
              <Package className="h-3.5 w-3.5 shrink-0 text-accent-text" />
              <span className="min-w-0 flex-1 truncate font-mono text-body">{p.source}</span>
              {p.version && <span className="shrink-0 font-mono text-caption text-subtle">{p.version}</span>}
              <Button
                size="icon-sm"
                variant="ghost"
                disabled={!!busy}
                onClick={() => void run('remove', p.target)}
                aria-label={t('卸载 {name}', { name: p.source })}
                title={t('卸载')}
              >
                {busy === `remove:${p.target}` ? (
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
            'max-h-40 overflow-auto rounded-lg border px-3 py-2 font-mono text-caption whitespace-pre-wrap',
            result.ok ? 'text-muted' : 'border-danger/40 text-danger',
          )}
        >
          {result.output}
        </pre>
      )}
    </section>
  )
}
