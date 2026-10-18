import { useEffect, useState } from 'react'
import * as D from '@radix-ui/react-dialog'
import { toast } from 'sonner'
import { BookmarkPlus, Check, Loader2, Palette } from 'lucide-react'
import type { DesignKind, SavedStyle, SavedStyleInput } from '@shared/design'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input, Textarea } from '@/components/ui/input'
import { ScopeRequests } from '@/components/chat/AskToggle'
import { t } from '@shared/i18n'

/** 风格库里同类（游戏 / 网页）的风格；active 时才去取 */
export function useStyles(kind: DesignKind, active: boolean) {
  const [list, setList] = useState<SavedStyle[] | null>(null)
  useEffect(() => {
    if (!active) return
    api
      .styles()
      .then((l) => {
        const same = l.filter((x) => x.kind === kind)
        setList([...same.filter((x) => !x.builtin), ...same.filter((x) => x.builtin)])
      })
      .catch(() => setList([]))
  }, [kind, active])
  return list
}

/** 风格库的列表：点一下套用到这个设计 */
export function StyleLibraryList({
  kind,
  active,
  current,
  onPick,
}: {
  kind: DesignKind
  active: boolean
  /** 这个设计现在的风格（英文），一样的打勾 */
  current: string
  onPick: (s: SavedStyle) => void
}) {
  const list = useStyles(kind, active)
  if (!list) return <Loader2 className="mx-auto my-2 h-4 w-4 animate-spin text-subtle" />
  if (!list.length)
    return (
      <p className="text-[11.5px] leading-relaxed text-subtle">{t('风格库还是空的，可以把这个设计的风格存进去。')}</p>
    )
  return (
    <div className="flex max-h-48 flex-col gap-1 overflow-y-auto">
      {list.map((s) => (
        <button
          key={s.id}
          onClick={() => onPick(s)}
          title={s.en}
          className="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-sel"
        >
          <Palette className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5 text-[12.5px]">
              <span className="truncate">{s.name}</span>
              {s.builtin && <span className="shrink-0 rounded bg-field px-1 text-[10px] text-subtle">{t('内置')}</span>}
            </span>
            {s.summary && <span className="line-clamp-2 text-[11.5px] leading-snug text-subtle">{s.summary}</span>}
          </span>
          {current.trim() === s.en.trim() && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />}
        </button>
      ))}
    </div>
  )
}

/**
 * 「存到风格库」：让 CLI 总结这个设计的整体风格（风格说明、项目提示词、图片描述、对话），
 * 出来后先给用户看、能改名字和说明，确认了再存
 */
export function SaveStyleButton({
  designId,
  kind,
  beforeExtract,
}: {
  designId: string
  kind: DesignKind
  /** 先把没存的改动存下，CLI 读到的才是最新的 */
  beforeExtract: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [scope] = useState(() => crypto.randomUUID())
  const [draft, setDraft] = useState<Omit<SavedStyleInput, 'kind'> | null>(null)
  const [saving, setSaving] = useState(false)

  const extract = async () => {
    if (busy) return
    setBusy(true)
    try {
      await beforeExtract()
      setDraft(await api.extractStyle(designId, scope))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const save = async () => {
    if (!draft?.name.trim() || saving) return
    setSaving(true)
    try {
      await api.createStyle({ ...draft, kind })
      toast.success(t('已存到风格库'))
      setDraft(null)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => void extract()} disabled={busy} className="w-full">
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <BookmarkPlus className="h-3.5 w-3.5" />}
        {busy ? t('AI 正在总结风格…') : t('存到风格库')}
      </Button>
      <ScopeRequests scope={`style:${scope}`} active={busy} className="mt-2 mb-0 max-w-none" />
      <D.Root open={!!draft} onOpenChange={(o) => !o && setDraft(null)}>
        <D.Portal>
          <D.Overlay className="fixed inset-0 z-40 bg-black/45 animate-[fade-in_150ms_ease-out]" />
          <D.Content className="fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[min(520px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 overflow-y-auto rounded-2xl border border-line-strong bg-card p-5 shadow-pop animate-[pop-in_160ms_ease-out] focus:outline-none">
            <D.Title className="text-[15px] font-semibold">{t('存到风格库')}</D.Title>
            <D.Description className="-mt-2 text-[12.5px] leading-relaxed text-muted">
              {t('AI 从这个设计里总结出了下面的风格，可以改一改再存。')}
            </D.Description>
            {draft && (
              <>
                <label className="flex flex-col gap-1 text-[12px] text-muted">
                  {t('名字')}
                  <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                </label>
                <label className="flex flex-col gap-1 text-[12px] text-muted">
                  {t('说明')}
                  <Textarea
                    rows={2}
                    value={draft.summary ?? ''}
                    onChange={(e) => setDraft({ ...draft, summary: e.target.value })}
                  />
                </label>
                <label className="flex flex-col gap-1 text-[12px] text-muted">
                  {t('发给 AI 的英文描述')}
                  <Textarea
                    rows={4}
                    value={draft.en ?? ''}
                    onChange={(e) => setDraft({ ...draft, en: e.target.value })}
                    className="font-mono text-[12px]"
                  />
                </label>
                {!!draft.prompts?.length && (
                  <div className="flex flex-wrap gap-1">
                    {draft.prompts.map((p, i) => (
                      <span key={i} title={p.en} className="rounded-md bg-field px-1.5 py-0.5 text-[11.5px] text-muted">
                        {p.zh}
                      </span>
                    ))}
                  </div>
                )}
              </>
            )}
            <div className="mt-1 flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setDraft(null)}>
                {t('取消')}
              </Button>
              <Button onClick={() => void save()} disabled={!draft?.name.trim() || saving}>
                {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {t('保存')}
              </Button>
            </div>
          </D.Content>
        </D.Portal>
      </D.Root>
    </>
  )
}
