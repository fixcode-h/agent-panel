import { useState } from 'react'
import type { ApiProtocol } from '@shared/accounts'
import { matchModel } from '@shared/models/catalog'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { toast } from '@/lib/toast'
import { refreshModelCatalog, useModelCatalog } from '@/lib/model-catalog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * 模型的 API 单价（美元 / 百万 token，设计报告 Agent P1-4）：Codex、Command Code 不报费用，按这里填的单价折算，
 * 项目「按费用的用量上限」才对它们起作用；CLI 自己报了费用（Claude Code、Pi）时照旧用它报的。
 * 不内置价格：官方价会变，写错了比空着更糟。存进模型目录的补充记录，所有 CLI 共用
 */
export function ModelPriceField({
  model,
  protocol,
  readOnly,
}: {
  model: string
  protocol?: ApiProtocol
  readOnly?: boolean
}) {
  const catalog = useModelCatalog()
  const entry = model ? matchModel(model, { entries: catalog?.entries ?? [], protocol })?.entry : undefined
  const price = entry?.price
  const [draft, setDraft] = useState<{ input: string; output: string; cacheRead: string } | null>(null)
  const [busy, setBusy] = useState(false)
  if (!entry) return null
  const shown = draft ?? {
    input: price ? String(price.input) : '',
    output: price ? String(price.output) : '',
    cacheRead: price?.cacheRead ? String(price.cacheRead) : '',
  }
  const num = (s: string) => (s.trim() === '' ? NaN : Number(s))
  const valid = [shown.input, shown.output].every((s) => Number.isFinite(num(s)) && num(s) >= 0)
  const save = async (clear: boolean) => {
    setBusy(true)
    try {
      await api.setModelPrice(
        entry.vendor,
        entry.id,
        clear
          ? null
          : {
              input: num(shown.input),
              output: num(shown.output),
              cacheRead: Number.isFinite(num(shown.cacheRead)) ? num(shown.cacheRead) : 0,
              cacheWrite: 0,
            },
      )
      await refreshModelCatalog()
      setDraft(null)
      toast.success(
        clear ? t('已清掉 {model} 的单价', { model: entry.id }) : t('已保存 {model} 的单价', { model: entry.id }),
      )
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const field = (k: 'input' | 'output' | 'cacheRead', label: string) => (
    <label className="flex min-w-0 flex-col gap-1 text-caption text-subtle">
      {label}
      <Input
        inputMode="decimal"
        value={shown[k]}
        disabled={readOnly || busy}
        placeholder={k === 'cacheRead' ? t('可不填') : '0'}
        onChange={(e) => setDraft({ ...shown, [k]: e.target.value })}
        className="h-7 font-mono text-footnote"
      />
    </label>
  )
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-caption text-subtle">
        {t('单价（美元 / 百万 token）')}
        <span className="ml-1.5">
          {t('CLI 不报费用时按它折算，「按费用的用量上限」才对这个模型起作用；没填就是费用未知')}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {field('input', t('输入'))}
        {field('output', t('输出'))}
        {field('cacheRead', t('缓存命中'))}
      </div>
      {!readOnly && (draft || price) && (
        <div className="flex justify-end gap-1.5">
          {price && !draft && (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-1.5 text-caption"
              disabled={busy}
              onClick={() => void save(true)}
            >
              {t('清掉单价')}
            </Button>
          )}
          {draft && (
            <Button
              size="sm"
              className="h-6 px-2 text-caption"
              disabled={busy || !valid}
              onClick={() => void save(false)}
            >
              {t('保存单价')}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
