import { useEffect, useState } from 'react'
import { FileText, Loader2, Package, RefreshCw, SlidersHorizontal, Trash2 } from 'lucide-react'
import { packageIdentity, type InstalledPackage } from '@shared/cli-spec'
import type { CliDefinition } from '@shared/clis'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Segmented } from '@/components/ui/segmented'
import { cliMoreApi } from '@/lib/api-cli-more'
import { npmName } from '@shared/cli-spec'
import { CliGallery } from './CliGallery'
import { PackageChangelog } from './PackageChangelog'
import { PackageResources } from './PackageResources'
import { CliBuiltins } from './CliBuiltins'

type Action = 'install' | 'remove' | 'update' | 'updateAll'

/**
 * CLI 自己的插件（扩展包，例如 Pi 的 pi install）：列表读 CLI 的配置文件，装、删、更新跑 CLI 的命令。
 * 定义里推荐的包排在最前面、一键安装（Pi 第一个是联网搜索：面板不另做搜索，Pi 靠插件联网）。
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
  // 「浏览」是插件市场（定义里写了 gallery 才有）；npm 上的最新版本用来标「有新版本」，取不到就不标
  const [tab, setTab] = useState<'mine' | 'browse'>('mine')
  const [latest, setLatest] = useState<Record<string, string>>({})
  // 展开了更新说明的包；from 是刚更新完时更新前的版本（只列比它新的）
  const [notes, setNotes] = useState<{ source: string; from?: string } | null>(null)
  // 展开了资源开关的包
  const [res, setRes] = useState('')
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
    setTab('mine')
    setLatest({})
    setNotes(null)
    setRes('')
    void load()
    if (spec.npmRoot)
      cliMoreApi
        .cliPackagesLatest(def.id)
        .then(setLatest)
        .catch(() => setLatest({}))
    // load 每次渲染都是新的函数，只在换 CLI 时重新读
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [def.id])
  const run = async (action: Action, target = '') => {
    setBusy({ action, target })
    setResult(null)
    try {
      const before = list?.find((p) => p.target === target)
      const r = await api.cliPackageAction(def.id, action, target)
      setList(r.packages)
      // 单个包更新完、版本变了：展开它这次新增的更新说明
      const after = r.packages.find((p) => p.source === before?.source)
      if (spec.changelog && action === 'update' && before?.version && after?.version !== before.version)
        setNotes({ source: before.source, from: before.version })
      setResult({ ok: r.ok, output: r.output })
      if (r.ok && action === 'install') setSource('')
    } catch (e) {
      setResult({ ok: false, output: (e as Error).message })
    } finally {
      setBusy(null)
    }
  }
  const spin = (action: Action, target = '') => busy?.action === action && busy.target === target
  // 推荐的包装没装按去掉版本号的来源比：用户可能装的是 npm:x@1.2.0
  const installed = new Set((list ?? []).map((p) => packageIdentity(p.source)))
  return (
    <div className="flex flex-col gap-2">
      {spec.gallery && (
        <Segmented
          label={t('插件')}
          value={tab}
          onChange={setTab}
          options={[
            { id: 'mine', label: t('已安装和推荐') },
            { id: 'browse', label: t('浏览插件市场') },
          ]}
          className="mb-1 self-start"
        />
      )}
      {tab === 'browse' ? (
        <CliGallery def={def} installed={installed} busy={!!busy || !list} onInstall={(s) => run('install', s)} />
      ) : (
        mine()
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
    </div>
  )
  // 已装和推荐（原来的整页）：当普通函数调用、不当组件用，否则每次渲染都重建，输入框会丢焦点
  function mine() {
    return (
      <>
        {spec.recommended.length > 0 && (
          <>
            <p className="text-footnote text-subtle">{t('推荐')}</p>
            <Card as="ul" className="mb-2 flex flex-col divide-y rounded-lg" aria-label={t('推荐的插件')}>
              {spec.recommended.map((r) => {
                const has = installed.has(packageIdentity(r.source))
                return (
                  <li key={r.source} className="flex items-start gap-2.5 px-3 py-2.5">
                    <Package className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-text" />
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-baseline gap-x-2">
                        <span className="text-body font-medium">{r.name}</span>
                        {r.url ? (
                          <a
                            href={r.url}
                            target="_blank"
                            rel="noreferrer"
                            className="font-mono text-caption text-subtle hover:text-accent-text hover:underline"
                          >
                            {r.source}
                          </a>
                        ) : (
                          <span className="font-mono text-caption text-subtle">{r.source}</span>
                        )}
                      </p>
                      <p className="mt-0.5 text-footnote leading-relaxed text-muted">{r.desc}</p>
                      {r.note && <p className="mt-0.5 text-footnote leading-relaxed text-subtle">{r.note}</p>}
                    </div>
                    {has ? (
                      <Badge tone="success" className="mt-0.5 shrink-0">
                        {t('已安装')}
                      </Badge>
                    ) : (
                      <Button
                        size="sm"
                        variant="secondary"
                        className="shrink-0"
                        // 列表还没读到时不知道装没装，先不让点，免得把已装的再装一遍
                        disabled={!list || !!busy}
                        onClick={() => void run('install', r.source)}
                        aria-label={t('安装 {name}', { name: r.name })}
                      >
                        {spin('install', r.source) && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                        {t('安装')}
                      </Button>
                    )}
                  </li>
                )
              })}
            </Card>
          </>
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
            placeholder={spec.placeholder}
            aria-label={t('包的来源')}
            className="h-9 flex-1 font-mono text-body"
            spellCheck={false}
          />
          <Button type="submit" variant="secondary" disabled={!source.trim() || !!busy}>
            {spin('install', source.trim()) && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t('安装')}
          </Button>
        </form>
        <div className="flex items-center text-footnote text-subtle">
          {list && t('已装 {n} 个', { n: list.length })}
          {spec.updateAll && !!list?.length && (
            <button
              onClick={() => void run('updateAll')}
              disabled={!!busy}
              className="ml-auto inline-flex cursor-pointer items-center gap-1 text-accent-text disabled:cursor-default disabled:opacity-60"
            >
              <RefreshCw className={cn('h-3 w-3', spin('updateAll') && 'animate-spin')} />
              {t('全部更新')}
            </button>
          )}
        </div>
        {error ? (
          <p className="text-footnote text-warning">{t('读取失败：{error}', { error })}</p>
        ) : !list ? (
          <p className="text-footnote text-subtle">{t('读取中…')}</p>
        ) : !list.length ? (
          <p className="text-footnote text-subtle">{t('还没有装插件')}</p>
        ) : (
          <Card as="ul" className="flex flex-col divide-y rounded-lg" aria-label={t('已装的插件')}>
            {list.map((p) => (
              <li key={p.source} className="flex flex-col">
                <div className="group flex items-center gap-2.5 px-3 py-2" title={p.target}>
                  <Package className="h-3.5 w-3.5 shrink-0 text-accent-text" />
                  <span className="min-w-0 flex-1 truncate font-mono text-body">{p.source}</span>
                  <PackageVersion version={p.version} latest={latest[npmName(p.source)]} />
                  {spec.resources && (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-expanded={res === p.source}
                      onClick={() => setRes(res === p.source ? '' : p.source)}
                      aria-label={t('{name} 的资源开关', { name: p.source })}
                      title={t('加载哪些资源')}
                    >
                      <SlidersHorizontal className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  {spec.changelog && (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-expanded={notes?.source === p.source}
                      onClick={() => setNotes(notes?.source === p.source ? null : { source: p.source })}
                      aria-label={t('{name} 的更新说明', { name: p.source })}
                      title={t('更新说明')}
                    >
                      <FileText className="h-3.5 w-3.5" />
                    </Button>
                  )}
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
                </div>
                {res === p.source && <PackageResources cli={def.id} source={p.source} />}
                {notes?.source === p.source && <PackageChangelog cli={def.id} source={p.source} from={notes.from} />}
              </li>
            ))}
          </Card>
        )}
        <CliBuiltins def={def} />
      </>
    )
  }
}

/** 已装的版本；npm 上有更新的版本时标出来（更新按钮就在旁边） */
function PackageVersion({ version, latest }: { version?: string; latest?: string }) {
  if (!version) return null
  const newer = !!latest && latest !== version
  return (
    <span
      className={cn('shrink-0 font-mono text-caption', newer ? 'text-warning' : 'text-subtle')}
      title={newer ? t('npm 上最新是 {latest}', { latest }) : undefined}
    >
      {newer ? t('{version} → {latest} 有新版本', { version, latest }) : version}
    </span>
  )
}
