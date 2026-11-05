import { useCallback, useState } from 'react'
import { FileText, Loader2, Paperclip, X } from 'lucide-react'
import { MAX_ATTACHMENTS, type Attachment } from '@shared/schema'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { toast } from '@/lib/toast'
import { IconButton } from '@/components/ui/icon-button'
import { readBase64 } from '@/components/chat/Attachments'

/**
 * 审阅弹窗「整体意见」框里附日志文件（用户 2026-11-05 要的）：粘贴、拖进来，或者点回形针在本机选。
 * 本机选的拿到原路径直接引用（日志常常很大，不拷贝）；粘贴、拖进来的浏览器读出来上传一份。
 * 附件随交给 AI 的那条消息一起发过去，AI 用工具读，不塞进提示词
 */
export function useLogFiles() {
  const [files, setFiles] = useState<Attachment[]>([])
  const [busy, setBusy] = useState(0)

  const push = useCallback((list: Attachment[]) => {
    setFiles((xs) => {
      const fresh = list.filter((a) => !xs.some((x) => x.path === a.path))
      const room = MAX_ATTACHMENTS - xs.length
      if (fresh.length > room) toast.error(t('一次最多附上 {n} 个文件', { n: MAX_ATTACHMENTS }))
      return [...xs, ...fresh.slice(0, Math.max(room, 0))]
    })
  }, [])

  /** 粘贴、拖进来的文件：读出来上传 */
  const add = useCallback(
    async (list: File[]) => {
      if (!list.length) return
      setBusy((n) => n + list.length)
      for (const f of list) {
        try {
          const data = await readBase64(f)
          push([await api.upload({ name: f.name || 'log.txt', mime: f.type || 'text/plain', data })])
        } catch (e) {
          toast.error(t('「{name}」上传失败：{error}', { name: f.name, error: (e as Error).message }))
        } finally {
          setBusy((n) => n - 1)
        }
      }
    },
    [push],
  )

  /** 在本机弹选择框：拿到原路径，直接引用 */
  const pick = useCallback(async () => {
    try {
      const { files: got } = await api.pickFiles()
      push(got.map((a) => ({ ...a, ref: true })))
    } catch (e) {
      toast.error((e as Error).message)
    }
  }, [push])

  const remove = (path: string) => setFiles((xs) => xs.filter((x) => x.path !== path))
  const reset = useCallback(() => setFiles([]), [])

  /** 绑在输入框上：粘贴里有文件时收成附件（纯文字照常粘进去），拖进来的文件也收 */
  const bind = {
    onPaste: (e: React.ClipboardEvent) => {
      const got = [...e.clipboardData.files]
      if (!got.length) return
      e.preventDefault()
      void add(got)
    },
    onDragOver: (e: React.DragEvent) => {
      if (e.dataTransfer.types.includes('Files')) e.preventDefault()
    },
    onDrop: (e: React.DragEvent) => {
      const got = [...e.dataTransfer.files]
      if (!got.length) return
      e.preventDefault()
      void add(got)
    },
  }
  return { files, busy: busy > 0, pick, remove, reset, bind }
}

/** 附上的日志文件和回形针按钮：放在输入框下面 */
export function LogFiles({
  files,
  busy,
  onPick,
  onRemove,
}: {
  files: Attachment[]
  busy: boolean
  onPick: () => void
  onRemove: (path: string) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 pt-2">
      <button
        type="button"
        onClick={onPick}
        className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs text-muted transition-colors hover:bg-sel hover:text-fg"
      >
        <Paperclip className="h-3.5 w-3.5" />
        {t('附日志文件')}
      </button>
      {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-subtle" aria-label={t('上传中')} />}
      {files.map((f) => (
        <span
          key={f.path}
          title={f.path}
          className="flex h-7 max-w-[220px] items-center gap-1 rounded-md bg-sel/70 pr-0.5 pl-2 text-xs"
        >
          <FileText className="h-3.5 w-3.5 shrink-0 text-subtle" />
          <span className="min-w-0 truncate">{f.name}</span>
          <IconButton icon={X} label={t('移除 {name}', { name: f.name })} size="2xs" onClick={() => onRemove(f.path)} />
        </span>
      ))}
      {!files.length && !busy && (
        <span className="text-xs text-subtle">{t('也可以把日志文件直接粘贴或拖进上面的框')}</span>
      )}
    </div>
  )
}
