import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignStartVertical,
  ImageOff,
  StretchHorizontal,
  StretchVertical,
} from 'lucide-react'
import { parseColor, type Brush, type ImageFit, type Margin, type Vec2 } from '@shared/umg'
import type { DesignImage } from '@shared/design'
import { cn } from '@/lib/utils'
import { Select } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/menu'
import { t } from '@shared/i18n'

/** 属性面板里的小号控件：一行一个属性，左边名字、右边值，参照 UE 的 Details 面板 */

export const getPath = (o: any, path: string) => path.split('.').reduce((x, k) => x?.[k], o)
export function setPath<T>(o: T, path: string, v: unknown): T {
  const [k, ...rest] = path.split('.')
  const cur = (o as any) ?? {}
  return { ...cur, [k]: rest.length ? setPath(cur[k], rest.join('.'), v) : v }
}

const box =
  'h-7 w-full min-w-0 rounded-md border border-line bg-field px-1.5 text-[0.75rem] text-fg outline-none focus:border-focus'

export function FieldRow({
  label,
  children,
  title,
  leading,
}: {
  label: string
  children: React.ReactNode
  title?: string
  /** 属性名左边的按钮（UE 的关键帧菱形） */
  leading?: React.ReactNode
}) {
  return (
    <div data-field={label} className="flex min-h-8 items-center gap-2 px-3 py-0.5">
      {leading}
      {/* 固定宽度让右侧控件上下对齐，名字长时换行显示完整，不截断 */}
      <span title={title ?? label} className="w-[104px] shrink-0 text-[0.75rem] leading-tight break-words text-subtle">
        {label}
      </span>
      <div className="flex min-w-0 flex-1 items-center gap-1">{children}</div>
    </div>
  )
}

/** 数字：失去焦点或回车时提交，支持上下键微调 */
export function NumInput({
  value,
  onChange,
  step = 1,
  min,
  max,
  prefix,
  label,
}: {
  value: number
  onChange: (v: number) => void
  step?: number
  min?: number
  max?: number
  prefix?: string
  label?: string
}) {
  const [text, setText] = useState(String(value ?? 0))
  useEffect(() => setText(String(+(value ?? 0).toFixed(4))), [value])
  const commit = (s: string) => {
    const n = Number(s)
    if (!Number.isFinite(n)) return setText(String(value))
    const c = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n))
    if (c !== value) onChange(c)
    else setText(String(c))
  }
  return (
    <label className="relative flex min-w-0 flex-1 items-center">
      {prefix && (
        <span className="pointer-events-none absolute left-1.5 font-mono text-[0.625rem] text-subtle/80">{prefix}</span>
      )}
      <input
        aria-label={label ?? prefix}
        value={text}
        inputMode="decimal"
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit(e.currentTarget.value)
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault()
            const n = (Number(text) || 0) + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1)
            commit(String(+n.toFixed(4)))
          }
        }}
        className={cn(box, 'font-mono tabular-nums', prefix && 'pl-4')}
      />
    </label>
  )
}

