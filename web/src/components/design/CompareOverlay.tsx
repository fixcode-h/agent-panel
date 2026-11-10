import { useRef, useState } from 'react'
import { t } from '@shared/i18n'

export type CompareMode = 'blend' | 'slider'

/**
 * 把原画盖在画布上对照：叠加是半透明盖一层；滑块是左边原画、右边还原的界面，拖中间的竖线左右看，
 * 位置、Icon 差在哪里一眼看得出来（Figma Dev Mode / 图片对比工具的做法）。
 * 盖在画布同一个坐标系里（和画布一样大），所以原画的宽高比要和设计稿一致
 */
export function CompareOverlay({ src, mode }: { src: string; mode: CompareMode }) {
  const [pos, setPos] = useState(50)
  const box = useRef<HTMLDivElement>(null)
  if (mode === 'blend')
    return (
      <img
        src={src}
        alt=""
        draggable={false}
        className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-40"
      />
    )
  const drag = (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const el = box.current
    if (!el) return
    const move = (ev: PointerEvent) => {
      const r = el.getBoundingClientRect()
      setPos(Math.max(0, Math.min(100, ((ev.clientX - r.left) / Math.max(1, r.width)) * 100)))
    }
    move(e.nativeEvent)
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return (
    <div ref={box} data-compare-slider className="pointer-events-none absolute inset-0">
      <img
        src={src}
        alt=""
        draggable={false}
        className="absolute inset-0 h-full w-full object-cover"
        style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}
      />
      <span className="absolute top-2 left-2 rounded-sm bg-black/60 px-1.5 text-caption text-white">{t('原画')}</span>
      <span className="absolute top-2 right-2 rounded-sm bg-black/60 px-1.5 text-caption text-white">{t('还原')}</span>
      <div
        role="slider"
        aria-label={t('拖动对照原画和还原')}
        aria-valuenow={Math.round(pos)}
        aria-valuemin={0}
        aria-valuemax={100}
        tabIndex={0}
        onPointerDown={drag}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') setPos((p) => Math.max(0, p - 2))
          if (e.key === 'ArrowRight') setPos((p) => Math.min(100, p + 2))
        }}
        className="pointer-events-auto absolute top-0 bottom-0 w-4 -translate-x-1/2 cursor-ew-resize"
        style={{ left: `${pos}%` }}
      >
        <div className="absolute top-0 bottom-0 left-1/2 w-0.5 -translate-x-1/2 bg-white shadow-[0_0_4px_rgba(0,0,0,0.6)]" />
        <div className="absolute top-1/2 left-1/2 flex h-6 w-6 -translate-1/2 items-center justify-center rounded-full bg-white text-caption text-black shadow-pop">
          ⇆
        </div>
      </div>
    </div>
  )
}
