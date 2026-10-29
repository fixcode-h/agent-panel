import { useEffect, useState } from 'react'
import { toast } from '@/lib/toast'
import { ChevronRight, Copy, Gamepad2, Globe, Loader2, Palette, Trash2 } from 'lucide-react'
import { PROMPT_CATEGORY_LABEL, type SavedStyle, type SavedStyleInput } from '@shared/design'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Textarea } from '@/components/ui/input'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Card } from '@/components/ui/card'
import { EmptyPanel } from '@/components/ui/empty-panel'
import { Badge } from '@/components/ui/badge'
import { IconButton } from '@/components/ui/icon-button'
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
      <div className="flex items-center gap-2 py-6 text-[0.8125rem] text-subtle">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('加载中…')}
      </div>
    )

  const copy = async (s: SavedStyle) => {
    try {
      const c = await api.createStyle({
        name: `${s.name} ${t('（副本）')}`.slice(0, 40),
        kind: s.kind,
        summary: s.summary,
        en: s.en,
        prompts: s.prompts,
      })
      setList((l) => (l ? [c, ...l] : l))
      toast.success(t('已复制到「我的风格」，可以改了'))
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  const kinds = [
    { kind: 'game' as const, title: t('游戏 UI'), icon: Gamepad2 },
    { kind: 'web' as const, title: t('网页 UI'), icon: Globe },
  ]

  return (
    <div className="flex flex-col gap-6 pt-2">
      <p className="text-[0.8125rem] leading-relaxed text-muted">
        {t(
          '整体美术风格库。新的设计还没定风格时，AI 会把同类的风格作为选项问你；在设计的风格设置里能直接套用，AI 输入框的「+」里能引入，项目的美术提示词也能从这里导入。程序内置了一批常用风格（只读，可以复制成自己的再改），也能把自己设计里的风格存进来。',
        )}
      </p>
      {/* 游戏和网页的风格分开：每类里自己存的在前，内置的在后 */}
      {kinds.map(({ kind, title, icon: Icon }) => {
        const mine = list.filter((x) => x.kind === kind && !x.builtin)
        const builtin = list.filter((x) => x.kind === kind && x.builtin)
        return (
          <section key={kind} className="flex flex-col gap-3" aria-label={title}>
            <h3 className="flex items-center gap-2 border-b pb-2 text-[0.875rem] font-medium">
              <Icon className="h-4 w-4 text-accent" />
              {title}
              <span className="text-[0.75rem] font-normal text-subtle">
                {t('{n} 个', { n: mine.length + builtin.length })}
              </span>
            </h3>
            <h4 className="text-[0.75rem] font-medium text-subtle">{t('我的风格')}</h4>
            {mine.length ? (
              mine.map((s) => (
                <StyleCard key={s.id} s={s} onPatch={(p) => void patch(s, p)} onRemove={() => setRemoving(s)} />
              ))
            ) : (
              <EmptyPanel size="sm" className="text-[0.78125rem] leading-relaxed">
                {t('还没有自己的风格：在 UI 设计的风格设置里点「存到风格库」，或复制一个内置的来改。')}
              </EmptyPanel>
            )}
            <h4 className="pt-2 text-[0.75rem] font-medium text-subtle">{t('内置风格')}</h4>
            {builtin.map((s) => (
              <StyleCard key={s.id} s={s} readOnly onCopy={() => void copy(s)} />
            ))}
          </section>
        )
      })}
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
  onCopy,
  readOnly,
}: {
  s: SavedStyle
  onPatch?: (p: Partial<SavedStyleInput>) => void
  onRemove?: () => void
  /** 内置风格：复制成自己的 */
  onCopy?: () => void
  readOnly?: boolean
}) {
  const [open, setOpen] = useState(false)
  const Icon = s.kind === 'web' ? Globe : Gamepad2
  return (
    <Card>
      <div className="flex items-start gap-3 px-4 pt-3.5">
        <span className="mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
          <Palette className="h-4 w-4" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-2">
            <input
              defaultValue={s.name}
              readOnly={readOnly}
              aria-label={t('风格名称')}
              onBlur={(e) => {
                const v = e.target.value.trim()
                if (v && v !== s.name) onPatch?.({ name: v })
                else e.target.value = s.name
              }}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              className={cn(
                'h-7 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 text-[0.875rem] font-medium outline-none',
                !readOnly && 'hover:border-line focus:border-focus focus:bg-field',
              )}
            />
            <Badge className="shrink-0 py-0.5 text-[0.6875rem]">
              <Icon className="h-3 w-3" />
              {s.kind === 'web' ? t('网页 UI') : t('游戏 UI')}
            </Badge>
            {readOnly ? (
              <button
                onClick={onCopy}
                aria-label={t('复制到我的风格')}
                title={t('复制到我的风格，再自己改')}
                className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 text-[0.75rem] text-muted hover:bg-sel hover:text-fg"
              >
                <Copy className="h-3.5 w-3.5" />
                {t('复制')}
              </button>
            ) : (
              <IconButton size="sm" tone="danger" icon={Trash2} label={t('删除')} onClick={onRemove} />
            )}
          </div>
          <Textarea
            defaultValue={s.summary}
            readOnly={readOnly}
            aria-label={t('风格说明')}
            rows={2}
            onBlur={(e) => e.target.value.trim() !== s.summary && onPatch?.({ summary: e.target.value.trim() })}
            placeholder={t('一两句话说明这个风格')}
            className="min-h-0 resize-none border-transparent bg-transparent px-1.5 py-1 text-[0.78125rem] leading-relaxed text-muted hover:border-line focus:bg-field"
          />
          {s.prompts.length > 0 && (
            <div className="flex flex-wrap gap-1 px-1.5 pb-1">
              {s.prompts.map((p, i) => (
                <span key={i} title={p.en} className="rounded-md bg-field px-1.5 py-0.5 text-[0.71875rem] text-muted">
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
        className="flex w-full cursor-pointer items-center gap-1 px-4 pt-1 pb-3 pl-[58px] text-left text-[0.75rem] text-subtle hover:text-fg"
      >
        <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-90')} />
        {t('发给 AI 的英文描述')}
      </button>
      {open && (
        <div className="px-4 pb-4 pl-[58px]">
          <Textarea
            defaultValue={s.en}
            readOnly={readOnly}
            aria-label={t('英文风格描述')}
            rows={4}
            onBlur={(e) => e.target.value.trim() !== s.en && onPatch?.({ en: e.target.value.trim() })}
            className="font-mono text-[0.75rem] leading-relaxed"
          />
        </div>
      )}
    </Card>
  )
}
