import { useEffect, useRef, useState } from 'react'
import { toast } from '@/lib/toast'
import { Box, ChevronRight, Copy, Gamepad2, Globe, ImagePlus, Loader2, Trash2, X } from 'lucide-react'
import { PROMPT_CATEGORY_LABEL, type SavedStyle, type SavedStyleInput, type StyleKind } from '@shared/style-types'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Textarea } from '@/components/ui/input'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Card } from '@/components/ui/card'
import { EmptyPanel } from '@/components/ui/empty-panel'
import { Badge } from '@/components/ui/badge'
import { IconButton } from '@/components/ui/icon-button'
import { t } from '@shared/i18n'
import { StyleThumb, styleImageSrc } from '@/components/ui/style-thumb'
import { StyleRulesEditor } from './StyleRulesEditor'

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

/** 风格类别的名字和图标 */
const KINDS: { kind: StyleKind; title: () => string; icon: typeof Box }[] = [
  { kind: 'game', title: () => t('游戏 UI'), icon: Gamepad2 },
  { kind: 'web', title: () => t('网页 UI'), icon: Globe },
  { kind: 'model', title: () => t('3D 模型'), icon: Box },
]
const kindOf = (k: StyleKind) => KINDS.find((x) => x.kind === k) ?? KINDS[0]!

/** 图片读成 data URL（上传参考图、复制内置风格时把打包的图转存一份） */
const toDataUrl = (b: Blob) =>
  new Promise<string>((ok, fail) => {
    const r = new FileReader()
    r.onload = () => ok(String(r.result))
    r.onerror = () => fail(r.error)
    r.readAsDataURL(b)
  })

