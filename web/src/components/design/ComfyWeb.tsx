import { useEffect, useState } from 'react'
import { Modal } from '@/components/ui/modal'
import { IconButton } from '@/components/ui/icon-button'
import { toast } from '@/lib/toast'
import { ExternalLink, FileDown, Loader2, Play, X } from 'lucide-react'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { ComfyQueuePanel } from '@/components/comfy/ComfyQueuePanel'

/**
 * 在面板里直接打开本机 ComfyUI 的网页：看节点图、调参数、手动出图，也能看到正在跑的工作流。
 * ComfyUI 只监听本机，所以用 iframe 嵌进来；没启动时先启动。打开前面板会把当前工作流导入它的工作流列表
 */
export function ComfyWebDialog({
  open,
  onOpenChange,
  imported,
  importing,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  /** 刚导入到 ComfyUI 的工作流：在顶部提示去哪里打开 */
  imported?: { name: string; filename: string } | null
  /** 正在导入（ComfyUI 没启动时这一步也会把它启动起来） */
  importing?: boolean
}) {
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
  // 打开时 ComfyUI 可能还没启动：导入工作流会顺带启动，启动好后自动换上网页
  useEffect(() => {
    if (!open || url) return
    let alive = true
    const load = () =>
      api
        .localImage()
        .then((s) => alive && s.running && setUrl(s.url))
        .catch(() => {})
    void load()
    const timer = setInterval(load, 3000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [open, url])
  return (
    // 内嵌整个 ComfyUI 网页，要比 full 档再大：四边只留一点边距
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t('ComfyUI 网页')}
      bare
      size="full"
      closeOnOutside
      className="h-[calc(100dvh-1.5rem)] w-[calc(100%-1.5rem)] max-w-none md:h-[calc(100dvh-3rem)] md:w-[calc(100%-3rem)]"
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-b px-4">
        <span className="text-[0.875rem] font-semibold">{t('ComfyUI 网页')}</span>
        {url && <span className="font-mono text-[0.75rem] text-subtle">{url}</span>}
        <span className="flex-1" />
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[0.75rem] text-muted hover:bg-sel hover:text-fg"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            {t('在浏览器中打开')}
          </a>
        )}
        <IconButton icon={X} size="sm" label={t('关闭')} onClick={() => onOpenChange(false)} />
      </div>
      {imported && (
        <div className="flex shrink-0 items-start gap-2 border-b bg-accent-soft/40 px-4 py-2 text-[0.75rem] leading-relaxed">
          <FileDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-text" />
          <span className="min-w-0 flex-1">
            <span className="font-medium">{t('已导入到 ComfyUI 的工作流列表：{name}', { name: imported.name })}</span>
            <span className="text-subtle">
              {' '}
              {t('在 ComfyUI 右侧的「工作流」侧栏里点开它（ComfyUI 不支持用网址直接打开某个工作流）。')}
            </span>
          </span>
        </div>
      )}
      <ComfyQueuePanel compact className="shrink-0 border-b px-4" />
      {url ? (
        <iframe
          key={`${url}:${imported?.filename ?? ''}`}
          title="ComfyUI"
          src={url}
          className="min-h-0 flex-1 border-0 bg-canvas"
        />
      ) : (
        <div className="grid flex-1 place-items-center p-6 text-center">
          <div className="flex max-w-[360px] flex-col items-center gap-3 text-[0.8125rem] text-muted">
            {importing ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                <p>{t('正在启动 ComfyUI 并导入工作流…')}</p>
              </>
            ) : (
              <>
                <p>{t('ComfyUI 还没有启动。启动后可以在这里直接看节点图、调参数和手动出图。')}</p>
                <Button onClick={() => void start()} disabled={starting}>
                  {starting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                  {t('启动 ComfyUI')}
                </Button>
              </>
            )}
          </div>
        </div>
      )}
    </Modal>
  )
}
