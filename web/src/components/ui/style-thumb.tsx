import { useState } from 'react'
import { Palette } from 'lucide-react'
import type { SavedStyle } from '@shared/style-types'
import { cn } from '@/lib/utils'
import { t } from '@shared/i18n'
import { Lightbox } from './lightbox'

/**
 * 内置风格的参考图随程序打包（web/src/assets/style-refs/<风格 id>.webp，生成方法见设计稿
 * designs/Blender建模风格-设计稿.md）；自己的风格上传的图存在数据目录，经 /api/styles/<id>/image 取
 */
const BUILTIN_REFS = import.meta.glob('../../assets/style-refs/*.webp', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>
const builtinRef = (id: string) => BUILTIN_REFS[`../../assets/style-refs/${id}.webp`]

/** 风格参考图的地址；没有图时为空 */
export function styleImageSrc(s: Pick<SavedStyle, 'id' | 'builtin' | 'image' | 'updatedAt'>): string {
  if (s.builtin) return builtinRef(s.id) ?? ''
  // 换了图地址跟着变（文件名里带了时间），浏览器不会拿旧图
  return s.image ? `/api/styles/${encodeURIComponent(s.id)}/image?v=${encodeURIComponent(s.image)}` : ''
}

/**
 * 风格的参考图缩略图：点开在页面上看大图（Lightbox）。没有图时画一个调色板图标占位、不能点。
 * size：sm 列表行里（宽度可在设置里调）、md 卡片里（96×60）、lg 选择器顶上的大图（撑满宽度，16:10）
 */
export function StyleThumb({
  style,
  size = 'md',
  className,
}: {
  style: Pick<SavedStyle, 'id' | 'name' | 'builtin' | 'image' | 'updatedAt'>
  size?: 'sm' | 'md' | 'lg'
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const src = styleImageSrc(style)
  const box = cn(
    'relative shrink-0 overflow-hidden rounded-(--c-styleRef-radius) bg-field',
    size === 'sm' && 'aspect-[16/10] w-(--c-styleRef-thumbW)',
    size === 'md' && 'h-[60px] w-24',
    size === 'lg' && 'aspect-[16/10] w-full',
    className,
  )
  if (!src)
    return (
      <span className={cn(box, 'grid place-items-center text-subtle')} aria-hidden>
        <Palette className="h-4 w-4" />
      </span>
    )
  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          // 缩略图常放在可点的行里（选风格）：看大图不顺带选中
          e.stopPropagation()
          setOpen(true)
        }}
        title={t('查看「{name}」的参考图', { name: style.name })}
        aria-label={t('查看「{name}」的参考图', { name: style.name })}
        className={cn(box, 'cursor-zoom-in ring-line/60 transition-shadow hover:ring-2')}
      >
        <img src={src} alt="" loading="lazy" draggable={false} className="h-full w-full object-cover" />
      </button>
      <Lightbox images={[{ src, name: style.name }]} index={open ? 0 : undefined} onClose={() => setOpen(false)} />
    </>
  )
}