/**
 * 设置里的风格库：UI 设计存下来的整体风格和 3D 模型（Blender 建模）的风格，可以改名、改说明、换参考图、删掉。
 * 新的设计还没定风格时，AI 会把同类的风格作为选项；设计里也能直接套用；模型设计对话新建时选一个模型风格
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

  const replace = (x: SavedStyle) => setList((l) => l?.map((y) => (y.id === x.id ? x : y)) ?? l)
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
      <div className="flex items-center gap-2 py-6 text-body text-subtle">
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
        rules: s.rules,
      })
      // 内置风格的参考图随程序打包：转存一份到自己的风格上，复制出来的也有图
      const src = styleImageSrc(s)
      const img = src
        ? await fetch(src)
            .then((r) => (r.ok ? r.blob() : null))
            .catch(() => null)
        : null
      const withImg = img ? await api.uploadStyleImage(c.id, await toDataUrl(img)).catch(() => c) : c
      setList((l) => (l ? [withImg, ...l] : l))
      toast.success(t('已复制到「我的风格」，可以改了'))
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  return (
    <div className="flex flex-col gap-6 pt-2">
      <p className="text-body leading-relaxed text-muted">
        {t(
          '风格库分三类：游戏 UI、网页 UI 给 UI 设计用，3D 模型给 Blender 建模用（约定造型、拓扑、材质这些，建模前选一个）。程序内置了一批常用风格（只读，可以复制成自己的再改），每个都有参考图，点缩略图看大图；自己的风格可以换参考图。',
        )}
      </p>
      {/* 三类风格分开：每类里自己存的在前，内置的在后 */}
      {KINDS.map(({ kind, title: titleOf, icon: Icon }) => {
        const title = titleOf()
        const mine = list.filter((x) => x.kind === kind && !x.builtin)
        const builtin = list.filter((x) => x.kind === kind && x.builtin)
        return (
          <section key={kind} className="flex flex-col gap-3" aria-label={title}>
            <h3 className="flex items-center gap-2 border-b pb-2 text-prose font-medium">
              <Icon className="h-4 w-4 text-accent-text" />
              {title}
              <span className="text-footnote font-normal text-subtle">
                {t('{n} 个', { n: mine.length + builtin.length })}
              </span>
            </h3>
            <h4 className="text-footnote font-medium text-subtle">{t('我的风格')}</h4>
            {mine.length ? (
              mine.map((s) => (
                <StyleCard
                  key={s.id}
                  s={s}
                  onPatch={(p) => void patch(s, p)}
                  onImage={replace}
                  onRemove={() => setRemoving(s)}
                />
              ))
            ) : (
              <EmptyPanel size="sm" className="text-footnote leading-relaxed">
                {kind === 'model'
                  ? t('还没有自己的模型风格：复制一个内置的来改。')
                  : t('还没有自己的风格：在 UI 设计的风格设置里点「存到风格库」，或复制一个内置的来改。')}
              </EmptyPanel>
            )}
            <h4 className="pt-2 text-footnote font-medium text-subtle">{t('内置风格')}</h4>
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
        description={t('已经用了这个风格的设计和模型不受影响。')}
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
  onImage,
  onRemove,
  onCopy,
  readOnly,
}: {
  s: SavedStyle
  onPatch?: (p: Partial<SavedStyleInput>) => void
  /** 换了 / 删了参考图：服务端返回的新风格 */
  onImage?: (s: SavedStyle) => void
  onRemove?: () => void
  /** 内置风格：复制成自己的 */
  onCopy?: () => void
  readOnly?: boolean
}) {
  const [open, setOpen] = useState(false)
  const { icon: Icon, title } = kindOf(s.kind)
  const model = s.kind === 'model'
  return (
    <Card>
      <div className="flex items-start gap-3 px-4 pt-3.5">
        <div className="mt-1 flex shrink-0 flex-col items-center gap-1">
          <StyleThumb style={s} size="md" />
          {!readOnly && onImage && <ImageButtons s={s} onImage={onImage} />}
        </div>
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
                'h-7 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 text-prose font-medium outline-none',
                !readOnly && 'hover:border-line focus:border-focus focus:bg-field',
              )}
            />
            <Badge className="shrink-0 py-0.5 text-caption">
              <Icon className="h-3 w-3" />
              {title()}
            </Badge>
            {readOnly ? (
              <button
                onClick={onCopy}
                aria-label={t('复制到我的风格')}
                title={t('复制到我的风格，再自己改')}
                className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 text-footnote text-muted hover:bg-sel hover:text-fg"
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
            className="min-h-0 resize-none border-transparent bg-transparent px-1.5 py-1 text-footnote leading-relaxed text-muted hover:border-line focus:bg-field"
          />
          {s.prompts.length > 0 && (
            <div className="flex flex-wrap gap-1 px-1.5 pb-1">
              {s.prompts.map((p, i) => (
                <span key={i} title={p.en} className="rounded-md bg-field px-1.5 py-0.5 text-caption text-muted">
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
        className="flex w-full cursor-pointer items-center gap-1 px-4 pt-1 pb-3 pl-[124px] text-left text-footnote text-subtle hover:text-fg"
      >
        <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-90')} />
        {model ? t('约束要点（{n} 条，交给 Agent 的建模和材质要求）', { n: s.rules.length }) : t('发给 AI 的英文描述')}
      </button>
      {open && model && (
        <div className="px-4 pb-4 pl-[124px]">
          <StyleRulesEditor rules={s.rules} readOnly={readOnly} onChange={(rules) => onPatch?.({ rules })} />
        </div>
      )}
      {open && !model && (
        <div className="px-4 pb-4 pl-[124px]">
          <Textarea
            defaultValue={s.en}
            readOnly={readOnly}
            aria-label={t('英文风格描述')}
            rows={4}
            onBlur={(e) => e.target.value.trim() !== s.en && onPatch?.({ en: e.target.value.trim() })}
            className="font-mono text-footnote leading-relaxed"
          />
        </div>
      )}
    </Card>
  )
}

/** 自己的风格：换参考图（选图片文件）、去掉参考图 */
function ImageButtons({ s, onImage }: { s: SavedStyle; onImage: (s: SavedStyle) => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const run = async (job: () => Promise<SavedStyle>) => {
    setBusy(true)
    try {
      onImage(await job())
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex items-center gap-0.5">
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (f) void run(async () => api.uploadStyleImage(s.id, await toDataUrl(f)))
        }}
      />
      <IconButton
        size="sm"
        icon={busy ? Loader2 : ImagePlus}
        label={s.image ? t('换参考图') : t('加参考图')}
        disabled={busy}
        onClick={() => input.current?.click()}
      />
      {s.image && (
        <IconButton
          size="sm"
          icon={X}
          label={t('去掉参考图')}
          disabled={busy}
          onClick={() => void run(() => api.removeStyleImage(s.id))}
        />
      )}
    </div>
  )
}
