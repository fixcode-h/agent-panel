import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Check, Download, Eye, EyeOff, Loader2, Plus, Trash2, X } from 'lucide-react'
import { CLIS } from '@shared/clis'
import { API_PROTOCOLS, API_PROTOCOL_LABEL, type ApiConfig, type ApiProtocol } from '@shared/accounts'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input, Select } from '@/components/ui/input'
import { Group } from './parts'
import { t } from '@shared/i18n'

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
        protocol: preset?.protocol ?? 'openai-chat',
        baseUrl: preset?.baseUrl ?? '',
        apiKey: '',
        authHeader: 'x-api-key',
        models: [],
      },
    ])
  return (
    <Group>
      <p className="pb-3 text-[13px] leading-relaxed text-subtle">
        {t(
          '在这里配好 API，再到各个 CLI 的页面把「登录方式」切到 API 选用。协议对得上的 CLI 才能选：Anthropic 给 Claude Code，OpenAI Responses 给 Codex，Gemini 给 Gemini CLI，Command Code 三种都能用。',
        )}
      </p>
      <div className="flex flex-col gap-4">
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
        <span className="text-[12px] text-subtle">{t('从常用的开始：')}</span>
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
  const [found, setFound] = useState<string[]>()
  const [filter, setFilter] = useState('')
  const [draft, setDraft] = useState('')
  const fetchModels = async () => {
    setFetching(true)
    try {
      const { models } = await api.apiModels(a)
      setFound(models)
      setFilter('')
      if (!a.models.length) onChange({ models: models.slice(0, 1) })
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setFetching(false)
    }
  }
  const toggle = (m: string) =>
    onChange({ models: a.models.includes(m) ? a.models.filter((x) => x !== m) : [...a.models, m] })
  const shown = useMemo(
    () => (found ?? []).filter((m) => m.toLowerCase().includes(filter.trim().toLowerCase())),
    [found, filter],
  )
  const addDraft = () => {
    const m = draft.trim()
    if (m && !a.models.includes(m)) onChange({ models: [...a.models, m] })
    setDraft('')
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
        <label className="flex flex-col gap-1 text-[12px] text-subtle">
          {t('协议')}
          <Select
            aria-label={t('协议')}
            value={a.protocol}
            onChange={(e) => onChange({ protocol: e.target.value as ApiProtocol })}
            options={API_PROTOCOLS.map((p) => ({ value: p, label: API_PROTOCOL_LABEL[p] }))}
          />
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-subtle">
          {t('接口地址')}
          <Input
            value={a.baseUrl}
            onChange={(e) => onChange({ baseUrl: e.target.value })}
            placeholder="https://api.example.com/v1"
            spellCheck={false}
            aria-label={t('接口地址')}
            className="h-9 font-mono text-[13px]"
          />
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-subtle sm:col-span-2">
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
              className="h-9 min-w-0 flex-1 font-mono text-[13px]"
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
          <label className="flex flex-col gap-1 text-[12px] text-subtle">
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
          <span className="text-[12px] text-subtle">{t('可用的模型')}</span>
          <span className="flex-1" />
          <Button
            size="sm"
            variant="secondary"
            disabled={fetching || (!a.baseUrl && a.protocol !== 'gemini')}
            onClick={fetchModels}
          >
            {fetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            {t('从接口获取')}
          </Button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {a.models.map((m, i) => (
            <span
              key={m}
              className="inline-flex h-7 items-center gap-1 rounded-md bg-sel pr-1 pl-2 font-mono text-[12px]"
              title={i === 0 ? t('第一个是默认模型') : undefined}
            >
              {m}
              {i === 0 && <span className="rounded bg-accent-soft px-1 text-[10px] text-accent">{t('默认')}</span>}
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
              className="h-7 w-52 font-mono text-[12px]"
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
                className="h-8 min-w-0 flex-1 text-[12.5px]"
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
                      'inline-flex h-7 cursor-pointer items-center gap-1 rounded-md border px-2 font-mono text-[12px] transition-colors',
                      on ? 'border-accent/50 bg-accent-soft text-accent' : 'hover:bg-sel',
                    )}
                  >
                    {on && <Check className="h-3 w-3" strokeWidth={3} />}
                    {m}
                  </button>
                )
              })}
              {!shown.length && <span className="text-[12px] text-subtle">{t('没有匹配的模型')}</span>}
            </div>
          </div>
        )}
      </div>
      <p className="text-[12px] text-subtle">{t('可以用在：{clis}', { clis: usedBy(a.protocol).join('、') || '—' })}</p>
    </div>
  )
}
