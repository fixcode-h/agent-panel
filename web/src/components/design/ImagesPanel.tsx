import { useRef } from 'react'
import { AlertCircle, ImagePlus, Loader2, RefreshCw, Trash2, Upload } from 'lucide-react'
import type { DesignImage } from '@shared/design'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { t } from '@shared/i18n'
import { FieldRow, MarginInput, NumInput, TextInput, Thumb } from './fields'

export const readFile = (f: File) =>
  new Promise<string>((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(String(r.result))
    r.onerror = rej
    r.readAsDataURL(f)
  })

/** 图片列表：设计里用到的所有图片，生成中的转圈，失败的标红 */
export function ImagesPanel({
  images,
  url,
  selected,
  onSelect,
  onUpload,
  usedIds,
}: {
  images: DesignImage[]
  url: (img: DesignImage) => string | undefined
  selected: string
  onSelect: (id: string) => void
  onUpload: (files: File[]) => void
  usedIds: Set<string>
}) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <div className="flex flex-col gap-2 p-2">
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        hidden
        onChange={(e) => {
          onUpload([...(e.target.files ?? [])])
          e.target.value = ''
        }}
      />
      <button
        onClick={() => input.current?.click()}
        className="flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-dashed border-line-strong text-[12px] text-subtle hover:border-accent hover:text-accent"
      >
        <Upload className="h-3.5 w-3.5" />
        {t('上传图片')}
      </button>
      {!images.length && (
        <p className="px-1 py-4 text-center text-[12px] leading-relaxed text-subtle">
          {t('还没有图片。在右边告诉 AI 想要什么界面，它会列出需要的图片并生成。')}
        </p>
      )}
      <div className="grid grid-cols-2 gap-2">
        {images.map((i) => (
          <button
            key={i.id}
            onClick={() => onSelect(i.id)}
            className={cn(
              'group flex cursor-pointer flex-col overflow-hidden rounded-lg border bg-field text-left transition-colors',
              selected === i.id ? 'border-accent ring-2 ring-accent-soft' : 'hover:border-line-strong',
            )}
          >
            <span className="relative block">
              <Thumb src={url(i)} className="aspect-square w-full rounded-none border-0" />
              {(i.status === 'generating' || i.status === 'pending') && (
                <span className="absolute inset-0 grid place-items-center bg-black/40 text-white">
                  <Loader2 className={cn('h-5 w-5', i.status === 'generating' && 'animate-spin')} />
                </span>
              )}
              {i.status === 'failed' && (
                <span className="absolute top-1 right-1 rounded-full bg-card p-0.5 text-danger" title={i.error}>
                  <AlertCircle className="h-3.5 w-3.5" />
                </span>
              )}
              {i.variants.length > 1 && (
                <span className="absolute bottom-1 left-1 rounded bg-black/55 px-1 font-mono text-[10px] text-white">
                  {i.selected + 1}/{i.variants.length}
                </span>
              )}
            </span>
            <span className="flex items-center gap-1 px-1.5 py-1">
              <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{i.name}</span>
              {!usedIds.has(i.id) && (
                <span className="shrink-0 text-[10px] text-subtle" title={t('设计里没有用到这张图')}>
                  {t('未用')}
                </span>
              )}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

/** 选中一张图片时的属性：描述、尺寸、透明、九宫格、生成过的每一版 */
export function ImageDetails({
  image,
  url,
  onChange,
  onGenerate,
  onUpload,
  onDelete,
  canGenerate,
  sourceLabel,
}: {
  image: DesignImage
  url: (file: string) => string
  onChange: (img: DesignImage, key: string) => void
  onGenerate: () => void
  onUpload: (file: File) => void
  onDelete: () => void
  canGenerate: boolean
  sourceLabel: string
}) {
  const input = useRef<HTMLInputElement>(null)
  const set = (patch: Partial<DesignImage>, key: string) => onChange({ ...image, ...patch }, `img:${image.id}:${key}`)
  const busy = image.status === 'generating' || image.status === 'pending'
  return (
    <div className="text-[12px]">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <ImagePlus className="h-4 w-4 shrink-0 text-accent" />
        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] font-medium">{image.name}</span>
        <button
          onClick={onDelete}
          aria-label={t('删除图片')}
          title={t('删除图片')}
          className="grid h-6 w-6 cursor-pointer place-items-center rounded-md text-subtle hover:bg-sel hover:text-danger"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      {image.variants.length > 0 && (
        <div className="flex gap-1.5 overflow-x-auto border-b p-2">
          {image.variants.map((v, i) => (
            <button
              key={v.file}
              onClick={() => set({ selected: i }, 'sel')}
              title={`${v.width}×${v.height} · ${{ cli: t('图片模型'), browser: t('浏览器'), upload: t('上传') }[v.source]}`}
              className={cn(
                'shrink-0 cursor-pointer rounded-md border-2 p-px',
                i === image.selected ? 'border-accent' : 'border-transparent hover:border-line-strong',
              )}
            >
              <Thumb src={url(v.file)} className="h-14 w-14" />
            </button>
          ))}
        </div>
      )}
      {image.status === 'failed' && image.error && (
        <p className="mx-3 mt-2 rounded-md bg-danger/10 px-2 py-1.5 text-[11.5px] leading-relaxed whitespace-pre-wrap text-danger">
          {image.error}
        </p>
      )}
      <div className="py-1">
        <FieldRow label={t('名称')}>
          <TextInput label={t('名称')} value={image.name} onChange={(name) => set({ name }, 'name')} />
        </FieldRow>
        <FieldRow label={t('尺寸')}>
          <NumInput prefix="W" min={1} value={image.width} onChange={(width) => set({ width }, 'w')} />
          <NumInput prefix="H" min={1} value={image.height} onChange={(height) => set({ height }, 'h')} />
        </FieldRow>
        <FieldRow label={t('透明背景')}>
          <Switch
            aria-label={t('透明背景')}
            checked={image.transparent}
            onCheckedChange={(v) => set({ transparent: v }, 'tr')}
          />
        </FieldRow>
        <FieldRow label={t('九宫格')} title={t('需要拉伸的框和底图打开，边距是图片尺寸的比例')}>
          <Switch
            aria-label={t('九宫格')}
            checked={!!image.nineSlice}
            onCheckedChange={(v) =>
              set({ nineSlice: v ? { Left: 0.25, Top: 0.25, Right: 0.25, Bottom: 0.25 } : undefined }, 'ns')
            }
          />
        </FieldRow>
        {image.nineSlice && (
          <FieldRow label="Margin">
            <MarginInput step={0.05} value={image.nineSlice} onChange={(nineSlice) => set({ nineSlice }, 'nsm')} />
          </FieldRow>
        )}
        <div className="px-3 pt-1.5">
          <p className="mb-1 text-[12px] text-subtle">{t('描述（生成用）')}</p>
          <TextInput
            label={t('描述')}
            multiline
            value={image.prompt}
            onChange={(prompt) => set({ prompt }, 'prompt')}
          />
        </div>
        <div className="flex flex-wrap gap-1.5 px-3 pt-2 pb-3">
          <Button
            size="sm"
            onClick={onGenerate}
            disabled={!canGenerate || busy || !image.prompt.trim()}
            title={sourceLabel}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            {image.variants.length ? t('再生成') : t('生成')}
          </Button>
          <input
            ref={input}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) onUpload(f)
              e.target.value = ''
            }}
          />
          <Button size="sm" variant="ghost" onClick={() => input.current?.click()}>
            <Upload className="h-3.5 w-3.5" />
            {t('上传替换')}
          </Button>
        </div>
        {canGenerate && <p className="px-3 pb-3 text-[11px] text-subtle">{sourceLabel}</p>}
      </div>
    </div>
  )
}
