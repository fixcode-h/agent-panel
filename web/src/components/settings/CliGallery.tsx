import { useEffect, useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Loader2,
  Package,
  RefreshCw,
  Search,
  TriangleAlert,
} from 'lucide-react'
import {
  cautionOf,
  GALLERY_SORTS,
  overlapNote,
  type GalleryItem,
  type GalleryPage,
  type GallerySort,
} from '@shared/cli-gallery'
import { packageIdentity } from '@shared/cli-spec'
import type { CliDefinition } from '@shared/clis'
import { t } from '@shared/i18n'
import { timeAgo } from '@shared/task'
import { formatTokens } from '@shared/usage'
import { cliMoreApi } from '@/lib/api-cli-more'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Input, Select } from '@/components/ui/input'

const SORT_LABEL: Record<GallerySort, string> = {
  monthly: t('月下载'),
  weekly: t('周下载'),
  recent: t('最近发布'),
  dependents: t('被依赖数'),
  name: t('名称'),
}

/**
 * 插件市场（ADR 0050）：按 CLI 定义里的 npm 关键词浏览插件。没有搜索词时是热门的前 1000 个，
 * 本地按下载、发布时间排；装之前确认一次（插件在 CLI 进程里运行，权限和用户一样）。
 * 和面板功能重复的、看不到源码的只标出来，不隐藏
 */
export function CliGallery({
  def,
  installed,
  busy,
  onInstall,
}: {
  def: CliDefinition
  /** 已装的包（去掉版本号的来源，见 packageIdentity） */
  installed: Set<string>
  /** 正在跑的操作：装、删时整个列表的安装按钮先不让点 */
  busy: boolean
  onInstall: (source: string) => Promise<void>
}) {
  const spec = def.packages!
  const [input, setInput] = useState('')
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<GallerySort>('monthly')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<GalleryPage | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [confirm, setConfirm] = useState<GalleryItem | null>(null)
  // 打字停 400ms 再搜，免得每个字都问一次 npm
  useEffect(() => {
    const timer = setTimeout(() => {
      setQ(input.trim())
      setPage(1)
    }, 400)
    return () => clearTimeout(timer)
  }, [input])
  const load = (refresh = false) => {
    setLoading(true)
    cliMoreApi
      .cliGallery(def.id, { q, sort, page, refresh })
      .then((d) => {
        setData(d)
        setError('')
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false))
  }
  useEffect(() => {
    load()
    // load 每次渲染都是新的函数，只在条件变了时重新取
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [def.id, q, sort, page])
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t('搜索名称、描述、作者')}
            aria-label={t('搜索插件')}
            className="h-9 pl-8 text-body"
            spellCheck={false}
          />
        </div>
        <Select
          aria-label={t('排序')}
          value={sort}
          onChange={(e) => {
            setSort(e.target.value as GallerySort)
            setPage(1)
          }}
          options={GALLERY_SORTS.map((s) => ({ value: s, label: SORT_LABEL[s] }))}
          className="w-32"
        />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('刷新插件列表')}
          title={t('刷新插件列表')}
          onClick={() => load(true)}
          disabled={loading}
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        </Button>
      </div>
      <p className="flex flex-wrap items-center gap-x-2 text-footnote text-subtle">
        {data &&
          (q
            ? t('搜到 {n} 个', { n: data.total })
            : t('下载最多的 {n} 个 · 数据更新于 {time}', { n: data.total, time: timeAgo(data.at) }))}
        {spec.gallery?.pageUrl && (
          <a
            href={spec.gallery.pageUrl}
            target="_blank"
            rel="noreferrer"
            className="ml-auto inline-flex items-center gap-1 hover:text-accent-text hover:underline"
          >
            {t('官方插件页')}
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </p>
      {data?.stale && (
        <p className="text-footnote text-warning">
          {t('没能更新，显示的是上次的数据：{reason}', { reason: data.stale })}
        </p>
      )}
      {error ? (
        <p className="text-footnote text-warning">{error}</p>
      ) : !data ? (
        <p className="flex items-center gap-1.5 text-footnote text-subtle">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t('读取中…')}
        </p>
      ) : !data.items.length ? (
        <p className="text-footnote text-subtle">{t('没有找到插件')}</p>
      ) : (
        <Card
          as="ul"
          className={cn('flex flex-col divide-y rounded-lg', loading && 'opacity-60')}
          aria-label={t('插件市场')}
        >
          {data.items.map((x) => (
            <GalleryRow
              key={x.name}
              item={x}
              has={installed.has(packageIdentity(x.source))}
              overlap={overlapNote(x.name, spec.overlaps)}
              disabled={busy}
              onInstall={() => setConfirm(x)}
            />
          ))}
        </Card>
      )}
      {data && data.pages > 1 && (
        <div className="flex items-center justify-end gap-1 text-footnote text-subtle">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('上一页')}
            disabled={page <= 1 || loading}
            onClick={() => setPage(page - 1)}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          {t('第 {page} / {pages} 页', { page: data.page, pages: data.pages })}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('下一页')}
            disabled={page >= data.pages || loading}
            onClick={() => setPage(page + 1)}
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={t('安装 {name}', { name: confirm?.name ?? '' })}
        confirmText={t('安装')}
        description={t('插件在 {cli} 进程里运行，能做的事和你的账号一样。装之前看一下它的源码：{url}', {
          cli: def.name,
          url: confirm?.repoUrl || confirm?.npmUrl || '',
        })}
        onConfirm={async () => {
          const x = confirm
          setConfirm(null)
          if (x) await onInstall(x.source)
        }}
      />
    </div>
  )
}

