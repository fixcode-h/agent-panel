import { X } from 'lucide-react'
import type { LayoutRegion } from '@shared/design'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'

/**
 * 版式拆解的区块画在模板图上：拖动整块移动，拖右下角改大小，点名字改名，选中后可以删。
 * 坐标存的是设计稿像素，k 是「屏幕像素 / 设计稿像素」。确认之后只读显示（淡一点），不挡标注
 */
export function RegionEditor({
  regions,
  k,
  designSize,
  editable,
  active,
  onActive,
  onChange,
}: {
  regions: LayoutRegion[]
  k: number
  designSize: { X: number; Y: number }
  editable: boolean
  active: string
  onActive: (id: string) => void
  onChange: (regions: LayoutRegion[], key: string) => void
}) {
  const clamp = (g: LayoutRegion): LayoutRegion => {
    const w = Math.max(8, Math.min(Math.round(g.w), designSize.X))
    const h = Math.max(8, Math.min(Math.round(g.h), designSize.Y))
    return {
      ...g,
      w,
      h,
      x: Math.max(0, Math.min(Math.round(g.x), designSize.X - w)),
      y: Math.max(0, Math.min(Math.round(g.y), designSize.Y - h)),
    }
  }
  const drag = (e: React.PointerEvent, g: LayoutRegion, mode: 'move' | 'resize') => {
    if (!editable) return
    e.preventDefault()
    e.stopPropagation()
    onActive(g.id)
    const sx = e.clientX
    const sy = e.clientY
    const key = `layout:${mode}:${g.id}:${Date.now()}`
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - sx) / k
      const dy = (ev.clientY - sy) / k
      const next = mode === 'move' ? { ...g, x: g.x + dx, y: g.y + dy } : { ...g, w: g.w + dx, h: g.h + dy }
      onChange(
        regions.map((x) => (x.id === g.id ? clamp(next) : x)),
        key,
      )
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return (
    <div className={cn('absolute inset-0', !editable && 'pointer-events-none')} data-region-editor>
      {regions.map((g) => {
        const on = editable && g.id === active
        return (
          <div
            key={g.id}
            data-region={g.name}
            onPointerDown={(e) => drag(e, g, 'move')}
            className={cn(
              'absolute rounded-sm border-2 border-dashed',
              editable ? 'cursor-move border-accent bg-accent/10' : 'border-accent/45',
              on && 'border-solid bg-accent/15',
            )}
            style={{ left: g.x * k, top: g.y * k, width: g.w * k, height: g.h * k }}
            title={g.note || g.name}
          >
            <span
              className={cn(
                'absolute left-0 flex max-w-[16rem] items-center gap-1 rounded-sm px-1 py-px text-caption whitespace-nowrap',
                // 贴着图片顶边的区块：名字放进框里，不然被图片边缘切掉
                g.y * k < 22 ? 'top-0' : '-top-[1.4rem]',
                editable ? 'bg-accent text-on-primary' : 'bg-accent/60 text-on-primary',
              )}
            >
              {on ? (
                <input
                  aria-label={t('区块名')}
                  value={g.name}
                  onPointerDown={(e) => e.stopPropagation()}
                  onChange={(e) =>
                    onChange(
                      regions.map((x) =>
                        x.id === g.id ? { ...x, name: e.target.value.replace(/[^A-Za-z0-9_]/g, '') || x.name } : x,
                      ),
                      `layout:name:${g.id}`,
                    )
                  }
                  className="w-28 bg-transparent font-mono outline-none"
                />
              ) : (
                <span className="truncate font-mono">{g.name}</span>
              )}
              {on && (
                <button
                  type="button"
                  aria-label={t('删除区块 {name}', { name: g.name })}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() =>
                    onChange(
                      regions.filter((x) => x.id !== g.id),
                      `layout:rm:${g.id}`,
                    )
                  }
                  className="cursor-pointer opacity-80 hover:opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </span>
            {editable && (
              <span
                aria-hidden
                onPointerDown={(e) => drag(e, g, 'resize')}
                className="absolute -right-1.5 -bottom-1.5 h-3 w-3 cursor-nwse-resize rounded-sm border border-white bg-accent"
              />
            )}
          </div>
        )
      })}
    </div>
  )
}
