import { createContext, useContext, useEffect, useRef, useState } from 'react'
import * as D from '@radix-ui/react-dialog'
import { Code2, Copy, ExternalLink, FolderOpen, Loader2, X } from 'lucide-react'
import { toast } from '@/lib/toast'
import { copyText } from '@/lib/copy-text'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { editorUrl } from '@/lib/editor-url'
import { isImagePath } from '@/lib/file-path'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Lightbox } from '@/components/ui/lightbox'

/** 任务页提供：Agent 输出里的文件路径点了以后在这里打开；没有提供时路径就是普通的行内代码 */
export const FileOpenCtx = createContext<((path: string, line?: number) => void) | null>(null)
export const useFileOpen = () => useContext(FileOpenCtx)

type File = Awaited<ReturnType<typeof api.taskFile>>

/** 在线演示没有项目目录：图片给一张内联的占位图，点开看大图这件事照样能演示 */
const DEMO_IMG =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="#26221f"/><text x="320" y="210" fill="#d97757" font-size="24" text-anchor="middle" font-family="sans-serif">在线演示没有真实的项目目录</text></svg>',
  )

/**
 * Agent 输出里点了一个文件路径：显示文件内容，跳到提到的那一行，可以在编辑器里打开。
 * local：附件卡片（上传的、粘贴路径引用的本机文件），按绝对路径读，不限在任务目录里；
 * 看不了内容的（PDF、Office 这类）可以用系统默认程序打开或在文件夹里显示
 */
export function FileDialog({
  taskId,
  target,
  onOpenChange,
}: {
  taskId: string
  target: { path: string; line?: number; local?: boolean } | null
  onOpenChange: (open: boolean) => void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const isImage = !!target && isImagePath(target.path)
  const local = !!target?.local
  // 图片不显示文本：用看图的浮层看原图（和附件一样）；演示版没有项目目录，用内联占位图
  const raw = !isImage
    ? ''
    : import.meta.env.VITE_DEMO
      ? DEMO_IMG
      : local
        ? `/api/uploads/raw?path=${encodeURIComponent(target!.path)}`
        : api.taskFileRaw(taskId, target!.path)
  useEffect(() => {
    if (!target) return
    setFile(null)
    setError('')
    if (raw) return
    ;(target.local ? api.localFile(target.path) : api.taskFile(taskId, target.path))
      .then(setFile)
      .catch((e) => setError((e as Error).message))
  }, [taskId, target, raw])
  const openLocal = (reveal: boolean) =>
    target &&
    api
      .openLocalFile(target.path, reveal)
      .then((r) => !reveal && r.revealed && toast(t('这是可执行文件，不直接运行，已在文件夹中显示')))
      .catch((e) => toast.error((e as Error).message))
  // 内容出来后滚到提到的那一行
  useEffect(() => {
    if (!file || !target?.line) return
    box.current?.querySelector(`[data-line="${target.line}"]`)?.scrollIntoView({ block: 'center' })
  }, [file, target])

  const lines = file?.content ? file.content.replace(/\n$/, '').split('\n') : []
  const textOpen = !!target && !raw
  return (
    <>
      <Lightbox
        images={raw ? [{ src: raw, name: target!.path.split(/[\\/]/).pop()! }] : []}
        index={raw ? 0 : undefined}
        onClose={() => onOpenChange(false)}
      />
      <D.Root open={textOpen} onOpenChange={onOpenChange}>
        <D.Portal>
          <D.Overlay className="fixed inset-0 z-40 bg-black/45 animate-[fade-in_150ms_ease-out]" />
          <D.Content
            aria-describedby={undefined}
            className={cn(
              'fixed top-1/2 left-1/2 z-50 flex w-[min(1000px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-line-strong bg-card shadow-pop animate-[pop-in_160ms_ease-out] focus:outline-none',
              // 只有一句说明（找不到、二进制、出错）时弹窗按内容高度，不撑满
              !file || lines.length ? 'h-[min(760px,calc(100dvh-2rem))]' : 'max-w-[560px]',
            )}
          >
            <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
              <D.Title className="min-w-0 flex-1 truncate font-mono text-[0.8125rem] font-medium" title={target?.path}>
                {file?.path || target?.path}
                {target?.line ? <span className="text-subtle">:{target.line}</span> : null}
              </D.Title>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('复制路径')}
                title={t('复制路径')}
                onClick={() => void copyText(file?.path || target?.path || '', { done: t('已复制'), fail: false })}
              >
                <Copy className="h-4 w-4" />
              </Button>
              {local && file?.exists && (
                <>
                  <Button variant="ghost" size="sm" onClick={() => openLocal(false)}>
                    <ExternalLink className="h-4 w-4" />
                    {t('用默认程序打开')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('在文件夹中显示')}
                    title={t('在文件夹中显示')}
                    onClick={() => openLocal(true)}
                  >
                    <FolderOpen className="h-4 w-4" />
                  </Button>
                </>
              )}
              {file?.exists && file.dir && !(local && file.binary) && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => window.open(editorUrl(file.dir, file.path, target?.line))}
                >
                  <Code2 className="h-4 w-4" />
                  {t('在编辑器中打开')}
                </Button>
              )}
              <D.Close asChild>
                <Button variant="ghost" size="icon-sm" aria-label={t('关闭')}>
                  <X className="h-4 w-4" />
                </Button>
              </D.Close>
            </header>
            <div ref={box} className="min-h-0 flex-1 overflow-auto bg-(--code-bg)">
              {error ? (
                <p className="p-6 text-[0.8125rem] text-danger">{error}</p>
              ) : !file ? (
                <div className="flex h-full items-center justify-center text-subtle">
                  <Loader2 className="h-5 w-5 animate-spin" />
                </div>
              ) : !file.exists ? (
                <p className="p-6 text-[0.8125rem] text-subtle">
                  {local
                    ? t('找不到这个文件，可能已经被移动或删除。')
                    : import.meta.env.VITE_DEMO
                      ? t('在线演示没有真的项目目录，下载到本机运行后可以在这里查看文件。')
                      : t('项目目录里找不到这个文件，可能已经被移动或删除。')}
                </p>
              ) : file.binary ? (
                <p className="p-6 text-[0.8125rem] text-subtle">
                  {local
                    ? t('这个文件不是文字，这里显示不了。可以用默认程序打开，或在文件夹中找到它。')
                    : t('这是二进制文件，不显示内容。')}
                </p>
              ) : (
                <pre className="min-w-max py-2 font-mono text-[0.78125rem] leading-[1.6]">
                  {lines.map((l, i) => (
                    <div
                      key={i}
                      data-line={i + 1}
                      // 奇偶行隔一层浅底（照设计稿），长文件横着看不串行；跳到的那一行高亮盖过它
                      className={cn(
                        'flex whitespace-pre',
                        target?.line === i + 1 ? 'bg-accent/12' : i % 2 === 1 && 'bg-sel/35',
                      )}
                    >
                      <span className="w-14 shrink-0 pr-3 text-right text-subtle/70 select-none">{i + 1}</span>
                      <span className="pr-4 text-fg/90">{l || ' '}</span>
                    </div>
                  ))}
                </pre>
              )}
            </div>
            {file?.truncated && (
              <p className="shrink-0 border-t px-4 py-2 text-xs text-subtle">
                {t('文件太大，只显示了前面一部分。完整内容请在编辑器里查看。')}
              </p>
            )}
          </D.Content>
        </D.Portal>
      </D.Root>
    </>
  )
}
