import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Check, Loader2, Plus, RefreshCw, ScanSearch } from 'lucide-react'
import { getCli } from '@shared/clis'
import { API_PROTOCOL_LABEL, sameApi, type ApiConfig, type DetectedApi } from '@shared/accounts'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { cliColor } from '@/lib/cli-style'
import { Button } from '@/components/ui/button'

/** 识别结果放在组件外面：API 页和各个 CLI 页共用一次读取，点「重新识别」才再读 */
let cache: Promise<DetectedApi[]> | undefined
const listeners = new Set<(l: DetectedApi[]) => void>()
function load(refresh = false) {
  if (!cache || refresh) {
    cache = api.detectedApis().catch((e: Error) => {
      cache = undefined
      throw e
    })
    void cache.then((l) => listeners.forEach((f) => f(l))).catch(() => {})
  }
  return cache
}

export function useDetectedApis() {
  const [list, setList] = useState<DetectedApi[]>()
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    listeners.add(setList)
    void load()
      .then(setList)
      .catch(() => setList([]))
    return () => void listeners.delete(setList)
  }, [])
  const refresh = async () => {
    setLoading(true)
    try {
      await load(true)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setLoading(false)
    }
  }
  return { list, loading, refresh }
}

/** 存进列表时用新的 id；名字和已有的重了加序号，不覆盖已有的那一项 */
export function toSaved(d: DetectedApi, apis: ApiConfig[]): ApiConfig {
  const names = new Set(apis.map((a) => a.name))
  let name = d.api.name
  for (let i = 2; names.has(name); i++) name = `${d.api.name} (${i})`
  return { ...d.api, id: crypto.randomUUID().slice(0, 8), name: name.slice(0, 60) }
}

const mask = (k: string) => (k.length > 10 ? `${k.slice(0, 5)}…${k.slice(-4)}` : k ? '••••' : '')

/**
 * 在本机 CLI 的配置里识别到的 API：一行一个，确认后才存进全局列表，已经在列表里的标出来，不会重复加、也不覆盖。
 * cli 给了时只列这个 CLI 的（CLI 页里用），onSaved 可以顺手选用刚存的那一项
 */
export function DetectedApis({
  apis,
  onAdd,
  cli,
  filter,
  onSaved,
  selected,
}: {
  apis: ApiConfig[]
  onAdd: (a: ApiConfig) => void
  cli?: string
  /** 只列能用的（例如协议对得上当前 CLI 的） */
  filter?: (d: DetectedApi) => boolean
  onSaved?: (a: ApiConfig) => void
  /** 现在选用的 API：已在列表里但没选用时给一个「选用」 */
  selected?: string
}) {
  const { list, loading, refresh } = useDetectedApis()
  const shown = (list ?? []).filter((d) => (!cli || d.cli === cli) && (!filter || filter(d)))
  // CLI 页里没识别到就不占地方；API 页里留一行说明和重新识别的按钮
  if (cli && !shown.length) return null
  const save = (d: DetectedApi) => {
    const a = toSaved(d, apis)
    onAdd(a)
    onSaved?.(a)
    toast.success(t('已存到 API 配置：{name}', { name: a.name }))
  }
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-dashed p-3.5">
      <div className="flex items-center gap-2">
        <ScanSearch className="h-4 w-4 shrink-0 text-accent" />
        <span className="min-w-0 flex-1 text-[0.8125rem] font-medium">
          {!list
            ? t('正在识别本机 CLI 配置的 API…')
            : shown.length
              ? t('在本机 CLI 的配置里识别到 {n} 个 API', { n: shown.length })
              : t('本机 CLI 的配置里没有识别到 API')}
        </span>
        <Button
          size="sm"
          variant="ghost"
          disabled={loading || !list}
          onClick={() => void refresh()}
          aria-label={t('重新识别')}
        >
          {loading || !list ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          {t('重新识别')}
        </Button>
      </div>
      {!!shown.length && (
        <p className="text-[0.75rem] leading-relaxed text-subtle">
          {t('读的是各个 CLI 自己的环境变量和配置文件。确认是你要用的再存进来，存好后其他 CLI 也能选用。')}
        </p>
      )}
      {shown.map((d) => {
        const have = apis.find((a) => sameApi(a, d.api))
        return (
          <div key={`${d.cli}:${d.api.id}`} className="flex items-center gap-3 rounded-lg bg-field/40 px-3 py-2.5">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: cliColor(d.cli) }} />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex min-w-0 items-center gap-2 text-[0.8125rem]">
                <span className="truncate font-medium">{d.api.name}</span>
                <span className="shrink-0 rounded bg-sel px-1.5 text-[0.6875rem] text-muted">
                  {API_PROTOCOL_LABEL[d.api.protocol]}
                </span>
              </span>
              <span className="truncate font-mono text-[0.71875rem] text-muted" title={d.api.baseUrl}>
                {[d.api.baseUrl || t('默认地址'), mask(d.api.apiKey) || t('没有密钥')].join(' · ')}
                {d.api.models.length ? ` · ${t('{n} 个模型', { n: d.api.models.length })}` : ''}
              </span>
              <span className="truncate text-[0.6875rem] text-subtle" title={d.source}>
                {t('来自 {cli}：{source}', { cli: getCli(d.cli)?.name ?? d.cli, source: d.source })}
              </span>
            </div>
            {have && onSaved && have.id !== selected ? (
              <Button size="sm" variant="secondary" className="shrink-0" onClick={() => onSaved(have)}>
                {t('选用')}
              </Button>
            ) : have ? (
              <span className="flex shrink-0 items-center gap-1 text-[0.75rem] text-subtle" title={have.name}>
                <Check className="h-3.5 w-3.5 text-success" />
                {t('已在列表中')}
              </span>
            ) : (
              <Button size="sm" variant="secondary" className="shrink-0" onClick={() => save(d)}>
                <Plus className="h-3.5 w-3.5" />
                {t('存到 API 配置')}
              </Button>
            )}
          </div>
        )
      })}
    </div>
  )
}
