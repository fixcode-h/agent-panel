import { useMemo, useState } from 'react'
import { ExternalLink, Globe, Loader2, Search, Square, Trash2 } from 'lucide-react'
import { t } from '@shared/i18n'
import type { ModelCatalogEntry, ModelCatalogInfo } from '@shared/models/catalog'
import { catalogKey, type ModelDiscoverJob } from '@shared/models/discover'
import { fmtTokens } from '@shared/models/limits'
import { addCatalogModels, discoverModels, removeCatalogModel, stopDiscoverModels } from '@/lib/model-catalog'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'

/**
 * 设置 → 默认 Agent → 模型目录：列出内置 + 补充目录里的全部模型（按厂商分组，可搜索），
 * 和「联网检查新模型」：用户点按钮才让 Agent 联网查各厂商官方文档，查到的新模型让用户勾选后再写进补充目录。
 */

/** 厂商的显示名；目录里出现了没登记的厂商时照原样显示 id */
const vendorName = (v: string) =>
  ({
    anthropic: 'Anthropic',
    openai: 'OpenAI',
    google: 'Google',
    deepseek: 'DeepSeek',
    moonshot: t('月之暗面 Kimi'),
    zhipu: t('智谱 GLM'),
    alibaba: t('通义千问'),
    tencent: t('腾讯混元'),
    xiaomi: t('小米 MiMo'),
    bytedance: t('豆包'),
    baidu: t('文心'),
    minimax: 'MiniMax',
    xai: 'xAI',
    mistral: 'Mistral',
  })[v] ?? v

const TIER_LABEL = { high: () => t('旗舰'), medium: () => t('日常'), low: () => t('快速') }

/** 一个模型的一行：名字、id、上下文 / 最大输出、档位；补充记录标出来，可以删 */
function ModelLine({
  m,
  user,
  onRemove,
  check,
}: {
  m: ModelCatalogEntry
  user?: boolean
  onRemove?: () => void
  /** 候选列表里的勾选框 */
  check?: { checked: boolean; onChange: (v: boolean) => void }
}) {
  return (
    <li className="flex items-center gap-2.5 px-3 py-2">
      {check && <Checkbox checked={check.checked} onChange={check.onChange} ariaLabel={m.label || m.id} />}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-body">{m.label || m.id}</span>
          {user && <Badge tone="accent">{t('补充')}</Badge>}
          {m.source && (
            <a
              href={m.source}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 text-subtle hover:text-accent-text"
              title={t('信息来源：{url}', { url: m.source })}
              aria-label={t('{model} 的信息来源', { model: m.id })}
            >
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </span>
        <span className="truncate font-mono text-caption text-subtle">{m.id}</span>
      </div>
      <span
        className="shrink-0 text-footnote text-subtle tabular-nums"
        title={t('上下文 {context} · 最大输出 {output}', {
          context: fmtTokens(m.context),
          output: fmtTokens(m.maxOutput),
        })}
      >
        {fmtTokens(m.context)} / {fmtTokens(m.maxOutput)}
      </span>
      <Badge className="w-10 shrink-0 justify-center">{TIER_LABEL[m.tier]()}</Badge>
      {onRemove && (
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={onRemove}
          aria-label={t('删掉补充的 {model}', { model: m.id })}
          title={t('删掉这条补充记录（同名的内置记录重新生效）')}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      )}
    </li>
  )
}

/** 全部模型：按厂商分组，搜索框按名字、id、厂商筛 */
export function ModelCatalogBrowser({ catalog }: { catalog: ModelCatalogInfo | undefined }) {
  const [q, setQ] = useState('')
  const user = useMemo(() => new Set(catalog?.userKeys ?? []), [catalog])
  const groups = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const out = new Map<string, ModelCatalogEntry[]>()
    for (const m of catalog?.entries ?? []) {
      const text = `${m.vendor} ${vendorName(m.vendor)} ${m.id} ${m.label} ${m.aliases.join(' ')}`.toLowerCase()
      if (!words.every((w) => text.includes(w))) continue
      out.set(m.vendor, [...(out.get(m.vendor) ?? []), m])
    }
    return [...out]
  }, [catalog, q])
  const remove = async (m: ModelCatalogEntry) => {
    try {
      await removeCatalogModel(m.vendor, m.id)
      toast.success(t('已删掉补充的 {model}', { model: m.id }))
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  if (!catalog) return <p className="text-footnote text-subtle">{t('读取中…')}</p>
  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('按名字或厂商筛选')}
          aria-label={t('筛选模型')}
          className="pl-8"
          spellCheck={false}
        />
      </div>
      {!groups.length ? (
        <p className="text-footnote text-subtle">{t('没有匹配的模型')}</p>
      ) : (
        <Card className="max-h-96 overflow-y-auto rounded-lg">
          {groups.map(([vendor, list]) => (
            <section key={vendor} aria-label={vendorName(vendor)}>
              <h4 className="sticky top-0 z-[1] bg-(--c-card-bg) px-3 pt-2.5 pb-1 text-caption font-semibold text-subtle">
                {vendorName(vendor)} · {list.length}
              </h4>
              <ul className="flex flex-col divide-y">
                {list.map((m) => {
                  const mine = user.has(catalogKey(m))
                  return (
                    <ModelLine
                      key={catalogKey(m)}
                      m={m}
                      user={mine}
                      onRemove={mine ? () => void remove(m) : undefined}
                    />
                  )
                })}
              </ul>
            </section>
          ))}
        </Card>
      )}
    </div>
  )
}