export function TextInput({
  value,
  onChange,
  multiline,
  label,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  multiline?: boolean
  label: string
  placeholder?: string
}) {
  const [text, setText] = useState(value ?? '')
  useEffect(() => setText(value ?? ''), [value])
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null)
  // 多行时高度跟着内容走（最高 320px，再多就滚动）：长的描述不用拖拽就能看全；面板拉宽拉窄也重新算
  useLayoutEffect(() => {
    const el = ref.current
    if (!multiline || !el) return
    const fit = () => {
      el.style.height = 'auto'
      el.style.height = `${Math.min(320, el.scrollHeight + el.offsetHeight - el.clientHeight)}px`
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [multiline, text])
  const Tag = multiline ? 'textarea' : 'input'
  return (
    <Tag
      ref={ref}
      aria-label={label}
      placeholder={placeholder}
      value={text}
      rows={multiline ? 2 : undefined}
      onChange={(e: any) => setText(e.target.value)}
      onBlur={() => text !== value && onChange(text)}
      onKeyDown={(e: any) => {
        if (e.key === 'Enter' && (!multiline || e.ctrlKey || e.metaKey)) e.currentTarget.blur()
      }}
      className={cn(box, multiline && 'h-auto resize-none overflow-y-auto py-1 leading-snug')}
    />
  )
}

export function Vec2Input({
  value,
  onChange,
  labels = ['X', 'Y'],
  step,
}: {
  value: Vec2
  onChange: (v: Vec2) => void
  labels?: [string, string]
  step?: number
}) {
  const v = value ?? { X: 0, Y: 0 }
  return (
    <>
      <NumInput prefix={labels[0]} step={step} value={v.X} onChange={(X) => onChange({ ...v, X })} />
      <NumInput prefix={labels[1]} step={step} value={v.Y} onChange={(Y) => onChange({ ...v, Y })} />
    </>
  )
}

export function MarginInput({
  value,
  onChange,
  step,
}: {
  value: Margin
  onChange: (v: Margin) => void
  step?: number
}) {
  const v = value ?? { Left: 0, Top: 0, Right: 0, Bottom: 0 }
  return (
    <div className="grid w-full grid-cols-4 gap-1">
      {(['Left', 'Top', 'Right', 'Bottom'] as const).map((k) => (
        <NumInput
          key={k}
          prefix={k[0]}
          label={k}
          step={step}
          value={v[k]}
          onChange={(n) => onChange({ ...v, [k]: n })}
        />
      ))}
    </div>
  )
}

const hex2 = (n: number) =>
  Math.round(n * 255)
    .toString(16)
    .padStart(2, '0')
    .toUpperCase()

/** 颜色：色块（系统取色器）+ 十六进制 + 不透明度 */
export function ColorInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [r, g, b, a] = parseColor(value)
  const rgb = `#${hex2(r)}${hex2(g)}${hex2(b)}`
  const [text, setText] = useState(String(value ?? ''))
  useEffect(() => setText(String(value ?? '')), [value])
  return (
    <>
      <label
        className="relative h-7 w-7 shrink-0 cursor-pointer overflow-hidden rounded-md border border-line bg-[length:8px_8px] [background-image:conic-gradient(#ccc_25%,#fff_0_50%,#ccc_0_75%,#fff_0)]"
        title={t('选择颜色')}
      >
        <span className="absolute inset-0" style={{ background: `rgba(${r * 255},${g * 255},${b * 255},${a})` }} />
        <input
          type="color"
          value={rgb.toLowerCase()}
          onChange={(e) => onChange(`${e.target.value.toUpperCase()}${hex2(a)}`)}
          className="absolute inset-0 cursor-pointer opacity-0"
          aria-label={t('选择颜色')}
        />
      </label>
      <input
        aria-label={t('颜色')}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const v = text.trim().toUpperCase()
          const ok = /^#?[0-9A-F]{6}([0-9A-F]{2})?$/.test(v)
          if (!ok) return setText(value)
          const h = v.startsWith('#') ? v : `#${v}`
          onChange(h.length === 7 ? `${h}FF` : h)
        }}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        className={cn(box, 'flex-1 font-mono uppercase')}
      />
      <div className="w-[52px] shrink-0">
        <NumInput
          prefix="A"
          label={t('不透明度')}
          step={0.05}
          min={0}
          max={1}
          value={+a.toFixed(3)}
          onChange={(n) => onChange(`${rgb}${hex2(n)}`)}
        />
      </div>
    </>
  )
}

export function EnumInput({
  value,
  options,
  onChange,
  label,
}: {
  value: string
  options: string[]
  onChange: (v: string) => void
  label: string
}) {
  return (
    <Select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      options={options.map((o) => ({ value: o, label: o }))}
      className="h-7 rounded-md px-2 text-[0.75rem]"
    />
  )
}

export function BoolInput({
  value,
  onChange,
  label,
}: {
  value: boolean
  onChange: (v: boolean) => void
  label: string
}) {
  return <Switch aria-label={label} checked={!!value} onCheckedChange={onChange} />
}

