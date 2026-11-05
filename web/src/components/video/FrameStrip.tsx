// 截帧弹窗下面那排截下来的帧：点一张在上面看，双击全屏看大图（能缩放、拖动），勾选决定发不发，悬停出删除。
// 手动截的帧角上标「手动」（强调色），增强过的标「增强」，并默认显示增强图；增强时正在处理的那张盖一层转圈，排队的标「等待」
import { Check, Loader2, X } from 'lucide-react'
import { timeText, type VideoFrame } from '@shared/video'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { frameUrl } from '@/lib/video-api'

export function FrameStrip({
  frames,
  viewId,
  skipped,
  original,
  working,
  onView,
  onZoom,
  onToggle,
  onRemove,
}: {
  frames: VideoFrame[]
  viewId: string | null
  skipped: Set<string>
  original: boolean
  /** 增强时：正在处理的那张和排队的 */
  working: { cur: string | null; queued: Set<string> }
  onView: (f: VideoFrame) => void
  /** 双击：全屏看大图 */
  onZoom: (f: VideoFrame) => void
  onToggle: (f: VideoFrame) => void
  onRemove: (f: VideoFrame) => void
}) {
  if (!frames.length)
    return (
      <div
        className="rounded-xl border border-dashed border-line-strong px-4 py-5 text-center text-body text-subtle"
        data-surface=""
      >
        {t('还没有截帧：播放到要看的地方点「截取当前帧」（K），或者点「自动截帧」')}
      </div>
    )
  return (
    <div className="flex gap-2 overflow-x-auto pb-1" role="list" aria-label={t('截下来的帧')}>
      {frames.map((f) => {
        const on = !skipped.has(f.id)
        const file = f.enhanced && !original ? f.enhanced.file : f.file
        const doing = working.cur === f.id
        return (
          <div key={f.id} role="listitem" className="group relative flex w-[136px] shrink-0 flex-col gap-1">
            <button
              type="button"
              onClick={() => onView(f)}
              onDoubleClick={() => onZoom(f)}
              aria-label={t('看 {time} 的帧', { time: timeText(f.time) })}
              title={t('双击看大图')}
              className={cn(
                'relative aspect-video w-full cursor-pointer overflow-hidden rounded-lg border bg-black',
                doing
                  ? 'border-accent ring-2 ring-accent/60'
                  : viewId === f.id
                    ? 'border-accent ring-2 ring-accent/40'
                    : 'border-line',
                !on && 'opacity-45',
              )}
            >
              <img src={frameUrl(file, true)} alt="" className="h-full w-full object-contain" loading="lazy" />
              <span
                className={cn(
                  'absolute top-1 left-1 rounded-sm px-1 text-micro leading-4 text-white',
                  f.source === 'manual' ? 'bg-accent' : 'bg-black/60',
                )}
              >
                {f.source === 'manual' ? t('手动') : t('自动')}
              </span>
              {f.enhanced && !original && (
                <span className="absolute bottom-1 left-1 rounded-sm bg-black/60 px-1 text-micro leading-4 text-white">
                  {t('增强')}
                </span>
              )}
              {doing && (
                <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/55 text-micro text-white">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('处理中')}
                </span>
              )}
              {working.queued.has(f.id) && (
                <span className="absolute right-1 bottom-1 rounded-sm bg-black/60 px-1 text-micro leading-4 text-white">
                  {t('等待')}
                </span>
              )}
            </button>
            <div className="flex items-center gap-1">
              <button
                type="button"
                role="checkbox"
                aria-checked={on}
                aria-label={t('发送 {time} 的帧', { time: timeText(f.time) })}
                onClick={() => onToggle(f)}
                className={cn(
                  'grid h-4 w-4 cursor-pointer place-items-center rounded-sm border',
                  on ? 'border-primary bg-primary text-on-primary' : 'border-line-strong bg-field',
                )}
              >
                {on && <Check className="h-3 w-3" strokeWidth={3} />}
              </button>
              <span className="font-mono text-footnote text-muted tabular-nums">{timeText(f.time)}</span>
              <button
                type="button"
                onClick={() => onRemove(f)}
                aria-label={t('删除这一帧')}
                title={t('删除这一帧')}
                className="ml-auto grid h-5 w-5 cursor-pointer place-items-center rounded-md text-subtle opacity-0 group-hover:opacity-100 hover:bg-hover hover:text-fg focus-visible:opacity-100"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