/** 联网检查新模型：点了才查；查到的列成候选，默认全勾，用户确认后写进补充目录 */
export function ModelDiscover({ demo }: { demo: boolean }) {
  const [job, setJob] = useState<ModelDiscoverJob | null>(null)
  const [running, setRunning] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [adding, setAdding] = useState(false)
  const start = async () => {
    setRunning(true)
    setJob(null)
    try {
      const done = await discoverModels(setJob)
      setJob(done)
      setPicked(new Set(done.candidates.map(catalogKey)))
      if (done.status === 'failed') toast.error(done.error || t('检查失败'))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setRunning(false)
    }
  }
  const add = async () => {
    const entries = (job?.candidates ?? []).filter((m) => picked.has(catalogKey(m)))
    if (!entries.length) return
    setAdding(true)
    try {
      await addCatalogModels(entries)
      toast.success(t('已加入 {n} 个模型', { n: entries.length }))
      // 加过的从候选里拿掉，没勾的留着，用户还能再加
      setJob((j) => j && { ...j, candidates: j.candidates.filter((m) => !picked.has(catalogKey(m))) })
      setPicked(new Set())
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setAdding(false)
    }
  }
  const candidates = job?.status === 'done' ? job.candidates : []
  // 进度只显示最后几行：Agent 的输出可能很长
  const tail = running && job?.text ? job.text.trim().split('\n').slice(-3).join('\n') : ''
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" disabled={running || demo} onClick={() => void start()}>
          {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Globe className="h-3.5 w-3.5" />}
          {running ? t('正在检查…') : t('联网检查')}
        </Button>
        {running && job && (
          <Button variant="ghost" size="sm" onClick={() => void stopDiscoverModels(job.id).catch(() => {})}>
            <Square className="h-3 w-3" />
            {t('停止')}
          </Button>
        )}
        {demo && <span className="text-footnote text-subtle">{t('在线演示不能联网检查')}</span>}
      </div>
      {tail && <p className="line-clamp-3 text-footnote whitespace-pre-wrap text-subtle">{tail}</p>}
      {job?.status === 'done' && (
        <>
          <p className="text-footnote text-subtle">
            {candidates.length
              ? t('查到 {n} 个目录里没有的模型，勾选后加入。数字是 Agent 从官方文档查的，加入前可以点链接核对。', {
                  n: candidates.length,
                })
              : t('没有查到目录里没有的模型。')}
            {job.known > 0 && ` ${t('另有 {n} 个已在目录里。', { n: job.known })}`}
          </p>
          {job.text && (
            <details className="text-footnote text-subtle">
              <summary className="cursor-pointer select-none hover:text-fg">{t('Agent 的说明')}</summary>
              <p className="mt-1 whitespace-pre-wrap">{job.text}</p>
            </details>
          )}
          {candidates.length > 0 && (
            <>
              <Card as="ul" className="flex max-h-80 flex-col divide-y overflow-y-auto rounded-lg">
                {candidates.map((m) => {
                  const key = catalogKey(m)
                  return (
                    <ModelLine
                      key={key}
                      m={{ ...m, label: `${vendorName(m.vendor)} · ${m.label || m.id}` }}
                      check={{
                        checked: picked.has(key),
                        onChange: (v) =>
                          setPicked((s) => {
                            const next = new Set(s)
                            if (v) next.add(key)
                            else next.delete(key)
                            return next
                          }),
                      }}
                    />
                  )
                })}
              </Card>
              <div className={cn('flex items-center gap-2')}>
                <Button size="sm" disabled={!picked.size || adding} onClick={() => void add()}>
                  {adding && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {t('加入选中的 {n} 个', { n: picked.size })}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setPicked(picked.size === candidates.length ? new Set() : new Set(candidates.map(catalogKey)))
                  }
                >
                  {picked.size === candidates.length ? t('全不选') : t('全选')}
                </Button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
