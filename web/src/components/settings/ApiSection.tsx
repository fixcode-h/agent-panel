import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  ArrowRight,
  Check,
  CircleAlert,
  CircleCheck,
  Download,
  Eye,
  EyeOff,
  Loader2,
  Plus,
  PlugZap,
  Trash2,
  X,
} from 'lucide-react'
import { CLIS } from '@shared/clis'
import { API_PROTOCOLS, API_PROTOCOL_LABEL, apiProvider, type ApiConfig, type ApiProtocol } from '@shared/accounts'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input, Select } from '@/components/ui/input'
import { AiFixButton } from '@/components/ui/ai-fix'
import { Group } from './parts'
import { DetectedApis } from './DetectedApis'
import { t } from '@shared/i18n'
import { fmtTokens } from '@shared/model-limits'
import { matchModel } from '@shared/model-catalog'
import { useModelCatalog } from '@/lib/model-catalog'

/** 新建时可以从常用的开始 */
const PRESETS: { label: string; protocol: ApiProtocol; baseUrl: string }[] = [
  { label: 'Anthropic', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com' },
  { label: 'OpenAI', protocol: 'openai-responses', baseUrl: 'https://api.openai.com/v1' },
  { label: 'Gemini', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com' },
]

/** 哪些 CLI 能用这个协议的 API */
const usedBy = (p: ApiProtocol) => CLIS.filter((c) => c.auth?.api?.protocols.includes(p)).map((c) => c.name)

/**
 * 全局的 API：在这里配一次（接口地址、密钥、可用的模型），每个 CLI 都能在自己的页面里选用，
 * 协议对得上的才能选。模型可以从接口读取，也可以自己填
 */
export function ApiSection({ apis, onChange }: { apis: ApiConfig[]; onChange: (list: ApiConfig[]) => void }) {
  const patch = (id: string, p: Partial<ApiConfig>) => onChange(apis.map((a) => (a.id === id ? { ...a, ...p } : a)))
  const add = (preset?: (typeof PRESETS)[number]) =>
    onChange([
      ...apis,
      {
        id: crypto.randomUUID().slice(0, 8),
        name: preset?.label ?? t('自定义 API'),
        provider: '',
        protocol: preset?.protocol ?? 'openai-chat',
        baseUrl: preset?.baseUrl ?? '',
        apiKey: '',
        authHeader: 'x-api-key',
        models: [],
        modelMap: {},
      },
    ])
  return (
    <Group>
      <p className="pb-3 text-[0.8125rem] leading-relaxed text-subtle">
        {t(
          '在这里配好 API，再到各个 CLI 的页面把「登录方式」切到 API 选用。支持写配置的 CLI 保存后会立即写进它自己的配置，模型下拉优先从 CLI 读取。协议对得上的 CLI 才能选：Anthropic 给 Claude Code，OpenAI Responses 给 Codex，Gemini 给 Gemini CLI，Command Code 三种都能用。',
        )}
      </p>
      <div className="flex flex-col gap-4">
        <DetectedApis apis={apis} onAdd={(a) => onChange([...apis, a])} />
        {apis.map((a) => (
          <ApiCard
            key={a.id}
            a={a}
            onChange={(p) => patch(a.id, p)}
            onRemove={() => onChange(apis.filter((x) => x.id !== a.id))}
          />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 pt-4">
        <Button variant="secondary" size="sm" onClick={() => add()}>
          <Plus className="h-3.5 w-3.5" />
          {t('添加 API')}
        </Button>
        <span className="text-[0.75rem] text-subtle">{t('从常用的开始：')}</span>
        {PRESETS.map((p) => (
          <Button key={p.label} variant="ghost" size="sm" onClick={() => add(p)}>
            {p.label}
          </Button>
        ))}
      </div>
    </Group>
  )
}

function ApiCard({
  a,
  onChange,
  onRemove,
}: {
  a: ApiConfig
  onChange: (p: Partial<ApiConfig>) => void
  onRemove: () => void
}) {
  const [show, setShow] = useState(false)
  const [fetching, setFetching] = useState(false)
  const [testing, setTesting] = useState(false)
  const [probe, setProbe] = useState<{ ok: boolean; message: string }>()
  const [found, setFound] = useState<string[]>()
  const [filter, setFilter] = useState('')
  const [draft, setDraft] = useState('')
  /** 正在添加映射的模型；选好映射目标后写进 modelMap */
  const [mapFrom, setMapFrom] = useState('')
  const modelCatalog = useModelCatalog()
  const busy = fetching || testing
  const canProbe = !!a.baseUrl.trim() || a.protocol === 'gemini'

  // 连接相关的字段一改，上一次的测试结果就过期了
  useEffect(() => {
    setProbe(undefined)
  }, [a.protocol, a.baseUrl, a.apiKey, a.authHeader])

  const fail = (e: unknown) => {
    const message = (e as Error).message
    setProbe({ ok: false, message })
    toast.error(message)
  }
  const fetchModels = async () => {
    setFetching(true)
    try {
      const { models } = await api.apiModels(a)
      setFound(models)
      setFilter('')
      if (!a.models.length) onChange({ models: models.slice(0, 1) })
      setProbe({ ok: true, message: t('连接可用，读到 {n} 个模型', { n: models.length }) })
    } catch (e) {
      fail(e)
    } finally {
      setFetching(false)
    }
  }
  const testConnection = async () => {
    setTesting(true)
    try {
      const { models } = await api.apiModels(a)
      const message = t('连接可用，读到 {n} 个模型', { n: models.length })
      setProbe({ ok: true, message })
      toast.success(message)
    } catch (e) {
      fail(e)
    } finally {
      setTesting(false)
    }
  }
  const toggle = (m: string) => {
    const models = a.models.includes(m) ? a.models.filter((x) => x !== m) : [...a.models, m]
    // 移除模型后它的映射也没用了，一起清掉
    const modelMap = Object.fromEntries(Object.entries(a.modelMap).filter(([k]) => models.includes(k)))
    onChange({ models, modelMap })
  }
  const shown = useMemo(
    () => (found ?? []).filter((m) => m.toLowerCase().includes(filter.trim().toLowerCase())),
    [found, filter],
  )
  const addDraft = () => {
    const m = draft.trim()
    if (m && !a.models.includes(m)) onChange({ models: [...a.models, m] })
    setDraft('')
  }
  // 已有映射的模型，和还能添加映射的模型
  const mapped = a.models.filter((m) => a.modelMap[m])
  const unmapped = a.models.filter((m) => !a.modelMap[m])
  const setMap = (from: string, to: string) => {
    const modelMap = { ...a.modelMap }
    if (to) modelMap[from] = to
    else delete modelMap[from]
    onChange({ modelMap })
  }
  // 模型配置的选项：先按模型名推测厂商，只列这个厂商的模型；推测不出来时列全部
  const mapOptions = (from: string, current = '') => {
    const entries = modelCatalog?.entries ?? []
    const vendor = matchModel(from, { entries })?.entry.vendor
    const pool = vendor ? entries.filter((e) => e.vendor.toLowerCase() === vendor.toLowerCase()) : entries
    const list = pool.map((e) => ({
      value: e.id,
      label: `${e.id} · ${fmtTokens(e.context)} / ${fmtTokens(e.maxOutput)}`,
      group: e.vendor,
    }))
    // 目录变了、已选的值不在里面时也要能显示
    return current && !list.some((o) => o.value === current) ? [...list, { value: current, label: current }] : list
  }
  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-field/30 p-4">
      <div className="flex items-center gap-2">
        <Input
          value={a.name}
          maxLength={60}
          onChange={(e) => onChange({ name: e.target.value })}
          aria-label={t('API 名称')}
          className="h-9 min-w-0 flex-1 font-medium"
        />
        <Button variant="ghost" size="icon-sm" aria-label={t('删除 {name}', { name: a.name })} onClick={onRemove}>
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-[0.75rem] text-subtle">
          {t('协议')}
          <Select
            aria-label={t('协议')}
            value={a.protocol}
            onChange={(e) => onChange({ protocol: e.target.value as ApiProtocol })}
            options={API_PROTOCOLS.map((p) => ({ value: p, label: API_PROTOCOL_LABEL[p] }))}
          />
        </label>
        <label className="flex flex-col gap-1 text-[0.75rem] text-subtle">
          {t('接口地址')}
          <Input
            value={a.baseUrl}
            onChange={(e) => onChange({ baseUrl: e.target.value })}
            placeholder="https://api.example.com/v1"
            spellCheck={false}
            aria-label={t('接口地址')}
            className="h-9 font-mono text-[0.8125rem]"
          />
        </label>
        <label className="flex flex-col gap-1 text-[0.75rem] text-subtle sm:col-span-2">
          {t('提供方 ID')}
          <Input
            value={a.provider}
            onChange={(e) => onChange({ provider: e.target.value })}
            placeholder={t('留空时用 API 名称生成')}
            spellCheck={false}
            aria-label={t('提供方 ID')}
            className="h-9 font-mono text-[0.8125rem]"
          />
          <span className="text-[0.71875rem] text-subtle">
            {t('写进 CLI 配置的 provider 名；留空时使用 {provider}，需要 provider 前缀的 CLI 也用它拼模型 ID。', {
              provider: apiProvider(a),
            })}
          </span>
        </label>
        <label className="flex flex-col gap-1 text-[0.75rem] text-subtle sm:col-span-2">
          {t('密钥')}
          <span className="flex gap-1.5">
            <Input
              type={show ? 'text' : 'password'}
              value={a.apiKey}
              onChange={(e) => onChange({ apiKey: e.target.value })}
              placeholder="sk-…"
              spellCheck={false}
              autoComplete="off"
              aria-label={t('密钥')}
              className="h-9 min-w-0 flex-1 font-mono text-[0.8125rem]"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="h-9 w-9"
              aria-label={show ? t('隐藏密钥') : t('显示密钥')}
              onClick={() => setShow(!show)}
            >
              {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </Button>
          </span>
        </label>
        {a.protocol === 'anthropic' && (
          <label className="flex flex-col gap-1 text-[0.75rem] text-subtle">
            {t('密钥的发送方式')}
            <Select
              aria-label={t('密钥的发送方式')}
              value={a.authHeader}
              onChange={(e) => onChange({ authHeader: e.target.value as ApiConfig['authHeader'] })}
              options={[
                { value: 'x-api-key', label: 'x-api-key（ANTHROPIC_API_KEY）' },
                { value: 'bearer', label: 'Authorization: Bearer（ANTHROPIC_AUTH_TOKEN）' },
              ]}
            />
          </label>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[0.75rem] text-subtle">{t('可用的模型')}</span>
          <span className="flex-1" />
          <Button size="sm" variant="secondary" disabled={busy || !canProbe} onClick={testConnection}>
            {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlugZap className="h-3.5 w-3.5" />}
            {t('测试连接')}
          </Button>
          <Button size="sm" variant="secondary" disabled={busy || !canProbe} onClick={fetchModels}>
            {fetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            {t('从接口获取')}
          </Button>
        </div>
        {probe && (
          <div
            className={cn(
              'flex items-start gap-2 rounded-lg border px-2.5 py-2 text-[0.75rem]',
              probe.ok ? 'border-success/40 bg-success/5 text-success' : 'border-danger/40 bg-danger/5 text-danger',
            )}
          >
            {probe.ok ? (
              <CircleCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            ) : (
              <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            )}
            <span className="min-w-0 flex-1 break-words">{probe.message}</span>
            {!probe.ok && (
              <AiFixButton
                variant="ghost"
                className="h-6 shrink-0 px-1.5 text-xs"
                label={t('AI 修复')}
                issue={() => ({
                  title: t('API 连接失败：{name}', { name: a.name }),
                  error: probe.message,
                  context: [
                    `API 名称：${a.name}`,
                    `协议：${a.protocol}`,
                    `接口地址：${a.baseUrl || '（空）'}`,
                    `提供方 ID：${apiProvider(a)}`,
                    `密钥：${a.apiKey ? '已填写' : '未填写'}`,
                    `已选模型：${a.models.join(', ') || '（空）'}`,
                  ].join('\n'),
                  topic: 'api',
                })}
              />
            )}
          </div>
        )}
        <div className="flex flex-wrap gap-1.5">
          {a.models.map((m, i) => (
            <span
              key={m}
              className="inline-flex h-7 items-center gap-1 rounded-md bg-sel pr-1 pl-2 font-mono text-[0.75rem]"
              title={i === 0 ? t('第一个是默认模型') : undefined}
            >
              {m}
              {i === 0 && <span className="rounded bg-accent-soft px-1 text-[0.625rem] text-accent">{t('默认')}</span>}
              <button
                type="button"
                aria-label={t('移除 {name}', { name: m })}
                onClick={() => toggle(m)}
                className="grid h-5 w-5 cursor-pointer place-items-center rounded text-subtle hover:bg-card hover:text-fg"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          <form
            className="inline-flex"
            onSubmit={(e) => {
              e.preventDefault()
              addDraft()
            }}
          >
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={addDraft}
              placeholder={t('自己输入模型名，回车添加')}
              aria-label={t('添加模型')}
              spellCheck={false}
              className="h-7 w-52 font-mono text-[0.75rem]"
            />
          </form>
        </div>
        {found && (
          <div className="flex flex-col gap-2 rounded-lg border bg-card p-2.5">
            <div className="flex items-center gap-2">
              <Input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder={t('在 {n} 个模型里搜索', { n: found.length })}
                aria-label={t('搜索模型')}
                className="h-8 min-w-0 flex-1 text-[0.78125rem]"
              />
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onChange({ models: [...new Set([...a.models, ...shown])] })}
              >
                {t('添加全部')}
              </Button>
              <Button size="icon-sm" variant="ghost" aria-label={t('收起')} onClick={() => setFound(undefined)}>
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
            <div className="flex max-h-44 flex-wrap gap-1.5 overflow-y-auto">
              {shown.map((m) => {
                const on = a.models.includes(m)
                return (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggle(m)}
                    className={cn(
                      'inline-flex h-7 cursor-pointer items-center gap-1 rounded-md border px-2 font-mono text-[0.75rem] transition-colors',
                      on ? 'border-accent/50 bg-accent-soft text-accent' : 'hover:bg-sel',
                    )}
                  >
                    {on && <Check className="h-3 w-3" strokeWidth={3} />}
                    {m}
                  </button>
                )
              })}
              {!shown.length && <span className="text-[0.75rem] text-subtle">{t('没有匹配的模型')}</span>}
            </div>
          </div>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[0.75rem] text-subtle">{t('模型映射')}</span>
          <span className="flex-1" />
          <Button
            size="sm"
            variant="ghost"
            disabled={!unmapped.length || !!mapFrom}
            onClick={() => setMapFrom(unmapped[0] ?? '')}
          >
            <Plus className="h-3.5 w-3.5" />
            {t('添加映射')}
          </Button>
        </div>
        <p className="text-[0.71875rem] leading-relaxed text-subtle">
          {t('自动识别不准时，指定按哪个模型的配置读取上下文和最大输出；发给 CLI 的仍然是这里的模型名。')}
        </p>
        {mapped.map((m) => (
          <div key={m} className="flex flex-wrap items-center gap-2">
            <span className="w-52 truncate font-mono text-[0.75rem]" title={m}>
              {m}
            </span>
            <ArrowRight className="h-3.5 w-3.5 shrink-0 text-subtle" />
            <Select
              aria-label={t('{model} 的模型映射', { model: m })}
              className="h-8 w-64 font-mono text-[0.78125rem]"
              value={a.modelMap[m]}
              options={mapOptions(m, a.modelMap[m])}
              onChange={(e) => setMap(m, e.target.value)}
            />
            <Button size="icon-sm" variant="ghost" aria-label={t('移除映射')} onClick={() => setMap(m, '')}>
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
        {mapFrom && (
          <div className="flex flex-wrap items-center gap-2">
            <Select
              aria-label={t('添加映射的模型')}
              className="h-8 w-52 font-mono text-[0.78125rem]"
              value={mapFrom}
              options={unmapped.map((m) => ({ value: m, label: m }))}
              onChange={(e) => setMapFrom(e.target.value)}
            />
            <ArrowRight className="h-3.5 w-3.5 shrink-0 text-subtle" />
            <Select
              aria-label={t('按哪个模型的配置')}
              className="h-8 w-64 font-mono text-[0.78125rem]"
              value=""
              placeholder={t('选择模型配置')}
              options={mapOptions(mapFrom)}
              onChange={(e) => {
                setMap(mapFrom, e.target.value)
                setMapFrom('')
              }}
            />
            <Button size="icon-sm" variant="ghost" aria-label={t('取消添加映射')} onClick={() => setMapFrom('')}>
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </div>
      <p className="text-[0.75rem] text-subtle">
        {t('可以用在：{clis}', { clis: usedBy(a.protocol).join('、') || '—' })}
      </p>
    </div>
  )
}
