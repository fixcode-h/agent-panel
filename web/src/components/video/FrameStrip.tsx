// 截帧弹窗画面下方那排截下来的帧（像剪辑软件的胶片条）：点一张在上面看，双击全屏看大图，左上角勾选决定发不发，悬停出删除。
// 缩略图下沿写时间，右下角标「手动 / 增强 / 标注」；增强时正在处理的盖一层转圈，排队的标「等待」，做完的打勾。
// 上面一行是张数、选中几张和全选 / 全不选（用户 2026-11-07 要的重新设计：画面要大，帧条压成一行窄条）
import { Check, Loader2, PenLine, X } from 'lucide-react'
import { timeText, type VideoFrame } from '@shared/video'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { frameUrl } from '@/lib/video-api'

/** 批量增强时每张帧的状态 */
export interface Working {
  running: Set<string>
  queued: Set<string>
  finished: Set<string>
}
export const IDLE: Working = { running: new Set(), queued: new Set(), finished: new Set() }

export function FrameStrip({
  frames,
  viewId,
  skipped,
  original,
  working,
  onView,
  onZoom,
  onToggle,
  onAll,
  onRemove,
}: {
  frames: VideoFrame[]
  viewId: string | null
  skipped: Set<string>
  original: boolean
  working: Working
  onView: (f: VideoFrame) => void
  /** 双击：全屏看大图 */
  onZoom: (f: VideoFrame) => void
  onToggle: (f: VideoFrame) => void
  /** 全选 / 全不选 */
  onAll: (on: boolean) => void
  onRemove: (f: VideoFrame) => void
}) {
  const chosen = frames.filter((f) => !skipped.has(f.id)).length
  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-t border-line bg-panel px-3 pt-2 pb-2.5">
      <div className="flex h-5 items-center gap-2 text-footnote">
        <span className="font-medium text-fg">{t('截下来的帧')}</span>
        {frames.length > 0 && (
          <>
            <span className="text-subtle tabular-nums">
              {t('{n} 张，选中 {m} 张', { n: frames.length, m: chosen })}
            </span>
            <span className="flex-1" />
            <button
              type="button"
              className="cursor-pointer rounded px-1 text-muted hover:text-fg"
              onClick={() => onAll(chosen < frames.length)}
            >
              {chosen < frames.length ? t('全选') : t('全不选')}
            </button>
          </>
        )}
      </div>
      {!frames.length ? (
        <div className="grid h-[72px] place-items-center rounded-lg border border-dashed border-line-strong px-4 text-center text-footnote text-subtle">
          {t('还没有截帧：播放到要看的地方点「截取当前帧」（K），或者在右边点「自动截帧」')}
        </div>
      ) : (
        <div className="flex gap-1.5 overflow-x-auto pb-0.5" role="list" aria-label={t('截下来的帧')}>
          {frames.map((f) => {
            const on = !skipped.has(f.id)
            const file = f.enhanced && !original ? f.enhanced.file : f.file
            const doing = working.running.has(f.id)
            return (
              <div key={f.id} role="listitem" className="group relative h-[72px] w-[128px] shrink-0">
                <button
                  type="button"
                  onClick={() => onView(f)}
                  onDoubleClick={() => onZoom(f)}
                  aria-label={t('看 {time} 的帧', { time: timeText(f.time) })}
                  title={t('双击看大图')}
                  className={cn(
                    'relative h-full w-full cursor-pointer overflow-hidden rounded-md bg-black outline-offset-1 transition-[opacity,box-shadow]',
                    viewId === f.id || doing ? 'ring-2 ring-accent' : 'ring-1 ring-line hover:ring-line-strong',
                    !on && 'opacity-40 hover:opacity-70',
                  )}
                >
                  <img src={frameUrl(file, true)} alt="" className="h-full w-full object-cover" loading="lazy" />
                  <span className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end gap-1 bg-gradient-to-t from-black/75 to-transparent px-1.5 pt-4 pb-1">
                    <span className="font-mono text-micro leading-none text-white tabular-nums">
                      {timeText(f.time)}
                    </span>
                    <span className="flex-1" />
                    {f.shapes?.length ? <PenLine className="h-3 w-3 text-white" aria-label={t('有标注')} /> : null}
                    {f.enhanced && !original && (
                      <span className="rounded-sm bg-white/20 px-1 text-micro leading-3.5 text-white">{t('增强')}</span>
                    )}
                    {f.source === 'manual' && (
                      <span className="rounded-sm bg-accent px-1 text-micro leading-3.5 text-white">{t('手动')}</span>
                    )}
                  </span>
                  {doing && (
                    <span className="absolute inset-0 flex items-center justify-center gap-1 bg-black/55 text-micro text-white">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      {t('处理中')}
                    </span>
                  )}
                  {working.queued.has(f.id) && (
                    <span className="absolute top-1 right-1 rounded-sm bg-black/65 px-1 text-micro leading-4 text-white">
                      {t('等待')}
                    </span>
                  )}
                  {working.finished.has(f.id) && (
                    <span className="absolute top-1 right-1 grid h-4 w-4 place-items-center rounded-full bg-success text-white">
                      <Check className="h-3 w-3" strokeWidth={3} />
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  aria-label={t('发送 {time} 的帧', { time: timeText(f.time) })}
                  title={on ? t('发送这一帧（点一下不发）') : t('不发这一帧（点一下发送）')}
                  onClick={() => onToggle(f)}
                  className={cn(
                    'absolute top-1 left-1 grid h-4 w-4 cursor-pointer place-items-center rounded-sm border shadow-sm',
                    on ? 'border-accent bg-accent text-on-accent' : 'border-white/80 bg-black/40',
                  )}
                >
                  {on && <Check className="h-3 w-3" strokeWidth={3} />}
                </button>
                {!working.queued.has(f.id) && !working.finished.has(f.id) && (
                  <button
                    type="button"
                    onClick={() => onRemove(f)}
                    aria-label={t('删除这一帧')}
                    title={t('删除这一帧')}
                    className="absolute top-1 right-1 grid h-5 w-5 cursor-pointer place-items-center rounded-full bg-black/65 text-white opacity-0 group-hover:opacity-100 hover:bg-black/85 focus-visible:opacity-100"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
