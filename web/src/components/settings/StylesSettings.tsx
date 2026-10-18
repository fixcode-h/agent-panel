import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ChevronRight, Gamepad2, Globe, Loader2, Palette, Trash2 } from 'lucide-react'
import { PROMPT_CATEGORY_LABEL, type SavedStyle, type SavedStyleInput } from '@shared/design'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Textarea } from '@/components/ui/input'
import { ConfirmDialog } from '@/components/ui/dialog'
import { t } from '@shared/i18n'

/** 风格分类的名字：静态写出来，文案检查才认得 */
const catLabel = (c: keyof typeof PROMPT_CATEGORY_LABEL) =>
  ({
    style: t('画风'),
    color: t('色彩'),
    material: t('材质'),
    light: t('光影'),
    layout: t('构图'),
    avoid: t('避免'),
  })[c]

/**
 * 设置里的风格库：从 UI 设计里存下来的整体风格（CLI 总结的），可以改名、改说明、删掉。
 * 新的设计还没定风格时，AI 会把同类的风格作为选项；设计里也能直接套用
 */
export function StylesSettings() {
  const [list, setList] = useState<SavedStyle[] | null>(null)
  const [removing, setRemoving] = useState<SavedStyle | null>(null)
  useEffect(() => {
    api
      .styles()
      .then(setList)
      .catch((e) => {
        setList([])
        toast.error((e as Error).message)
      })
  }, [])

  const patch = async (s: SavedStyle, p: Partial<SavedStyleInput>) => {
    setList((l) => l?.map((x) => (x.id === s.id ? { ...x, ...p } : x)) ?? l)
    try {
      await api.updateStyle(s.id, p)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  if (!list)
    return (
      <div className="flex items-center gap-2 py-6 text-[13px] text-subtle">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('加载中…')}
      </div>
    )

  return (
    <div className="flex flex-col gap-4 pt-2">
      <p className="text-[13px] leading-relaxed text-muted">
        {t(
          '从 UI 设计里存下来的整体风格。新的设计还没定风格时，AI 会把同类的风格作为选项问你；在设计的风格设置里也能直接套用，项目的美术提示词也能从这里导入。',
        )}
      </p>
      {!list.length ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-10 text-center">
          <Palette className="h-6 w-6 text-subtle" />
          <p className="text-[13px] font-medium">{t('还没有保存的风格')}</p>
          <p className="max-w-[360px] text-[12.5px] leading-relaxed text-subtle">
            {t('在 UI 设计里打开风格设置，点「存到风格库」，AI 会总结这个设计的风格存进来。')}
          </p>
        </div>
      ) : (
        list.map((s) => (
          <StyleCard key={s.id} s={s} onPatch={(p) => void patch(s, p)} onRemove={() => setRemoving(s)} />
        ))
      )}
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={t('删除风格「{name}」？', { name: removing?.name ?? '' })}
        description={t('已经用了这个风格的设计不受影响。')}
        onConfirm={async () => {
          if (!removing) return
          try {
            await api.deleteStyle(removing.id)
            setList((l) => l?.filter((x) => x.id !== removing.id) ?? l)
            setRemoving(null)
          } catch (e) {
            toast.error((e as Error).message)
          }
        }}
      />
    </div>
  )
}

function StyleCard({
  s,
  onPatch,
  onRemove,
}: {
  s: SavedStyle
  onPatch: (p: Partial<SavedStyleInput>) => void
  onRemove: () => void
}) {
  const [open, setOpen] = useState(false)
  const Icon = s.kind === 'web' ? Globe : Gamepad2
  return (
    <div className="rounded-xl border bg-card shadow-card">
      <div className="flex items-start gap-3 px-4 pt-3.5">
        <span className="mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
          <Palette className="h-4 w-4" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-2">
            <input
              defaultValue={s.name}
              aria-label={t('风格名称')}
              onBlur={(e) => {
                const v = e.target.value.trim()
                if (v && v !== s.name) onPatch({ name: v })
                else e.target.value = s.name
              }}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              className="h-7 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 text-[14px] font-medium outline-none hover:border-line focus:border-accent focus:bg-field"
            />
            <span className="flex shrink-0 items-center gap-1 rounded-full bg-field px-2 py-0.5 text-[11px] text-muted">
              <Icon className="h-3 w-3" />
              {s.kind === 'web' ? t('网页 UI') : t('游戏 UI')}
            </span>
            <button
              onClick={onRemove}
              aria-label={t('删除')}
              title={t('删除')}
              className="grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded-md text-subtle hover:bg-danger/10 hover:text-danger"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
          <Textarea
            defaultValue={s.summary}
            aria-label={t('风格说明')}
            rows={2}
            onBlur={(e) => e.target.value.trim() !== s.summary && onPatch({ summary: e.target.value.trim() })}
            placeholder={t('一两句话说明这个风格')}
            className="min-h-0 resize-none border-transparent bg-transparent px-1.5 py-1 text-[12.5px] leading-relaxed text-muted hover:border-line focus:bg-field"
          />
          {s.prompts.length > 0 && (
            <div className="flex flex-wrap gap-1 px-1.5 pb-1">
              {s.prompts.map((p, i) => (
                <span key={i} title={p.en} className="rounded-md bg-field px-1.5 py-0.5 text-[11.5px] text-muted">
                  <span className="text-subtle">{catLabel(p.category)} · </span>
                  {p.zh}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-1 px-4 pt-1 pb-3 pl-[58px] text-left text-[12px] text-subtle hover:text-fg"
      >
        <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-90')} />
        {t('发给 AI 的英文描述')}
      </button>
      {open && (
        <div className="px-4 pb-4 pl-[58px]">
          <Textarea
            defaultValue={s.en}
            aria-label={t('英文风格描述')}
            rows={4}
            onBlur={(e) => e.target.value.trim() !== s.en && onPatch({ en: e.target.value.trim() })}
            className="font-mono text-[12px] leading-relaxed"
          />
        </div>
      )}
    </div>
  )
}