function GalleryRow({
  item: x,
  has,
  overlap,
  disabled,
  onInstall,
}: {
  item: GalleryItem
  has: boolean
  overlap: string
  disabled: boolean
  onInstall: () => void
}) {
  const caution = cautionOf(x)
  return (
    <li className="flex items-start gap-2.5 px-3 py-2.5">
      <Package className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-text" />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <a
            href={x.npmUrl}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-body font-medium hover:text-accent-text hover:underline"
          >
            {x.name}
          </a>
          {x.publisher && <span className="text-caption text-subtle">{x.publisher}</span>}
          {x.types.map((ty) => (
            <Badge key={ty} className="text-caption">
              {ty}
            </Badge>
          ))}
        </p>
        {x.desc && <p className="mt-0.5 line-clamp-2 text-footnote leading-relaxed text-muted">{x.desc}</p>}
        <p className="mt-1 flex flex-wrap items-center gap-x-3 text-caption text-subtle">
          <span>{t('{n}/月', { n: formatTokens(x.monthly) })}</span>
          <span>{t('{n}/周', { n: formatTokens(x.weekly) })}</span>
          {x.dependents > 0 && <span>{t('被依赖 {n}', { n: x.dependents })}</span>}
          {x.date && <span>{t('{time}发布', { time: timeAgo(x.date) })}</span>}
          {x.repoUrl && (
            <a href={x.repoUrl} target="_blank" rel="noreferrer" className="hover:text-accent-text hover:underline">
              {t('源码')}
            </a>
          )}
        </p>
        {overlap && <p className="mt-1 text-footnote leading-relaxed text-subtle">{overlap}</p>}
        {caution && (
          <p className="mt-1 flex items-center gap-1 text-footnote text-warning">
            <TriangleAlert className="h-3 w-3 shrink-0" />
            {caution === 'insecure' ? t('npm 标记了安全问题，先看源码再决定') : t('没有源码仓库链接，看不到它做了什么')}
          </p>
        )}
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
          disabled={disabled}
          onClick={onInstall}
          aria-label={t('安装 {name}', { name: x.name })}
        >
          {t('安装')}
        </Button>
      )}
    </li>
  )
}
