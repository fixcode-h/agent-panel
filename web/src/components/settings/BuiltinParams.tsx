import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { t } from '@shared/i18n'
import { hooksApi, type BuiltinHookView } from '@/lib/api-hooks'
import { toastError } from '@/lib/toast'
import { Modal } from '@/components/ui/modal'
import { Field, Input, Textarea } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

/**
 * 内置钩子的参数（ADR 0049 第四期）：危险命令另外拦哪些、长命令另外算哪些、哪些文件可以写凭据……
 * 列表参数一行一项；数字参数一个数。保存时一项一项写，和默认值一样的服务端不记
 */
export function BuiltinParams({
  hook,
  onOpenChange,
  onSaved,
}: {
  hook: BuiltinHookView | null
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (!hook) return
    setDraft(
      Object.fromEntries(
        hook.params.map((p) => [p.key, Array.isArray(p.value) ? p.value.join('\n') : String(p.value)]),
      ),
    )
  }, [hook])

  const save = async () => {
    if (!hook) return
    setSaving(true)
    try {
      for (const p of hook.params) {
        const raw = draft[p.key] ?? ''
        const value =
          p.kind === 'number'
            ? Number(raw)
            : raw
                .split('\n')
                .map((x) => x.trim())
                .filter(Boolean)
        await hooksApi.setParam(hook.id, p.key, value)
      }
      onSaved()
      onOpenChange(false)
    } catch (e) {
      toastError(e)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={!!hook}
      onOpenChange={onOpenChange}
      title={t('「{name}」的参数', { name: hook?.name ?? '' })}
      footer={
        <>
          <span className="flex-1" />
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t('取消')}
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('保存')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {hook?.params.map((p) => (
          <Field key={p.key} label={p.label} hint={p.hint}>
            {p.kind === 'number' ? (
              <Input
                type="number"
                value={draft[p.key] ?? ''}
                onChange={(e) => setDraft({ ...draft, [p.key]: e.target.value })}
                aria-label={p.label}
              />
            ) : (
              <Textarea
                rows={5}
                className="font-mono text-xs"
                value={draft[p.key] ?? ''}
                onChange={(e) => setDraft({ ...draft, [p.key]: e.target.value })}
                aria-label={p.label}
              />
            )}
          </Field>
        ))}
      </div>
    </Modal>
  )
}
