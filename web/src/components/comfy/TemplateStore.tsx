import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { ArrowLeft, Check, Download, FileInput, LayoutGrid, Loader2, Network, RefreshCw, Search } from 'lucide-react'
import {
  TEMPLATE_CATEGORIES,
  TEMPLATE_READY,
  TEMPLATE_SORTS,
  TEMPLATE_SOURCES,
  emptyTemplateQuery,
  filterTemplates,
  templateCategoryTitle,
  type ComfyTemplateDetail,
  type ComfyTemplateMeta,
  type TemplateAsset,
  type TemplateQuery,
} from '@shared/comfy-templates'
import type { ComfyWorkflow, LocalStatus } from '@shared/local-image'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input, Select } from '@/components/ui/input'
import { ComfyGraphView } from '@/components/comfy/ComfyGraphView'

type Catalog = { templates: ComfyTemplateMeta[]; updatedAt: string; cached: boolean }
type Detail = ComfyTemplateDetail & { preview?: ComfyWorkflow['graph'] }

const gbText = (gb: number) => (gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(gb * 1024)} MB`)
const bytesText = (n: number) =>
  n <= 0 ? '' : n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`

const SOURCE_LABEL: Record<string, string> = { builtin: t('面板内置'), comfy: t('ComfyUI 官方') }

/**
 * ComfyUI 模板商店：左侧分类、顶部搜索和筛选、中间卡片列表，点开一个模板看节点图和依赖。
 * 卡片里的模板来自面板内置（本机模型）和 ComfyUI 官方模板索引；依赖可以一键下载到本机。
 */
