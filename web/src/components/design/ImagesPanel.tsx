import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AlertCircle, ImagePlus, Loader2, RefreshCw, Trash2, Upload, X } from 'lucide-react'
import type { Annotation, AnnotationKind, DesignImage } from '@shared/design'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Switch } from '@/components/ui/switch'
import { Select } from '@/components/ui/input'
import { t } from '@shared/i18n'
import { FieldRow, MarginInput, NumInput, TextInput, Thumb } from './fields'
import { AnnotationLayer, AnnotationToolbar, isMarkTool, type Tool } from './Annotations'
import { AiFixButton } from '@/components/ui/ai-fix'

/** 设计里的一个控件：在哪棵树（空是主界面，否则是子控件名）、id、名字、类型 */
export interface WidgetRef {
  target: string
  id: string
  name: string
  type?: string
}

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
  onPreview,
  usedIds,
  onGenerateAll,
  canGenerate,
  onDragImage,
}: {
  /** 开始 / 结束把图片拖到画布的控件上：画布据此高亮能放的控件 */
  onDragImage?: (img: DesignImage | null) => void
  /** 生成这些还没生成或失败的图 */
  onGenerateAll: (ids: string[]) => void
  canGenerate: boolean
  images: DesignImage[]
  url: (img: DesignImage) => string | undefined
  selected: string
  onSelect: (id: string) => void
  onUpload: (files: File[]) => void
  /** 双击：在左边的画布区域放大看 */
  onPreview: (id: string) => void
  usedIds: Set<string>
}) {
  const input = useRef<HTMLInputElement>(null)
  const [filter, setFilter] = useState<'all' | 'unused' | 'missing' | 'failed'>('all')
  const busy = (i: DesignImage) => i.status === 'generating' || i.status === 'pending'
  const missing = images.filter((i) => !i.variants.length && !busy(i) && i.prompt.trim())
  const failed = images.filter((i) => i.status === 'failed')
  const unused = images.filter((i) => !usedIds.has(i.id))
  const todo = [...new Set([...missing, ...failed])].filter((i) => !busy(i))
  const filters = [
    { id: 'all' as const, label: t('全部'), n: images.length },
    { id: 'unused' as const, label: t('未用'), n: unused.length },
    { id: 'missing' as const, label: t('未生成'), n: missing.length },
    { id: 'failed' as const, label: t('失败'), n: failed.length },
  ]
  const shown = { all: images, unused, missing, failed }[filter]
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
      <Button variant="secondary" size="sm" className="w-full justify-center" onClick={() => input.current?.click()}>
        <Upload className="h-3.5 w-3.5" />
        {t('上传图片')}
      </Button>
      {images.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          {filters
            .filter((f) => f.id === 'all' || f.n > 0 || filter === f.id)
            .map((f) => (
              <button
                key={f.id}
                onClick={() => setFilter(f.id)}
                aria-pressed={filter === f.id}
                className={cn(
                  'h-6 cursor-pointer rounded-md px-2 text-[0.71875rem]',
                  filter === f.id ? 'bg-sel font-medium text-fg' : 'text-subtle hover:text-fg',
                  f.id === 'failed' && f.n > 0 && filter !== f.id && 'text-danger',
                )}
              >
                {f.label} {f.n}
              </button>
            ))}
          {todo.length > 0 && (
            <Button
              variant="link"
              onClick={() => onGenerateAll(todo.map((i) => i.id))}
              disabled={!canGenerate}
              title={t('生成还没生成和失败的图片')}
              className="ml-auto px-1 text-[0.71875rem]"
            >
              <RefreshCw className="h-3 w-3" />
              {t('生成 {n} 张', { n: todo.length })}
            </Button>
          )}
        </div>
      )}
      {!images.length && (
        <p className="px-1 py-4 text-center text-[0.75rem] leading-relaxed text-subtle">
          {t('还没有图片。在右边告诉 AI 想要什么界面，它会列出需要的图片并生成。')}
        </p>
      )}
      <div className="grid grid-cols-2 gap-2">
        {shown.map((i) => (
          <button
            key={i.id}
            onClick={() => onSelect(i.id)}
            onDoubleClick={() => url(i) && onPreview(i.id)}
            title={url(i) ? t('双击放大预览，拖到画布的控件上直接用上') : undefined}
            draggable={!!url(i) && !!onDragImage}
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'copy'
              e.dataTransfer.setData('application/x-design-image', i.id)
              onDragImage?.(i)
            }}
            onDragEnd={() => onDragImage?.(null)}
            className={cn(
              'group flex cursor-pointer flex-col overflow-hidden rounded-lg bg-field text-left transition-colors',
              selected === i.id ? 'ring-2 ring-accent' : 'hover:bg-sel',
            )}
          >
            <span className="relative block">
              <Thumb src={url(i)} className="aspect-square w-full rounded-none border-0" />
              {(i.status === 'generating' || i.status === 'pending') && (
                <span className="absolute inset-0 grid place-items-center bg-scrim text-white">
                  <Loader2 className={cn('h-5 w-5', i.status === 'generating' && 'animate-spin')} />
                </span>
              )}
              {i.status === 'failed' && (
                <span className="absolute top-1 right-1 rounded-full bg-card p-0.5 text-danger" title={i.error}>
                  <AlertCircle className="h-3.5 w-3.5" />
                </span>
              )}
              {i.variants.length > 1 && (
                <span className="absolute bottom-1 left-1 rounded bg-scrim px-1 font-mono text-[0.625rem] text-white">
                  {i.selected + 1}/{i.variants.length}
                </span>
              )}
            </span>
            <span className="flex items-center gap-1 px-1.5 py-1">
              <span className="min-w-0 flex-1 truncate font-mono text-[0.6875rem]">{i.name}</span>
              {!usedIds.has(i.id) && (
                <span className="shrink-0 text-[0.625rem] text-subtle" title={t('设计里没有用到这张图')}>
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
  marks,
  onPreview,
  users,
  candidates,
  onJump,
  onAssign,
}: {
  /** 用到这张图的控件，点一下跳过去 */
  users: WidgetRef[]
  /** 能放这张图的控件（Image、Border、Button），没用到时可以直接用上 */
  candidates: WidgetRef[]
  onJump: (w: WidgetRef) => void
  onAssign: (w: WidgetRef) => void
  /** 在大图上画的修改标记（列在右边对话框上面，发送时按它重新生成） */
  marks: Annotation[]
  /** 打开大图预览（在图上画标记） */
  onPreview: () => void
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
    <div className="text-[0.75rem]">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <ImagePlus className="h-4 w-4 shrink-0 text-accent" />
        <span className="min-w-0 flex-1 truncate font-mono text-[0.78125rem] font-medium">{image.name}</span>
        <IconButton icon={Trash2} tone="danger" label={t('删除图片')} onClick={onDelete} />
      </div>
      {image.variants.length > 0 && (
        <div className="flex gap-1.5 overflow-x-auto border-b p-2">
          {image.variants.map((v, i) => (
            <button
              key={v.file}
              onClick={() => set({ selected: i }, 'sel')}
              title={`${v.width}×${v.height} · ${{ cli: t('图片模型'), browser: t('浏览器'), local: t('本机模型'), upload: t('上传') }[v.source]}`}
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
      <div className="flex flex-wrap items-center gap-1 border-b px-3 py-2">
        {users.length ? (
          <>
            <span className="mr-1 text-[0.71875rem] text-subtle">{t('用在')}</span>
            {users.map((u) => (
              <button
                key={u.id}
                onClick={() => onJump(u)}
                title={u.target ? t('在子控件 {name} 里', { name: u.target }) : undefined}
                className="cursor-pointer rounded bg-sel/70 px-1.5 py-px font-mono text-[0.6875rem] text-muted hover:bg-sel hover:text-fg"
              >
                {u.target ? `${u.target} › ` : ''}
                {u.name}
              </button>
            ))}
          </>
        ) : (
          <>
            <span className="flex-1 text-[0.71875rem] text-warning">{t('设计里还没用到这张图')}</span>
            {candidates.length > 0 && (
              <Select
                aria-label={t('用到控件上')}
                value=""
                onChange={(e) => {
                  const c = candidates.find((x) => x.id === e.target.value)
                  if (c) onAssign(c)
                }}
                options={[
                  { value: '', label: t('用到控件上…') },
                  ...candidates.map((c) => ({
                    value: c.id,
                    label: `${c.name} · ${c.type}`,
                    group: c.target || t('主界面'),
                  })),
                ]}
                className="h-6 w-auto max-w-[180px] rounded-md px-2 text-[0.71875rem]"
              />
            )}
          </>
        )}
      </div>
      {image.status === 'failed' && image.error && (
        <div className="mx-3 mt-2 flex flex-col items-start gap-1.5 rounded-md bg-danger/10 px-2 py-1.5">
          <p className="text-[0.71875rem] leading-relaxed whitespace-pre-wrap text-danger">{image.error}</p>
          <AiFixButton
            variant="ghost"
            className="h-6 px-1.5 text-[0.71875rem]"
            issue={{
              title: t('生成图片失败：{name}', { name: image.name }),
              error: image.error,
              context:
                '这是 Agent 面板 UI 设计里的生成图片（按设置里「生成图片的方式」调用 Agent、API 或本机 ComfyUI）。',
            }}
          />
        </div>
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
          <p className="mb-1 text-[0.75rem] text-subtle">{t('描述（生成用）')}</p>
          <TextInput
            label={t('描述')}
            multiline
            value={image.prompt}
            onChange={(prompt) => set({ prompt }, 'prompt')}
          />
        </div>
        {image.variants.length > 0 && (
          <p className="px-3 pt-2 text-[0.71875rem] leading-relaxed text-subtle">
            {marks.length ? t('图上有 {n} 处标记，', { n: marks.length }) : ''}
            <Button variant="link" onClick={onPreview} className="inline">
              {t('在大图上标记要改的地方')}
            </Button>
            {t('，修改意见写在右边的对话框里发送')}
          </p>
        )}
        <div className="flex flex-wrap gap-1.5 px-3 pt-2 pb-3">
          <Button
            size="sm"
            onClick={onGenerate}
            disabled={!canGenerate || busy || !image.prompt.trim()}
            title={sourceLabel}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            {marks.length ? t('按标记重新生成') : image.variants.length ? t('再生成') : t('生成')}
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
        {canGenerate && <p className="px-3 pb-3 text-[0.6875rem] text-subtle">{sourceLabel}</p>}
      </div>
    </div>
  )
}

/** 透明的地方用灰白方格表示（和 Photoshop、UE 的贴图预览一样） */
export const CHECKER =
  'bg-[#fff] bg-[length:16px_16px] [background-image:conic-gradient(#ccc_25%,#fff_0_50%,#ccc_0_75%,#fff_0)]'

/** 盖在画布区域上的大图预览：可以在图上画修改标记（列在右边对话框上面，写好意见发送就按它重新生成）；点空白处、关闭按钮或按 Esc 关掉 */
export function ImagePreview({
  image,
  src,
  marks,
  onMarks,
  onClose,
}: {
  image: DesignImage
  src: string
  /** 图上的修改标记，坐标是这一版图片的像素 */
  marks: Annotation[]
  onMarks: (list: Annotation[]) => void
  onClose: () => void
}) {
  const [tool, setTool] = useState<Tool>('select')
  const [kind, setKind] = useState<AnnotationKind>('change')
  const [active, setActive] = useState('')
  const [shown, setShown] = useState(true)
  const img = useRef<HTMLImageElement>(null)
  const [scale, setScale] = useState(0)
  const v = image.variants[image.selected] ?? image.variants.at(-1)
  const size = { X: v?.width || image.width, Y: v?.height || image.height }
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea')) return
      if (e.key !== 'Escape') return
      // 先退出标注工具、关掉正在写的说明，再按一次才关掉预览
      if (active) setActive('')
      else if (tool !== 'select') setTool('select')
      else onClose()
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [onClose, tool, active])
  useLayoutEffect(() => {
    const el = img.current
    if (!el) return
    const fit = () => setScale(el.clientWidth / size.X)
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [size.X, src])
  return (
    <div
      role="dialog"
      aria-label={image.name}
      onClick={(e) => e.target === e.currentTarget && tool === 'select' && !active && onClose()}
      className="absolute inset-0 z-30 flex flex-col bg-canvas/95 animate-[fade-in_120ms_ease-out]"
    >
      <div className="flex h-11 shrink-0 items-center gap-2 pr-3 pl-[max(0.75rem,var(--board-switch-w,0px))] text-[0.75rem] text-canvas-fg">
        <span className="font-mono font-medium text-canvas-strong">{image.name}</span>
        <span className="font-mono text-canvas-subtle">
          {size.X}×{size.Y}
          {image.variants.length > 1 && ` · ${image.selected + 1}/${image.variants.length}`}
        </span>
        <span className="flex-1" />
        <Button variant="on-canvas" size="icon-sm" onClick={onClose} aria-label={t('关闭预览')} title={t('关闭预览')}>
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div className="flex shrink-0 justify-center px-3 pb-2">
        <AnnotationToolbar
          tools={['select', 'rect', 'arrow', 'pen', 'pin']}
          tool={tool}
          onTool={(x) => {
            setTool(x)
            if (isMarkTool(x)) setShown(true)
          }}
          kind={kind}
          onKind={(k) => {
            setKind(k)
            if (!isMarkTool(tool)) setTool('rect')
          }}
          count={marks.length}
          visible={shown}
          onToggleVisible={() => setShown((x) => !x)}
          onClear={() => {
            onMarks([])
            setActive('')
          }}
        />
      </div>
      <div
        className="grid min-h-0 flex-1 place-items-center overflow-hidden p-6"
        onClick={(e) => e.target === e.currentTarget && tool === 'select' && !active && onClose()}
      >
        <div className="relative max-h-full max-w-full">
          <img
            ref={img}
            src={src}
            alt={image.name}
            draggable={false}
            className={cn('block max-h-[calc(100dvh-220px)] max-w-full object-contain shadow-canvas', CHECKER)}
          />
          {scale > 0 && (
            <AnnotationLayer
              size={size}
              scale={scale}
              tool={tool}
              kind={kind}
              list={marks}
              visible={shown}
              active={active}
              onActive={setActive}
              onCreate={(a) => {
                const mark: Annotation = { ...a, id: crypto.randomUUID(), note: '', target: '', widgets: [] }
                onMarks([...marks, mark])
                // 画完马上写说明
                setActive(mark.id)
              }}
              onChange={(a) => onMarks(marks.map((x) => (x.id === a.id ? a : x)))}
              onRemove={(id) => {
                onMarks(marks.filter((x) => x.id !== id))
                setActive('')
              }}
            />
          )}
        </div>
      </div>
      {!marks.length && (
        <p className="pointer-events-none shrink-0 pb-3 text-center text-[0.71875rem] text-canvas-subtle">
          {t('选上面的框选、箭头、画笔或打点，在图上标出要改的地方，再在右边的对话框里写修改意见发送')}
        </p>
      )}
    </div>
  )
}
