import { useEffect, useState } from 'react'
import * as D from '@radix-ui/react-dialog'
import { ChevronLeft, ChevronRight, Download, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { t } from '@shared/i18n'

export interface LightboxImage {
  src: string
  name: string
}

/**
 * 看大图：在页面上弹出来，不另开标签页（和 Claude Code 一样）。
 * 点空白处或按 Esc 关掉，多张图时左右键切换
 */
export function Lightbox({
  images,
  index,
  onClose,
}: {
  images: LightboxImage[]
  /** 打开哪一张；undefined 时关着 */
  index: number | undefined
  onClose: () => void
}) {
  const [i, setI] = useState(index ?? 0)
  useEffect(() => {
    if (index !== undefined) setI(index)
  }, [index])
  const n = images.length
  const go = (d: number) => setI((x) => (x + d + n) % n)
  const cur = images[Math.min(i, n - 1)]
  return (
    <D.Root open={index !== undefined && !!cur} onOpenChange={(o) => !o && onClose()}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-[60] bg-black/80 animate-[fade-in_120ms_ease-out]" />
        <D.Content
          aria-describedby={undefined}
          onKeyDown={(e) => {
            if (n < 2) return
            if (e.key === 'ArrowLeft') go(-1)
            if (e.key === 'ArrowRight') go(1)
          }}
          // 点图片以外的地方关掉
          onClick={(e) => e.target === e.currentTarget && onClose()}
          className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-3 p-6 outline-none animate-[pop-in_140ms_ease-out]"
        >
          <D.Title className="sr-only">{cur?.name}</D.Title>
          {cur && (
            <img
              src={cur.src}
              alt={cur.name}
              draggable={false}
              className="max-h-[calc(100vh-120px)] max-w-[calc(100vw-48px)] rounded-lg object-contain shadow-2xl md:max-w-[calc(100vw-160px)]"
            />
          )}
          <div className="flex max-w-full items-center gap-3 text-[0.78125rem] text-white/75">
            <span className="min-w-0 truncate">{cur?.name}</span>
            {n > 1 && (
              <span className="shrink-0 font-mono text-white/50 tabular-nums">
                {i + 1} / {n}
              </span>
            )}
            {cur && (
              <a
                href={cur.src}
                download={cur.name}
                title={t('下载')}
                aria-label={t('下载')}
                className="grid h-7 w-7 shrink-0 place-items-center rounded-md hover:bg-white/10 hover:text-white"
              >
                <Download className="h-4 w-4" />
              </a>
            )}
          </div>
          {n > 1 &&
            ([-1, 1] as const).map((d) => (
              <button
                key={d}
                onClick={() => go(d)}
                aria-label={d < 0 ? t('上一张') : t('下一张')}
                className={cn(
                  'absolute top-1/2 grid h-10 w-10 -translate-y-1/2 cursor-pointer place-items-center rounded-full bg-white/10 text-white/80 hover:bg-white/20 hover:text-white',
                  d < 0 ? 'left-4' : 'right-4',
                )}
              >
                {d < 0 ? <ChevronLeft className="h-5 w-5" /> : <ChevronRight className="h-5 w-5" />}
              </button>
            ))}
          <D.Close
            aria-label={t('关闭')}
            className="absolute top-4 right-4 grid h-9 w-9 cursor-pointer place-items-center rounded-full bg-white/10 text-white/80 hover:bg-white/20 hover:text-white"
          >
            <X className="h-5 w-5" />
          </D.Close>
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}