export function TemplateStore({
  kind,
  status,
  onClose,
  onImport,
  onAdded,
}: {
  kind: 'game' | 'web'
  status?: LocalStatus
  onClose: () => void
  onImport: () => void
  onAdded: (wf: ComfyWorkflow) => void
}) {
  const [catalog, setCatalog] = useState<Catalog>()
  const [query, setQuery] = useState<TemplateQuery>(emptyTemplateQuery)
  const [selected, setSelected] = useState('')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')

  const load = async () => {
    setLoading(true)
    try {
      setCatalog(await api.comfyTemplates())
      setError('')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    void load()
  }, [])

  const categories = useMemo(() => {
    const list: { id: string; title: string }[] = TEMPLATE_CATEGORIES.map((c) => ({ id: c.id, title: c.title }))
    for (const m of catalog?.templates ?? [])
      if (!list.some((c) => c.id === m.category))
        list.push({ id: m.category, title: templateCategoryTitle(m.category) })
    return list
  }, [catalog])

  const list = useMemo(() => (catalog ? filterTemplates(catalog.templates, query) : []), [catalog, query])
  const count = (id: string) =>
    id === 'all' ? (catalog?.templates.length ?? 0) : (catalog?.templates.filter((m) => m.category === id).length ?? 0)

  const refresh = async () => {
    setRefreshing(true)
    try {
      setCatalog(await api.refreshComfyTemplates())
      toast.success(t('官方模板列表已更新'))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <div className="fixed inset-0 z-30 flex flex-col bg-bg text-fg">
      <header className="flex flex-wrap items-center gap-3 border-b px-4 py-3 md:px-6">
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-[0.9375rem] font-semibold">
            <LayoutGrid className="h-4 w-4 text-accent" />
            {t('模板商店')}
          </h1>
          <p className="mt-0.5 text-[0.78125rem] text-subtle">
            {t('从面板内置和 ComfyUI 官方模板里挑一个，看节点图和依赖；缺的模型可以直接下载。')}
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={onImport}>
          <FileInput className="h-3.5 w-3.5" />
          {t('导入 ComfyUI 工作流')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void refresh()} disabled={refreshing}>
          {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          {t('刷新官方模板')}
        </Button>
        <Button size="sm" variant="secondary" onClick={onClose}>
          <ArrowLeft className="h-3.5 w-3.5" />
          {t('返回工作流')}
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <aside className="flex max-h-[34vh] shrink-0 flex-col gap-0.5 overflow-y-auto border-b p-3 lg:max-h-none lg:w-[188px] lg:border-r lg:border-b-0">
          {categories.map((c) => (
            <button
              key={c.id}
              onClick={() => {
                setQuery({ ...query, category: c.id })
                setSelected('')
              }}
              aria-current={query.category === c.id}
              className={cn(
                'flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[0.8125rem]',
                query.category === c.id ? 'bg-sel font-medium text-fg' : 'text-muted hover:bg-sel/60',
              )}
            >
              <span className="min-w-0 flex-1 truncate">{c.title}</span>
              <span className="font-mono text-[0.6875rem] text-subtle">{count(c.id)}</span>
            </button>
          ))}
          <p className="mt-auto px-2 pt-3 text-[0.71875rem] leading-relaxed text-subtle">
            {catalog?.cached
              ? t('官方列表更新于 {time}', { time: new Date(catalog.updatedAt).toLocaleString() })
              : t('离线快照：联网后点「刷新官方模板」拿完整列表')}
          </p>
        </aside>

        <section className="flex min-h-0 flex-1 flex-col">
          <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
            <div className="relative min-w-[180px] flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
              <Input
                aria-label={t('搜索模板')}
                value={query.query}
                onChange={(e) => setQuery({ ...query, query: e.target.value })}
                placeholder={t('搜索模板、模型或标签')}
                className="pl-8"
              />
            </div>
            <Select
              aria-label={t('来源')}
              value={query.source}
              onChange={(e) => setQuery({ ...query, source: e.target.value as TemplateQuery['source'] })}
              options={TEMPLATE_SOURCES.map((x) => ({ value: x.id, label: x.title }))}
            />
            <Select
              aria-label={t('依赖状态')}
              value={query.ready}
              onChange={(e) => setQuery({ ...query, ready: e.target.value as TemplateQuery['ready'] })}
              options={TEMPLATE_READY.map((x) => ({ value: x.id, label: x.title }))}
            />
            <Select
              aria-label={t('排序')}
              value={query.sort}
              onChange={(e) => setQuery({ ...query, sort: e.target.value as TemplateQuery['sort'] })}
              options={TEMPLATE_SORTS.map((x) => ({ value: x.id, label: x.title }))}
            />
            <span className="text-[0.75rem] text-subtle">{t('{n} 个模板', { n: list.length })}</span>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {selected ? (
              <TemplateDetail
                name={selected}
                kind={kind}
                status={status}
                onBack={() => setSelected('')}
                onAdded={onAdded}
              />
            ) : loading ? (
              <div className="grid place-items-center py-20 text-subtle">
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
            ) : error ? (
              <div className="rounded-xl border border-danger/40 bg-danger/5 p-4 text-[0.8125rem] text-danger">
                <p>{error}</p>
                <Button size="sm" variant="ghost" className="mt-2" onClick={() => void load()}>
                  {t('重试')}
                </Button>
              </div>
            ) : !list.length ? (
              <p className="py-16 text-center text-[0.8125rem] text-subtle">{t('没有符合条件的模板')}</p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                {list.map((m) => (
                  <TemplateCard key={m.name} item={m} onOpen={() => setSelected(m.name)} />
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}

function TemplateCard({ item, onOpen }: { item: ComfyTemplateMeta; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className="group flex cursor-pointer flex-col gap-2 rounded-xl border bg-card p-3 text-left transition-colors hover:border-accent/60 hover:bg-sel/20"
    >
      <div className="flex items-start gap-2">
        <span className="line-clamp-2 min-w-0 flex-1 text-[0.84375rem] leading-snug font-medium">{item.title}</span>
        {item.available && (
          <span title={t('节点图已缓存，离线也能预览')} className="shrink-0 text-subtle">
            <Network className="h-3.5 w-3.5" />
          </span>
        )}
      </div>
      {item.description && (
        <p className="line-clamp-2 text-[0.75rem] leading-relaxed text-subtle">{item.description}</p>
      )}
      <div className="flex flex-wrap gap-1">
        {[SOURCE_LABEL[item.source] ?? item.source, ...item.tags.slice(0, 2)].map((tag) => (
          <span key={tag} className="rounded bg-sel px-1.5 py-px text-[0.6875rem] text-muted">
            {tag}
          </span>
        ))}
      </div>
      <div className="mt-auto flex items-center gap-2 text-[0.6875rem] text-subtle">
        <span className="min-w-0 flex-1 truncate" title={item.models.join('、')}>
          {item.models.slice(0, 2).join(' · ') || t('没有模型信息')}
        </span>
        {item.size > 0 && <span className="shrink-0 font-mono">{bytesText(item.size)}</span>}
        <span
          title={item.ready === true ? t('依赖已就绪') : item.ready === false ? t('缺模型') : t('打开后检查依赖')}
          className={cn(
            'h-1.5 w-1.5 shrink-0 rounded-full',
            item.ready === true ? 'bg-success' : item.ready === false ? 'bg-warning' : 'bg-line-strong',
          )}
        />
      </div>
    </button>
  )
}

function TemplateDetail({
  name,
  kind,
  status,
  onBack,
  onAdded,
}: {
  name: string
  kind: 'game' | 'web'
  status?: LocalStatus
  onBack: () => void
  onAdded: (wf: ComfyWorkflow) => void
}) {
  const [detail, setDetail] = useState<Detail>()
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(false)
  const job = status?.job
  const downloading = job?.status === 'running' && job.kind === 'download'
  const jobForThis = downloading && job?.model === `template:${detail?.template.title ?? ''}`
  const pct =
    jobForThis && job?.progress?.total ? Math.min(100, (job.progress.done / job.progress.total) * 100) : undefined

  useEffect(() => {
    let alive = true
    setDetail(undefined)
    setError('')
    api
      .comfyTemplate(name)
      .then((d) => alive && setDetail(d))
      .catch((e) => alive && setError((e as Error).message))
    return () => {
      alive = false
    }
    // 下载结束后重新取一次，看文件是不是都到齐了
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [name, job?.status])

  const graph = detail?.graph ?? detail?.preview
  const missing = detail?.assets.filter((a) => !a.have) ?? []
  const canDownload = missing.some((a) => !!a.url)
  const isImage = !detail?.template.output || detail.template.output === 'image'

  const download = async () => {
    if (!detail) return
    try {
      const r = await api.downloadComfyTemplate(detail.template.name)
      if (r.skipped) toast.warning(t('{n} 个文件没有下载地址，需要自己放到 ComfyUI/models', { n: r.skipped }))
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const add = async () => {
    if (!detail) return
    setAdding(true)
    try {
      const wf = await api.addComfyTemplate(detail.template.name, kind)
      toast.success(t('已添加到工作流'))
      onAdded(wf)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setAdding(false)
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" onClick={onBack}>
          <ArrowLeft className="h-3.5 w-3.5" />
          {t('返回列表')}
        </Button>
        <span className="flex-1" />
        {detail && (
          <>
            {missing.length > 0 && canDownload && (
              <Button size="sm" variant="secondary" onClick={() => void download()} disabled={!!jobForThis}>
                {jobForThis ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                {jobForThis ? t('下载中…') : t('下载缺失的模型（{n} 个）', { n: missing.length })}
              </Button>
            )}
            <Button size="sm" onClick={() => void add()} disabled={adding || !isImage}>
              {adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              {t('添加为工作流')}
            </Button>
          </>
        )}
      </div>

      {error && (
        <div className="rounded-xl border border-danger/40 bg-danger/5 p-4 text-[0.8125rem] text-danger">{error}</div>
      )}
      {!detail && !error && (
        <div className="grid place-items-center py-20 text-subtle">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      )}

      {detail && (
        <>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[1.0625rem] font-semibold">{detail.template.title}</h2>
              <span className="rounded bg-sel px-1.5 py-px text-[0.6875rem] text-muted">
                {SOURCE_LABEL[detail.template.source] ?? detail.template.source}
              </span>
              <span className="text-[0.75rem] text-subtle">{templateCategoryTitle(detail.template.category)}</span>
            </div>
            <p className="mt-1 max-w-[820px] text-[0.8125rem] leading-relaxed text-muted">
              {detail.template.description}
            </p>
          </div>

          {!isImage && (
            <p className="rounded-xl border border-warning/40 bg-warning/5 px-3 py-2 text-[0.78125rem] leading-relaxed text-warning">
              {t('这是视频或音频模板，UI 设计只处理图片，添加后也不能用于这里的出图。')}
            </p>
          )}
          {detail.template.needsInput && (
            <p className="rounded-xl border border-line-strong bg-field/40 px-3 py-2 text-[0.78125rem] leading-relaxed text-muted">
              {t('这个模板需要先喂一张图（图生图 / 编辑）。UI 设计目前只按文字出图，可以在 ComfyUI 网页里打开使用。')}
            </p>
          )}

          {jobForThis && pct !== undefined && (
            <div className="flex items-center gap-3">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-sel">
                <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
              </div>
              <span className="font-mono text-[0.75rem] text-subtle">
                {bytesText(job!.progress!.done)} / {bytesText(job!.progress!.total)}
              </span>
            </div>
          )}
          {jobForThis && job?.status === 'failed' && job.error && (
            <p className="rounded-xl border border-danger/40 bg-danger/5 px-3 py-2 text-[0.78125rem] leading-relaxed whitespace-pre-wrap text-danger">
              {job.error}
            </p>
          )}

          <section className="flex flex-col gap-1.5">
            <h3 className="text-[0.78125rem] font-medium text-muted">{t('节点图')}</h3>
            {graph ? (
              <ComfyGraphView graph={graph} readOnly onChange={() => {}} />
            ) : (
              <p className="rounded-xl border border-dashed px-3 py-6 text-center text-[0.78125rem] text-subtle">
                {t('这个模板没有可预览的节点图')}
              </p>
            )}
          </section>

          <section className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <h3 className="text-[0.78125rem] font-medium text-muted">{t('依赖的模型文件')}</h3>
              <span className="text-[0.71875rem] text-subtle">
                {detail.assets.length ? t('{n} 个文件', { n: detail.assets.length }) : t('没有识别到模型文件')}
              </span>
            </div>
            <div className="flex flex-col divide-y rounded-xl border">
              {detail.assets.length ? (
                detail.assets.map((a) => <AssetRow key={`${a.dir}/${a.file}`} asset={a} />)
              ) : (
                <p className="px-3 py-3 text-[0.75rem] text-subtle">
                  {t('模板说明里没有列出模型文件；在 ComfyUI 里打开时会提示缺少什么。')}
                </p>
              )}
            </div>
            {missing.length > 0 && !canDownload && (
              <p className="text-[0.75rem] leading-relaxed text-subtle">
                {t('缺失的文件没有下载地址，需要自己放到 ComfyUI 的 models 目录。')}
              </p>
            )}
          </section>
        </>
      )}
    </div>
  )
}

function AssetRow({ asset }: { asset: TemplateAsset }) {
  return (
    <div className="flex items-center gap-3 px-3 py-2">
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-[0.75rem]" title={asset.file}>
          {asset.file}
        </span>
        <span className="block text-[0.6875rem] text-subtle">
          {asset.dir}
          {asset.gb > 0 ? ` · ${gbText(asset.gb)}` : ''}
        </span>
      </span>
      {asset.have ? (
        <span className="inline-flex items-center gap-1 text-[0.75rem] text-success">
          <Check className="h-3 w-3" />
          {t('已下载')}
        </span>
      ) : (
        <span className={cn('text-[0.75rem]', asset.url ? 'text-warning' : 'text-subtle')}>
          {asset.url ? t('缺') : t('需要自己放')}
        </span>
      )}
    </div>
  )
}