const H_OPTS = [
  { id: 'HAlign_Left', icon: AlignStartVertical, label: t('左对齐') },
  { id: 'HAlign_Center', icon: AlignCenterVertical, label: t('水平居中') },
  { id: 'HAlign_Right', icon: AlignEndVertical, label: t('右对齐') },
  { id: 'HAlign_Fill', icon: StretchHorizontal, label: t('水平填充') },
]
const V_OPTS = [
  { id: 'VAlign_Top', icon: AlignStartHorizontal, label: t('顶部对齐') },
  { id: 'VAlign_Center', icon: AlignCenterHorizontal, label: t('垂直居中') },
  { id: 'VAlign_Bottom', icon: AlignEndHorizontal, label: t('底部对齐') },
  { id: 'VAlign_Fill', icon: StretchVertical, label: t('垂直填充') },
]

/** 对齐方式：和 UE 一样四个图标按钮 */
export function AlignInput({
  axis,
  value,
  onChange,
}: {
  axis: 'h' | 'v'
  value: string
  onChange: (v: string) => void
}) {
  const opts = axis === 'h' ? H_OPTS : V_OPTS
  return (
    <div role="radiogroup" className="flex rounded-md border border-line bg-field p-px">
      {opts.map((o) => (
        <button
          key={o.id}
          role="radio"
          aria-checked={value === o.id}
          aria-label={o.label}
          title={`${o.label}（${o.id}）`}
          onClick={() => onChange(o.id)}
          className={cn(
            'grid h-6 w-7 cursor-pointer place-items-center rounded-[5px]',
            value === o.id ? 'bg-accent-soft text-accent' : 'text-subtle hover:text-fg',
          )}
        >
          <o.icon className="h-3.5 w-3.5" />
        </button>
      ))}
    </div>
  )
}

/** 图片选择：缩略图按钮，点开列出设计里的图片 */
export function ImagePick({
  value,
  images,
  url,
  onChange,
}: {
  value: string
  images: DesignImage[]
  url: (img: DesignImage) => string | undefined
  onChange: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const id = value?.startsWith('img:') ? value.slice(4) : ''
  const cur = images.find((i) => i.id === id)
  const src = cur && url(cur)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md border border-line bg-field px-1 text-left text-[0.75rem] hover:border-line-strong">
          <Thumb src={src} className="h-6 w-6" />
          <span className={cn('min-w-0 flex-1 truncate', !cur && 'text-subtle')}>
            {cur ? cur.name : id ? t('图片不存在') : t('无图片（纯色）')}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="max-h-[320px] w-[240px] overflow-y-auto p-1">
        <button
          onClick={() => (onChange(''), setOpen(false))}
          className="flex h-9 w-full cursor-pointer items-center gap-2 rounded-md px-1.5 text-left text-[0.78125rem] hover:bg-sel"
        >
          <span className="grid h-7 w-7 place-items-center rounded border border-dashed border-line-strong">
            <ImageOff className="h-3.5 w-3.5 text-subtle" />
          </span>
          {t('无图片（纯色）')}
        </button>
        {images.map((i) => (
          <button
            key={i.id}
            onClick={() => (onChange(`img:${i.id}`), setOpen(false))}
            className={cn(
              'flex h-9 w-full cursor-pointer items-center gap-2 rounded-md px-1.5 text-left text-[0.78125rem] hover:bg-sel',
              i.id === id && 'bg-accent-soft',
            )}
          >
            <Thumb src={url(i)} className="h-7 w-7" />
            <span className="min-w-0 flex-1 truncate">{i.name}</span>
            <span className="font-mono text-[0.65625rem] text-subtle">
              {i.width}×{i.height}
            </span>
          </button>
        ))}
        {!images.length && (
          <p className="px-2 py-2 text-xs text-subtle">{t('还没有图片：在「图片」里上传或让 AI 生成。')}</p>
        )}
      </PopoverContent>
    </Popover>
  )
}

