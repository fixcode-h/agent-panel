import { useState } from 'react'
import { ChevronRight, KeyRound } from 'lucide-react'
import { t } from '@shared/i18n'
import { integrationCredentialsContract as C } from '@shared/api-contract/integration-credentials'
import type { IntegrationView } from '@shared/integrations'
import { call } from '@/lib/api/call'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Field, Input, Select } from '@/components/ui/input'
import { SecretField, useSecretStore } from '@/components/ui/secret-field'

/**
 * 账号授权卡片里的「备用登录」：不装 CLI 时用的 token 一类（例如飞书，用户 2026-11-24 要把飞书插件的登录搬到账号授权）。
 * 和 CLI 自己保存的登录不同，这些是用户填的，面板加密存本机；保密项只显示末 4 位，不保密的（选哪个平台）照原样显示。
 * 字段由 shared/integrations.ts 的 credentials 定义，这里不认具体工具
 */
export function IntegrationCredentials({ v }: { v: IntegrationView }) {
  const state = useSecretStore(v.id, {
    load: () => call(C.hints, { params: { id: v.id } }),
    save: (patch) => call(C.save, { params: { id: v.id }, body: patch }),
  })
  const filled = Object.keys(state.hints).some((k) => v.credentials.find((c) => c.key === k)?.secret)
  // 没装 CLI 时备用登录就是唯一的路，直接展开；装了的收起来，免得像是必须填
  const [open, setOpen] = useState(!v.installed)
  const [saving, setSaving] = useState(false)

  const save = async () => {
    setSaving(true)
    try {
      await state.save()
      toast.success(t('已保存'))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mt-3 rounded-lg border border-line">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-footnote text-muted hover:text-fg"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-90')} />
        <KeyRound className="h-3.5 w-3.5" />
        <span>{t('备用登录：不装 {command} 时用 token', { command: v.command })}</span>
        <span className={cn('ml-auto', filled ? 'text-success' : 'text-subtle')}>{filled ? t('已填') : t('没填')}</span>
      </button>
      {open && (
        <div className="flex flex-col gap-3 border-t border-line px-3 py-3">
          {v.credentialsNote && <p className="text-footnote leading-relaxed text-subtle">{v.credentialsNote}</p>}
          <div className="grid gap-3 md:grid-cols-2">
            {v.credentials.map((c) => {
              const value = state.patch[c.key] ?? state.hints[c.key]?.value ?? ''
              return (
                <Field key={c.key} label={c.label} hint={c.desc}>
                  {c.secret ? (
                    <SecretField s={c} state={state} />
                  ) : c.options ? (
                    <Select
                      aria-label={c.label}
                      value={value || c.options[0]?.value || ''}
                      options={c.options}
                      onChange={(e) => state.edit(c.key, e.target.value)}
                    />
                  ) : (
                    <Input
                      aria-label={c.label}
                      value={value}
                      placeholder={c.placeholder}
                      className="font-mono"
                      onChange={(e) => state.edit(c.key, e.target.value)}
                    />
                  )}
                </Field>
              )
            })}
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => void save()} disabled={!state.dirty || saving}>
              {t('保存')}
            </Button>
            {state.dirty && (
              <Button size="sm" variant="ghost" onClick={state.reset}>
                {t('取消')}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
