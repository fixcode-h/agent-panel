import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { Code2, Copy, ExternalLink, FolderOpen, Loader2, FileText } from 'lucide-react'
import { toast } from '@/lib/toast'
import { copyText } from '@/lib/copy-text'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { editorUrl } from '@/lib/editor-url'
import { isImagePath } from '@/lib/file-path'
import { cn } from '@/lib/utils'
import { Modal, ModalButton, ModalHeader } from '@/components/ui/modal'
import { Lightbox } from '@/components/ui/lightbox'

/** 任务页提供：Agent 输出里的文件路径点了以后在这里打开；没有提供时路径就是普通的行内代码 */
export const FileOpenCtx = createContext<((path: string, line?: number) => void) | null>(null)
export const useFileOpen = () => useContext(FileOpenCtx)

type File = Awaited<ReturnType<typeof api.taskFile>>

/**
 * 在线演示没有项目目录：图片给一张内联的占位图，点开看大图这件事照样能演示。
 * data: 图片里用不了 CSS 变量，打开时从主题 token 里取当前的底色和强调色，换主题也不突兀
 */
function demoImg() {
  const css = getComputedStyle(document.documentElement)
  const bg = css.getPropertyValue('--card').trim()
  const fg = css.getPropertyValue('--accent').trim()
  return (
    'data:image/svg+xml,' +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="${bg}"/><text x="320" y="210" fill="${fg}" font-size="24" text-anchor="middle" font-family="sans-serif">在线演示没有真实的项目目录</text></svg>`, // i18n-ok：演示版的占位图（演示内容不翻译）
    )
  )
}

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
      ? demoImg()
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
      {/* 只看不填：点到外面就关。只有一句说明（找不到、二进制、出错）时弹窗按内容高度、窄一档，不撑满 */}
      <Modal
        open={textOpen}
        onOpenChange={onOpenChange}
        title={null}
        size={!file || lines.length ? 'xl' : 'md'}
        bare
        closeOnOutside
        className={!file || lines.length ? 'h-[min(760px,calc(100dvh-3.75rem))]' : undefined}
      >
        <ModalHeader
          icon={FileText}
          title={
            <>
              {file?.path || target?.path}
              {target?.line ? <span className="text-subtle">:{target.line}</span> : null}
            </>
          }
          titleClass="font-mono"
          titleAttr={target?.path}
          actions={
            <>
              <ModalButton
                icon={Copy}
                label={t('复制路径')}
                onClick={() => void copyText(file?.path || target?.path || '', { done: t('已复制'), fail: false })}
              />
              {local && file?.exists && (
                <>
                  <ModalButton icon={ExternalLink} label={t('用默认程序打开')} onClick={() => openLocal(false)} />
                  <ModalButton icon={FolderOpen} label={t('在文件夹中显示')} onClick={() => openLocal(true)} />
                </>
              )}
              {file?.exists && file.dir && !(local && file.binary) && (
                <ModalButton
                  icon={Code2}
                  label={t('在编辑器中打开')}
                  onClick={() => window.open(editorUrl(file.dir, file.path, target?.line))}
                />
              )}
            </>
          }
        />
        <div ref={box} className="min-h-0 flex-1 overflow-auto">
          {error ? (
            <p className="p-6 text-body text-danger">{error}</p>
          ) : !file ? (
            <div className="flex h-full items-center justify-center text-subtle">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : !file.exists ? (
            <p className="p-6 text-body text-subtle">
              {local
                ? t('找不到这个文件，可能已经被移动或删除。')
                : import.meta.env.VITE_DEMO
                  ? t('在线演示没有真的项目目录，下载到本机运行后可以在这里查看文件。')
                  : t('项目目录里找不到这个文件，可能已经被移动或删除。')}
            </p>
          ) : file.binary ? (
            <p className="p-6 text-body text-subtle">
              {local
                ? t('这个文件不是文字，这里显示不了。可以用默认程序打开，或在文件夹中找到它。')
                : t('这是二进制文件，不显示内容。')}
            </p>
          ) : (
            <pre className="min-w-max py-2 font-mono text-footnote leading-[1.6]">
              {lines.map((l, i) => (
                <div
                  key={i}
                  data-line={i + 1}
                  // 不画斑马纹：深色下底色和隔行浅底明暗差太大，看久了累眼（用户 2026-10-31 反馈）。
                  // 改成悬停那一行淡淡高亮帮着横向对行；跳到的那一行用强调色盖过悬停
                  className={cn('flex whitespace-pre', target?.line === i + 1 ? 'bg-accent/12' : 'hover:bg-fg/4')}
                >
                  <span className="w-14 shrink-0 pr-3 text-right text-subtle/55 select-none">{i + 1}</span>
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
      </Modal>
    </>
  )
}