/** 图片缩略图：透明的地方用灰白方格表示，一眼能看出哪里是透明的 */
export function Thumb({ src, className }: { src?: string; className?: string }) {
  return (
    <span
      className={cn(
        'grid shrink-0 place-items-center overflow-hidden rounded border border-line',
        src
          ? 'bg-[#fff] bg-[length:12px_12px] [background-image:conic-gradient(#ccc_25%,#fff_0_50%,#ccc_0_75%,#fff_0)]'
          : 'bg-sel',
        className,
      )}
    >
      {src ? <img src={src} alt="" className="max-h-full max-w-full object-contain" /> : null}
    </span>
  )
}

/** 画刷：图片、绘制方式、尺寸、九宫格边距、颜色 */
export function BrushInput({
  value,
  onChange,
  images,
  url,
}: {
  value: Brush
  onChange: (b: Brush) => void
  images: DesignImage[]
  url: (img: DesignImage) => string | undefined
}) {
  const b = value ?? ({} as Brush)
  const set = (patch: Partial<Brush>) => onChange({ ...b, ...patch })
  const showMargin = b.DrawAs === 'Box' || b.DrawAs === 'Border'
  return (
    <div className="flex w-full flex-col gap-1">
      <div className="flex items-center gap-1">
        <ImagePick
          value={b.ResourceObject}
          images={images}
          url={url}
          onChange={(v) => {
            // 选了图片：尺寸、九宫格跟着图片的设置走
            const img = images.find((i) => `img:${i.id}` === v)
            if (!img) return set({ ResourceObject: v })
            const ns = img.nineSlice
            set({
              ResourceObject: v,
              ImageSize: { X: img.width, Y: img.height },
              // 九宫格图自动按 Box 拉伸：ImageFit 在这里用不上，和切 DrawAs 时一样清掉
              ...(ns ? { DrawAs: 'Box', Margin: ns, ImageFit: undefined } : {}),
            })
          }}
        />
      </div>
      <div className="flex items-center gap-1">
        <span className="w-12 shrink-0 text-[0.6875rem] text-subtle">DrawAs</span>
        <EnumInput
          label="DrawAs"
          value={b.DrawAs ?? 'Image'}
          options={['Image', 'Box', 'Border', 'RoundedBox', 'NoDrawType']}
          onChange={(v) => {
            const next: Brush = { ...b, DrawAs: v as Brush['DrawAs'] }
            // 九宫格、平铺不用 ImageFit，切过去时清掉，免得留下面板上看不到的属性
            if (v !== 'Image') delete next.ImageFit
            onChange(next)
          }}
        />
      </div>
      {/* 旧数据不写 DrawAs，按 Image 算，和上面的下拉显示保持一致 */}
      {(b.DrawAs ?? 'Image') === 'Image' && (
        <div className="flex items-center gap-1">
          <span className="w-12 shrink-0 text-[0.6875rem] text-subtle">Fit</span>
          <EnumInput
            label="ImageFit"
            value={b.ImageFit ?? 'Fill'}
            options={['Fill', 'Contain', 'Cover', 'Original']}
            onChange={(v) => {
              // Fill 就是旧数据的默认行为，不写进属性里，和以前的设计保持一致
              if (v === 'Fill') {
                const { ImageFit: _, ...rest } = b
                onChange(rest)
              } else onChange({ ...b, ImageFit: v as ImageFit })
            }}
          />
        </div>
      )}
      <div className="flex items-center gap-1">
        <span className="w-12 shrink-0 text-[0.6875rem] text-subtle">Size</span>
        <Vec2Input value={b.ImageSize} onChange={(ImageSize) => set({ ImageSize })} />
      </div>
      {showMargin && (
        <div className="flex items-center gap-1">
          <span className="w-12 shrink-0 text-[0.6875rem] text-subtle">Margin</span>
          <MarginInput step={0.05} value={b.Margin} onChange={(Margin) => set({ Margin })} />
        </div>
      )}
      <div className="flex items-center gap-1">
        <span className="w-12 shrink-0 text-[0.6875rem] text-subtle">Tint</span>
        <ColorInput value={b.TintColor} onChange={(TintColor) => set({ TintColor })} />
      </div>
    </div>
  )
}
