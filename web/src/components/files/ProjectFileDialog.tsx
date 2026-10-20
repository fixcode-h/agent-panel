import { useEffect, useRef, useState } from 'react'
import * as D from '@radix-ui/react-dialog'
import { Code2, Copy, Loader2, X } from 'lucide-react'
import { toast } from 'sonner'
import { t } from '@shared/i18n'
import type { FileContent } from '@shared/files'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Lightbox } from '@/components/ui/lightbox'

/** 按扩展名先认出图片，直接看原图，不用等文本接口回来再切换 */
const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp)$/i

/** 编辑器里打开的地址（VS Code 及兼容的编辑器认 vscode://file/），带上行号 */
const editorUrl = (dir: string, file: string, line?: number) => {
  const full = (/^([A-Za-z]:)?[\\/]/.test(file) ? file : `${dir.replace(/[\\/]+$/, '')}/${file}`).replace(/\\/g, '/')
  return `vscode://file/${full.startsWith('/') ? full.slice(1) : full}${line ? `:${line}` : ''}`
}

/**
 * 文件浏览页里点开一个文件：显示内容，跳到指定的行，可以在编辑器里打开。
 * 图片用看图的浮层看原图。
 */
export function ProjectFileDialog({
  projectId,
  dir,
  target,
  onOpenChange,
}: {
  projectId: string
  /** 项目目录：拼「在编辑器中打开」的地址 */
  dir: string
  target: { path: string; line?: number } | null
  onOpenChange: (open: boolean) => void
}) {
  const [file, setFile] = useState<FileContent | null>(null)
  const [error, setError] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const isImage = !!target && IMAGE.test(target.path)
  const raw = isImage ? api.projectFileRaw(projectId, target!.path) : ''
  useEffect(() => {
    if (!target) return
    setFile(null)
    setError('')
    if (raw) return
    api
      .projectFile(projectId, target.path)
      .then(setFile)
      .catch((e) => setError((e as Error).message))
  }, [projectId, target, raw])
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
        images={raw ? [{ src: raw, name: target!.path.split('/').pop()! }] : []}
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
                onClick={() =>
                  navigator.clipboard
                    ?.writeText(file?.path || target?.path || '')
                    .then(() => toast.success(t('已复制')))
                    .catch(() => {})
                }
              >
                <Copy className="h-4 w-4" />
              </Button>
              {file?.exists && dir && (
                <Button variant="ghost" size="sm" onClick={() => window.open(editorUrl(dir, file.path, target?.line))}>
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
                  {t('项目目录里找不到这个文件，可能已经被移动或删除。')}
                </p>
              ) : file.binary ? (
                <p className="p-6 text-[0.8125rem] text-subtle">{t('这是二进制文件，不显示内容。')}</p>
              ) : (
                <pre className="min-w-max py-2 font-mono text-[0.78125rem] leading-[1.6]">
                  {lines.map((l, i) => (
                    <div
                      key={i}
                      data-line={i + 1}
                      className={cn('flex whitespace-pre', target?.line === i + 1 && 'bg-accent/12')}
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
