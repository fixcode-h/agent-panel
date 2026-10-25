import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  Check,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Download,
  Eye,
  EyeOff,
  Loader2,
  Plus,
  PlugZap,
  RefreshCw,
  Trash2,
  Unlink,
  Wallet,
  X,
} from 'lucide-react'
import { CLIS } from '@shared/clis'
import {
  API_PROTOCOLS,
  API_PROTOCOL_LABEL,
  apiProvider,
  modelsForProtocol,
  type ApiConfig,
  type ApiProtocol,
} from '@shared/accounts'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ComboInput, Input, Select } from '@/components/ui/input'
import { AiFixButton } from '@/components/ui/ai-fix'
import { Group } from './parts'
import { DetectedApis } from './DetectedApis'
import { t } from '@shared/i18n'
import { API_VENDORS, apiBalanceUrl, apiBaseUrl, findVendor, isVendorUrl, vendorEndpoint } from '@shared/api-vendors'
import type { ApiBalance } from '@shared/api-balance'
import { fmtTokens } from '@shared/model-limits'
import { matchModel } from '@shared/model-catalog'
import { useModelCatalog } from '@/lib/model-catalog'
import { loadCliModels } from '@/lib/cli-models'
import { probeTarget } from '@/lib/api-probe'

/** 新建时可以从常用的开始：协议定下来，接口地址用厂家默认的（留空，输入框里当灰字提示） */
const PRESETS: { label: string; protocol: ApiProtocol }[] = [
  { label: 'Anthropic', protocol: 'anthropic' },
  { label: 'OpenAI', protocol: 'openai-responses' },
  { label: 'Gemini', protocol: 'gemini' },
]

/** API 卡片展开还是收起，按 API 记在本地 */
const FOLD = 'api-open:'

/** 哪些 CLI 能用这个协议的 API */
const usedBy = (p: ApiProtocol) => CLIS.filter((c) => c.auth?.api?.protocols.includes(p)).map((c) => c.name)

/**
 * 全局的 API：在这里配一次（接口地址、密钥、可用的模型），每个 CLI 都能在自己的页面里选用，
 * 协议对得上的才能选。模型可以从接口读取，也可以自己填
 */
