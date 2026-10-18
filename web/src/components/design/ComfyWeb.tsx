import { useState } from 'react'
import * as D from '@radix-ui/react-dialog'
import { toast } from 'sonner'
import { ExternalLink, Loader2, Play, X } from 'lucide-react'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'

/**
 * 在面板里直接打开本机 ComfyUI 的网页：看节点图、调参数、手动出图。
 * ComfyUI 只监听本机，所以用 iframe 嵌进来；没启动时先启动
 */
export function ComfyWebDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [url, setUrl] = useState('')
  const [starting, setStarting] = useState(false)
  const start = async () => {
    setStarting(true)
    try {
      const st = await api.localImageAction('start')
      if (st.running) setUrl(st.url)
      else toast.error(t('ComfyUI 没有启动起来，请到设置 → 本机生图里查看'))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setStarting(false)
    }
  }
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/55 animate-[fade-in_150ms_ease-out]" />
        <D.Content
          aria-describedby={undefined}
          onOpenAutoFocus={() => void api.localImage().then((s) => (s.running ? setUrl(s.url) : setUrl('')))}
          className="fixed inset-3 z-50 flex flex-col overflow-hidden rounded-2xl border border-line-strong bg-card shadow-pop animate-[pop-in_160ms_ease-out] focus:outline-none md:inset-6"
        >
          <div className="flex h-11 shrink-0 items-center gap-2 border-b px-4">
            <D.Title className="text-[14px] font-semibold">{t('ComfyUI 网页')}</D.Title>
            {url && <span className="font-mono text-[12px] text-subtle">{url}</span>}
            <span className="flex-1" />
            {url && (
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] text-muted hover:bg-sel hover:text-fg"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                {t('在浏览器中打开')}
              </a>
            )}
            <D.Close
              aria-label={t('关闭')}
              className="grid h-7 w-7 cursor-pointer place-items-center rounded-md text-subtle hover:bg-sel hover:text-fg"
            >
              <X className="h-4 w-4" />
            </D.Close>
          </div>
          {url ? (
            <iframe title="ComfyUI" src={url} className="min-h-0 flex-1 border-0 bg-[#202020]" />
          ) : (
            <div className="grid flex-1 place-items-center p-6 text-center">
              <div className="flex max-w-[360px] flex-col items-center gap-3 text-[13px] text-muted">
                <p>{t('ComfyUI 还没有启动。启动后可以在这里直接看节点图、调参数和手动出图。')}</p>
                <Button onClick={() => void start()} disabled={starting}>
                  {starting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                  {t('启动 ComfyUI')}
                </Button>
              </div>
            </div>
          )}
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}