export function ApiSection({ apis, onChange }: { apis: ApiConfig[]; onChange: (list: ApiConfig[]) => void }) {
  const patch = (id: string, p: Partial<ApiConfig>) => onChange(apis.map((a) => (a.id === id ? { ...a, ...p } : a)))
  // 这次打开设置后新加的 API 展开显示，接着就要填；之前配好的默认收起
  const [fresh, setFresh] = useState<string[]>([])
  const append = (a: ApiConfig) => {
    setFresh((f) => [...f, a.id])
    onChange([...apis, a])
  }
  const add = (preset?: (typeof PRESETS)[number]) =>
    append({
      id: crypto.randomUUID().slice(0, 8),
      name: preset?.label ?? t('自定义 API'),
      provider: '',
      protocol: preset?.protocol ?? 'openai-chat',
      baseUrl: '',
      apiKey: '',
      authHeader: 'x-api-key',
      models: [],
      modelMap: {},
      modelEfforts: {},
      maxConcurrent: 0,
    })
  return (
    <Group>
      <p className="pb-3 text-[0.8125rem] leading-relaxed text-subtle">
        {t(
          '在这里配好 API，再到各个 Agent 的页面把「登录方式」切到 API 选用。改完 API 点「一键更新」才会写进正在用它的 Agent 配置文件；模型下拉优先从 Agent 读取。协议对得上的 Agent 才能选：Anthropic 给 Claude Code，OpenAI Responses 给 Codex，Gemini 给 Gemini CLI，Command Code 三种都能用。',
        )}
      </p>
      <div className="flex flex-col gap-4">
        <DetectedApis apis={apis} onAdd={append} />
        {apis.map((a) => (
          <ApiCard
            key={a.id}
            a={a}
            fresh={fresh.includes(a.id)}
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
  fresh,
  onChange,
  onRemove,
}: {
  a: ApiConfig
  /** 刚加进来的：默认展开 */
  fresh?: boolean
  onChange: (p: Partial<ApiConfig>) => void
  onRemove: () => void
}) {
  const [show, setShow] = useState(false)
  const [fetching, setFetching] = useState(false)
  const [testing, setTesting] = useState(false)
  const [probe, setProbe] = useState<{ ok: boolean; message: string }>()
  /** 「测试连接」用哪个模型测；空表示还没选，用模型列表的第一个 */
  const [probeModel, setProbeModel] = useState('')
  const [found, setFound] = useState<string[]>()
  const [filter, setFilter] = useState('')
  const [draft, setDraft] = useState('')
  /** 名称先存草稿，点「保存」才写进设置（改名称会改变写进 CLI 配置的 provider） */
  const [name, setName] = useState(a.name)
  const [updating, setUpdating] = useState(false)
  // 每个 API 都能收起；配好的（有地址或密钥、有模型）默认收起，刚加的和没配完的默认展开。手动展开收起过就按记下的来
  const [open, setOpenState] = useState(() => {
    try {
      const saved = localStorage.getItem(FOLD + a.id)
      if (saved) return saved === 'open'
    } catch {}
    return !!fresh || !a.models.length || !(a.apiKey || a.baseUrl)
  })
  const setOpen = (v: boolean) => {
    setOpenState(v)
    try {
      localStorage.setItem(FOLD + a.id, v ? 'open' : 'closed')
    } catch {}
  }
  const modelCatalog = useModelCatalog()
  const busy = fetching || testing
  /** 绑定的内置厂家：名称就是绑定（没有单独的绑定字段），有厂家时名称不给直接改 */
  const vendor = findVendor(a.name)
  /** 厂家按当前协议给的地址：只当接口地址输入框的提示，留空时请求就用它 */
  const vendorUrl = vendor?.urls[a.protocol] ?? ''
  const canProbe = !!apiBaseUrl(a) || a.protocol === 'gemini'

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
      // 从接口读到的模型也按协议过滤：带别的协议后缀的不显示，不带后缀的通用模型保留
      const list = modelsForProtocol(models, a.protocol)
      setFound(list)
      setFilter('')
      if (!a.models.length) onChange({ models: list.slice(0, 1) })
      setProbe({ ok: true, message: t('连接可用，读到 {n} 个模型', { n: list.length }) })
    } catch (e) {
      fail(e)
    } finally {
      setFetching(false)
    }
  }
  const testConnection = async () => {
    setTesting(true)
    // 选了模型就真的用这个模型发一次请求；一个模型都没有时退回只验证能列出模型
    const target = probeTarget(modelsForProtocol(a.models, a.protocol), probeModel)
    try {
      if (target) {
        await api.probeApiModel({ ...a, model: target })
        const message = t('模型 {model} 可用', { model: target })
        setProbe({ ok: true, message })
        toast.success(message)
        return
      }
      const { models } = await api.apiModels(a)
      const list = modelsForProtocol(models, a.protocol)
      const message = t('连接可用，读到 {n} 个模型（还没有选中的模型，这次只验证了连接）', { n: list.length })
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
  /** 可选的模型：只列当前协议能用的，第一个是默认模型 */
  const probeOptions = useMemo(() => {
    const list = modelsForProtocol(a.models, a.protocol)
    return list.length
      ? list.map((m) => ({ value: m, label: m }))
      : [{ value: '', label: t('先点「从接口获取」或手动填写模型') }]
  }, [a.models, a.protocol])
  /** 换模型后上一次的测试结果就过期了，否则会把「模型 A 可用」误读成 B 也通过了 */
  const pickProbeModel = (v: string) => {
    setProbeModel(v)
    setProbe(undefined)
  }
  const shown = useMemo(
    () => (found ?? []).filter((m) => m.toLowerCase().includes(filter.trim().toLowerCase())),
    [found, filter],
  )
  const addDraft = () => {
    const m = draft.trim()
    if (!m) return
    // 带别的协议后缀的模型不给加，免得加了又因为协议不匹配被隐藏
    if (!modelsForProtocol([m], a.protocol).length) {
      toast.error(t('模型名和当前协议不匹配'))
      return
    }
    if (!a.models.includes(m)) onChange({ models: [...a.models, m] })
    setDraft('')
  }
  const setMap = (m: string, to: string) => {
    const modelMap = { ...a.modelMap }
    if (to) modelMap[m] = to
    else delete modelMap[m]
    onChange({ modelMap })
  }
  const setEffort = (m: string, v: string) => {
    const modelEfforts = { ...a.modelEfforts }
    if (v) modelEfforts[m] = v
    else delete modelEfforts[m]
    onChange({ modelEfforts })
  }
  /** 模型目录里自动识别到的配置：用户没改映射时用它 */
  const autoModel = (m: string) =>
    matchModel(m, { entries: modelCatalog?.entries ?? [], protocol: a.protocol })?.entry.id ?? ''
  // 映射选项：先按模型名推测厂商，只列这个厂商的模型；第一项是自动识别
  const mapOptions = (m: string, current = '') => {
    const entries = modelCatalog?.entries ?? []
    const auto = autoModel(m)
    const vendor = matchModel(m, { entries })?.entry.vendor
    const pool = vendor ? entries.filter((e) => e.vendor.toLowerCase() === vendor.toLowerCase()) : entries
    const list = [
      { value: '', label: auto ? t('自动识别（{model}）', { model: auto }) : t('自动识别'), group: '' },
      ...pool.map((e) => ({
        value: e.id,
        label: `${e.id} · ${fmtTokens(e.context)} / ${fmtTokens(e.maxOutput)}`,
        group: e.vendor,
      })),
    ]
    // 目录变了、已选的值不在里面时也要能显示
    return current && !list.some((o) => o.value === current) ? [...list, { value: current, label: current }] : list
  }
  /** 默认思考强度：映射到的模型优先，没设映射时用自动识别到的模型 */
  const effortOptions = (m: string) => {
    const efforts =
      matchModel(a.modelMap[m] || m, { entries: modelCatalog?.entries ?? [], protocol: a.protocol })?.entry.efforts ??
      []
    const current = a.modelEfforts[m] ?? ''
    // 目录变了、已选的值不在里面时也要能显示
    const list = current && !efforts.includes(current) ? [...efforts, current] : efforts
    return [
      { value: '', label: t('模型默认') },
      ...list.map((e) => ({
        value: e,
        label: e,
      })),
    ]
  }
  /**
   * 从下拉里选了厂家：名称和协议一起换好，provider 没自己填过时也换成厂家的。
   * 厂家地址只当输入框的提示，不写进真实值；用户自己写过的地址不动，
   * 旧版本自动写进去的厂家地址清掉，免得换厂家后还被它顶着
   */
  const pickVendor = (v: string) => {
    const picked = findVendor(v)
    if (!picked) return
    const old = findVendor(a.name)
    setName(picked.name)
    onChange({
      name: picked.name,
      protocol: vendorEndpoint(picked, a.protocol).protocol,
      ...(isVendorUrl(a.baseUrl) ? { baseUrl: '' } : {}),
      ...(!a.provider.trim() || a.provider === old?.provider ? { provider: picked.provider } : {}),
    })
  }
  /** 换协议：地址留空时提示跟着厂家的新地址；旧版本写进真实值的厂家地址一并清掉 */
  const setProtocol = (protocol: ApiProtocol) => {
    onChange({ protocol, ...(isVendorUrl(a.baseUrl) ? { baseUrl: '' } : {}) })
  }
  /** 清空厂家绑定：名称回到自定义，接口地址、密钥和模型都不动（整卡删除在展开后的底部） */
  const clearVendor = () => {
    const plain = t('自定义 API')
    setName(plain)
    onChange({ name: plain })
    toast.success(t('已改成自定义 API，名称可以自己改了'))
  }
  const saveName = () => {
    const v = name.trim()
    if (!v) return
    onChange({ name: v })
    setName(v)
    toast.success(t('已保存'))
  }
  /** 一键更新：把这个 API 的当前设置写进正在用它的 CLI 配置文件 */
  const applyApi = async () => {
    setUpdating(true)
    try {
      const { clis } = await api.applyApi(a.id)
      if (!clis.length) toast.info(t('还没有 Agent 在用这个 API'))
      else {
        toast.success(t('已更新 {n} 个 Agent 的配置文件', { n: clis.length }))
        // 写进配置文件后模型列表可能变了：重新读一次
        void Promise.all(clis.map((id) => loadCliModels(id, true).catch(() => {})))
      }
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setUpdating(false)
    }
  }
  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-field/30 p-4">
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-expanded={open}
          aria-label={open ? t('收起') : t('展开')}
          title={open ? t('收起') : t('展开')}
          onClick={() => setOpen(!open)}
          className="-ml-1.5 shrink-0"
        >
          <ChevronRight className={cn('h-4 w-4 transition-transform', open && 'rotate-90')} />
        </Button>
        {!open ? (
          // 收起时只留一行：名字和协议、模型数，点哪里都能展开
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="flex min-w-0 flex-1 items-baseline gap-2 truncate rounded-md py-1 text-left"
          >
            <span className="truncate font-medium">{a.name}</span>
            <span className="truncate text-[0.75rem] text-subtle">
              {[
                API_PROTOCOL_LABEL[a.protocol],
                a.models.length ? t('{n} 个模型', { n: a.models.length }) : t('还没有模型'),
              ].join(' · ')}
            </span>
          </button>
        ) : vendor ? (
          // 绑定了内置厂家：名称不给直接改（改了就相当于换厂家），要改就先用右上角的按钮回到自定义 API
          <div className="flex h-9 min-w-0 flex-1 items-center gap-2">
            <span className="truncate font-medium">{a.name}</span>
            <span className="shrink-0 rounded bg-accent-soft px-1.5 py-0.5 text-[0.625rem] text-accent">
              {t('内置厂家')}
            </span>
            <span className="truncate text-[0.71875rem] text-subtle">
              {t('名称固定，点右上角的按钮改成自定义 API')}
            </span>
          </div>
        ) : (
          <div className="min-w-0 flex-1">
            <ComboInput
              value={name}
              maxLength={60}
              onChange={setName}
              onPick={pickVendor}
              onKeyDown={(e) => e.key === 'Enter' && saveName()}
              suggestions={API_VENDORS.map((v) => ({ value: v.name, label: Object.values(v.urls)[0] }))}
              placeholder={t('选择厂家，或输入名称')}
              aria-label={t('API 名称')}
              className="h-9 font-medium"
            />
          </div>
        )}
        {open && !vendor && (
          <Button size="sm" variant="secondary" disabled={!name.trim() || name.trim() === a.name} onClick={saveName}>
            {t('保存')}
          </Button>
        )}
        {vendor ? (
          // 厂家绑定着时这里是「清空绑定」，整卡删除在展开后的底部：两个动作分开，别一按删掉配置和模型
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('清空厂家绑定，改成自定义 API')}
            title={t('清空厂家绑定，改成自定义 API（接口地址、密钥和模型都不动）')}
            onClick={clearVendor}
          >
            <Unlink className="h-4 w-4" />
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('删除 {name}', { name: a.name })}
            title={t('删除这个 API')}
            onClick={onRemove}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </div>
      {open && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-[0.75rem] text-subtle">
              {t('协议')}
              <Select
                aria-label={t('协议')}
                value={a.protocol}
                onChange={(e) => setProtocol(e.target.value as ApiProtocol)}
                options={API_PROTOCOLS.map((p) => ({ value: p, label: API_PROTOCOL_LABEL[p] }))}
              />
            </label>
            <label className="flex flex-col gap-1 text-[0.75rem] text-subtle">
              {t('接口地址')}
              <Input
                value={a.baseUrl}
                onChange={(e) => onChange({ baseUrl: e.target.value })}
                placeholder={vendorUrl || 'https://api.example.com/v1'}
                spellCheck={false}
                aria-label={t('接口地址')}
                className="h-9 font-mono text-[0.8125rem]"
              />
              {vendorUrl && !a.baseUrl.trim() && (
                <span className="text-[0.71875rem] text-subtle">
                  {t('留空时用 {vendor} 的默认地址：{url}', { vendor: a.name, url: vendorUrl })}
                </span>
              )}
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
                {t(
                  '写进 Agent 配置的 provider 名；留空时使用 {provider}，需要 provider 前缀的 Agent 也用它拼模型 ID。',
                  {
                    provider: apiProvider(a),
                  },
                )}
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
            <label className="flex flex-col gap-1 text-[0.75rem] text-subtle sm:col-span-2">
              {t('并发上限')}
              <Input
                type="number"
                min={0}
                max={999}
                step={1}
                inputMode="numeric"
                value={String(a.maxConcurrent ?? 0)}
                onChange={(e) => {
                  const n = Math.floor(Number(e.target.value))
                  onChange({ maxConcurrent: Number.isFinite(n) ? Math.min(999, Math.max(0, n)) : 0 })
                }}
                aria-label={t('并发上限')}
                className="h-9 w-28 font-mono text-[0.8125rem]"
              />
              <span className="text-[0.71875rem] text-subtle">
                {t(
                  '用这个 API 同时在请求模型的对话、子对话和子任务最多几个，超过的排队，等前面的释放再开始；0 表示不限制。按 API 分别计算，停在等下一句、等子任务时不占名额。',
                )}
              </span>
            </label>
          </div>
          <ApiBalanceRow a={a} />
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className="text-[0.75rem] text-subtle">{t('可用的模型')}</span>
              <span className="flex-1" />
              {/* 用哪个模型测联通：默认是模型列表里的第一个（默认模型），没有模型时提示先获取 */}
              <Select
                aria-label={t('测试连接用的模型')}
                title={t('选中哪个模型，点「测试连接」就用它真的发一次请求')}
                className="h-8 w-44 font-mono text-[0.75rem]"
                value={probeTarget(modelsForProtocol(a.models, a.protocol), probeModel)}
                options={probeOptions}
                disabled={busy || !probeOptions.some((o) => o.value)}
                onChange={(e) => pickProbeModel(e.target.value)}
              />
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
                        `接口地址：${apiBaseUrl(a) || '（空）'}${a.baseUrl.trim() ? '' : '（留空时用厂家默认地址）'}`,
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
            {/* 一个模型一行：默认思考强度和映射模型都按模型配；别的协议后缀的模型不显示 */}
            {modelsForProtocol(a.models, a.protocol).map((m, i) => (
              <div
                key={m}
                className="flex items-center gap-3 rounded-lg border bg-card px-2.5 py-1.5"
                title={i === 0 ? t('第一个是默认模型') : undefined}
              >
                {/* 模型名按自己的长度占位，映射模型的下拉填满剩下的；窄的时候两边一起收，模型名至少留几个字 */}
                <span className="min-w-[6rem] max-w-[45%] shrink truncate font-mono text-[0.78125rem]">
                  {m}
                  {i === 0 && (
                    <span className="ml-1.5 rounded bg-accent-soft px-1 text-[0.625rem] text-accent">{t('默认')}</span>
                  )}
                </span>
                <label className="flex shrink-0 items-center gap-1.5 text-[0.75rem] text-subtle">
                  {t('默认思考强度')}
                  <Select
                    aria-label={t('{model} 的默认思考强度', { model: m })}
                    className="h-7 w-24 text-[0.75rem]"
                    value={a.modelEfforts[m] ?? ''}
                    options={effortOptions(m)}
                    onChange={(e) => setEffort(m, e.target.value)}
                  />
                </label>
                <label className="flex min-w-[9rem] flex-1 items-center gap-1.5 text-[0.75rem] text-subtle">
                  <span className="shrink-0">{t('映射模型')}</span>
                  <Select
                    aria-label={t('{model} 的映射模型', { model: m })}
                    className="h-7 min-w-0 flex-1 font-mono text-[0.75rem]"
                    value={a.modelMap[m] ?? ''}
                    options={mapOptions(m, a.modelMap[m])}
                    onChange={(e) => setMap(m, e.target.value)}
                  />
                </label>
                <button
                  type="button"
                  aria-label={t('移除 {name}', { name: m })}
                  onClick={() => toggle(m)}
                  className="grid h-6 w-6 shrink-0 cursor-pointer place-items-center rounded text-subtle hover:bg-sel hover:text-fg"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
            <form
              className="flex flex-wrap items-center gap-2"
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
                className="h-8 w-56 font-mono text-[0.75rem]"
              />
              <span className="text-[0.71875rem] text-subtle">
                {t('映射模型默认按模型名自动识别，改过就以你选的为准；发给 Agent 的仍然是这里的模型名。')}
              </span>
            </form>
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
          <div className="flex flex-wrap items-center gap-2">
            <p className="min-w-0 flex-1 text-[0.75rem] text-subtle">
              {t('可以用在：{clis}', { clis: usedBy(a.protocol).join('、') || '—' })}
            </p>
            {/* 绑定了厂家时右上角是「清空绑定」，整卡删除放在这里，两个动作分得开 */}
            {vendor && (
              <Button size="sm" variant="ghost" className="text-danger hover:bg-danger/10" onClick={onRemove}>
                <Trash2 className="h-3.5 w-3.5" />
                {t('删除这个 API')}
              </Button>
            )}
            {/* 改 API 不会自动改 CLI 的配置文件，点这里才写进去 */}
            <Button
              size="sm"
              variant="secondary"
              disabled={updating}
              onClick={() => void applyApi()}
              title={t('把现在的接口地址、密钥和模型写进正在用这个 API 的 Agent 配置文件')}
            >
              <RefreshCw className={cn('h-3.5 w-3.5', updating && 'animate-spin')} />
              {t('一键更新')}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

/**
 * 账户余额：厂家定义里写了余额接口才有（现在只有 DeepSeek，见 shared/api-vendors.ts）。
 * 卡片展开时查一次，之后点刷新才重查：失败不自动重试，免得一直刷屏请求。
 * 厂家不支持、密钥没填、查询失败都写明原因，不留空白。
 */
function ApiBalanceRow({ a }: { a: ApiConfig }) {
  const url = apiBalanceUrl(a)
  const apiKey = a.apiKey.trim()
  const [state, setState] = useState<{
    loading: boolean
    /** 查过一次时记下当时用的密钥：密钥改过了就不显示旧结果 */
    forKey?: string
    data?: ApiBalance
    error?: string
  }>({ loading: false })
  // 点一次刷新加一次，effect 跟着重查
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!url || !apiKey) {
      setState({ loading: false })
      return
    }
    let alive = true
    setState({ loading: true, forKey: apiKey })
    api
      .apiBalance(a)
      .then((data) => alive && setState({ loading: false, forKey: apiKey, data }))
      .catch((e: Error) => alive && setState({ loading: false, forKey: apiKey, error: e.message }))
    return () => {
      alive = false
    }
    // 只在展开（挂载）、余额接口变化或点了刷新（tick）时查一次；密钥不在依赖里，边打字边请求会刷屏
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [url, tick])
  // 自定义 API 没有厂家，也就没有余额接口可查：不显示这一行
  if (!findVendor(a.name)) return null
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border bg-card px-2.5 py-1.5 text-[0.75rem]">
      <span className="flex shrink-0 items-center gap-1.5 text-subtle">
        <Wallet className="h-3.5 w-3.5" />
        {t('账户余额')}
      </span>
      {!url ? (
        <span className="text-subtle">{t('这个厂家不支持查询账户余额')}</span>
      ) : !apiKey ? (
        <span className="text-subtle">{t('填上密钥后可以查看余额')}</span>
      ) : !state.forKey || state.forKey !== apiKey ? (
        <span className="text-subtle">{t('点刷新按钮查看余额')}</span>
      ) : state.loading ? (
        <span className="flex items-center gap-1.5 text-subtle">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t('正在查询余额…')}
        </span>
      ) : state.error ? (
        <span className="flex min-w-0 items-center gap-1.5 text-danger">
          <CircleAlert className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 break-words">{state.error}</span>
        </span>
      ) : state.data ? (
        <>
          {state.data.rows.map((r, i) => (
            <span
              key={`${r.currency}-${i}`}
              className="font-mono"
              title={[
                r.granted && t('赠送余额：{amount}', { amount: r.granted }),
                r.toppedUp && t('充值余额：{amount}', { amount: r.toppedUp }),
              ]
                .filter(Boolean)
                .join('\n')}
            >
              {r.currency} {r.total || '—'}
            </span>
          ))}
          {!state.data.available && <span className="text-danger">{t('余额不足，接口会拒绝请求')}</span>}
        </>
      ) : null}
      <span className="flex-1" />
      {url && apiKey && (
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t('刷新余额')}
          title={t('刷新余额')}
          disabled={state.loading}
          onClick={() => setTick((n) => n + 1)}
        >
          <RefreshCw className={cn('h-3.5 w-3.5', state.loading && 'animate-spin')} />
        </Button>
      )}
    </div>
  )
}
