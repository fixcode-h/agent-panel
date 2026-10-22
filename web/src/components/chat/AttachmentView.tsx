// 附件卡片点开以后怎么看：图片用看图浮层，文件用文件弹窗（看不了的可以用默认程序打开），引用看原文。
// 输入框里的卡片和发出去的消息里的卡片共用这一套
import { useCallback, useEffect, useMemo, useState } from 'react'
import * as D from '@radix-ui/react-dialog'
import { Copy, File as FileIcon, Image as ImageIcon, TextQuote, X } from 'lucide-react'
import { toast } from 'sonner'
import { attachOf, segments, type ChipKind } from '@shared/composer'
import type { Attachment } from '@shared/schema'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { quoteLabel, quoteText } from '@/lib/quote'
import { Button } from '@/components/ui/button'
import { Lightbox, type LightboxImage } from '@/components/ui/lightbox'
import { FileDialog } from '@/components/tasks/FileDialog'
import { Markdown } from '@/components/tasks/Markdown'
import { attachmentUrl, isImage } from './Attachments'

/** 行内卡片的样子：输入框（RichInput 用 DOM 画）和消息里（这里用 React 画）用同一套，发出去前后看起来一样 */
export const CHIP_CLASS =
  'mx-0.5 inline-flex max-w-[16rem] shrink-0 items-center gap-1.5 rounded-md border border-line-strong bg-field/70 px-1.5 align-middle text-[0.8125rem] leading-[1.7] text-fg'

/** 点开一张卡片要看的东西 */
export type ViewTarget =
  | { kind: 'image'; name: string; images: LightboxImage[] }
  | { kind: 'file'; path: string }
  | { kind: 'quote'; text: string }

const NO_TEAM = new Set<string>()

/** 引用的原文：按 Markdown 显示，可以复制 */
function QuoteDialog({ text, onClose }: { text: string | null; onClose: () => void }) {
  return (
    <D.Root open={text !== null} onOpenChange={(o) => !o && onClose()}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/45 animate-[fade-in_150ms_ease-out]" />
        <D.Content
          aria-describedby={undefined}
          className="fixed top-1/2 left-1/2 z-50 flex max-h-[min(720px,calc(100dvh-2rem))] w-[min(760px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-line-strong bg-card shadow-pop animate-[pop-in_160ms_ease-out] focus:outline-none"
        >
          <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
            <TextQuote className="h-4 w-4 shrink-0 text-subtle" />
            <D.Title className="min-w-0 flex-1 truncate text-[0.875rem] font-medium">{t('引用的内容')}</D.Title>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('复制')}
              title={t('复制')}
              onClick={() =>
                navigator.clipboard
                  ?.writeText(text ?? '')
                  .then(() => toast.success(t('已复制')))
                  .catch(() => {})
              }
            >
              <Copy className="h-4 w-4" />
            </Button>
            <D.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t('关闭')}>
                <X className="h-4 w-4" />
              </Button>
            </D.Close>
          </header>
          <div className="min-h-0 flex-1 overflow-auto px-5 py-4 text-[0.875rem]">
            {text !== null && <Markdown text={text} teamNames={NO_TEAM} />}
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}

/** 卡片点开后的浮层；target 为空时什么都不显示 */
export function AttachmentViewer({ target, onClose }: { target: ViewTarget | null; onClose: () => void }) {
  const filePath = target?.kind === 'file' ? target.path : ''
  // 文件弹窗按 target 的引用决定要不要重新读，同一个文件不能每次渲染都给新对象
  const file = useMemo(() => (filePath ? { path: filePath, local: true } : null), [filePath])
  const images = target?.kind === 'image' ? target.images : []
  const at = target?.kind === 'image' ? images.findIndex((x) => x.name === target.name) : -1
  return (
    <>
      <Lightbox images={images} index={at >= 0 ? at : undefined} onClose={onClose} />
      <FileDialog taskId="" target={file} onOpenChange={(o) => !o && onClose()} />
      <QuoteDialog text={target?.kind === 'quote' ? target.text : null} onClose={onClose} />
    </>
  )
}

/** 一组附件的图片地址：缩略图、看大图都用它 */
export function useAttachmentUrls(items: readonly Attachment[]) {
  const [urls, setUrls] = useState<Record<string, string>>({})
  const key = items.map((a) => a.path).join('\n')
  useEffect(() => {
    let alive = true
    void Promise.all(
      items.filter((a) => isImage(a.mime, a.name)).map(async (a) => [a.path, (await attachmentUrl(a)) ?? ''] as const),
    ).then((list) => alive && setUrls(Object.fromEntries(list.filter(([, u]) => u))))
    return () => {
      alive = false
    }
    // 按路径比较：父组件每次渲染给的数组都是新的，内容没变就不重新取
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return urls
}

/** 卡片对应的附件点开要看什么；附件找不到（旧的只存在本地的引用）时尽量用卡片自己的信息 */
export function viewOf(
  kind: ChipKind,
  name: string,
  a: Attachment | undefined,
  images: LightboxImage[],
): ViewTarget | null {
  if (kind === 'quote') {
    const text = a?.quote ?? quoteText(name)
    return text ? { kind: 'quote', text } : null
  }
  if (kind === 'image' && images.some((x) => x.name === name)) return { kind: 'image', name, images }
  if (a) return { kind: 'file', path: a.path }
  return null
}

/** 消息里的一张卡片：和输入框里的一样，只是没有删除按钮；点了打开 */
export function MessageChip({
  kind,
  name,
  attachment,
  src,
  onOpen,
}: {
  kind: ChipKind
  name: string
  attachment?: Attachment
  /** 图片的缩略图 */
  src?: string
  onOpen?: () => void
}) {
  const label = kind === 'quote' ? quoteLabel(name) : name
  const title =
    kind === 'quote'
      ? (attachment?.quote ?? (quoteText(name) || label)).slice(0, 600)
      : attachment
        ? attachment.path
        : name
  const Icon = kind === 'quote' ? TextQuote : kind === 'image' ? ImageIcon : FileIcon
  return (
    <button
      type="button"
      title={title}
      onClick={onOpen}
      disabled={!onOpen}
      className={cn(
        CHIP_CLASS,
        'cursor-pointer text-left transition-colors hover:border-subtle/60 hover:bg-field disabled:cursor-default',
      )}
    >
      {src ? (
        <img src={src} alt="" className="h-[1.25em] w-[1.25em] shrink-0 rounded-sm object-cover" />
      ) : (
        <Icon className="h-[1.05em] w-[1.05em] shrink-0 opacity-70" strokeWidth={2} />
      )}
      <span className="truncate">{label}</span>
    </button>
  )
}

/**
 * 用户消息的正文：文字里的卡片标记画成和输入框里一样的卡片，点开看图、看文件、看引用原文。
 * 文字里没有卡片的附件（旧消息只把附件放在上面）排在最前面，同在一个气泡里
 */
export function MessageBody({ text, attachments = [] }: { text: string; attachments?: Attachment[] }) {
  const urls = useAttachmentUrls(attachments)
  const images = useMemo(
    () => attachments.filter((a) => urls[a.path]).map((a) => ({ src: urls[a.path], name: a.name })),
    [attachments, urls],
  )
  const [view, setView] = useState<ViewTarget | null>(null)
  const open = useCallback(
    (kind: ChipKind, name: string, a?: Attachment) => {
      const v = viewOf(kind, name, a, images)
      if (v) setView(v)
    },
    [images],
  )
  const parts = segments(text)
  const used = new Set<Attachment>()
  const body = parts.map((s, i) => {
    if ('text' in s) return <span key={i}>{s.text}</span>
    const { kind, name } = s.chip
    // 技能、命令发出去时已经换成「/名字」，这里只会遇到附件类的卡片
    if (kind === 'skill' || kind === 'command') return <span key={i}>{`/${name}`}</span>
    const a = attachOf(s.chip, attachments)
    if (a) used.add(a)
    return (
      <MessageChip
        key={i}
        kind={kind}
        name={name}
        attachment={a}
        src={a ? urls[a.path] : undefined}
        onOpen={() => open(kind, name, a)}
      />
    )
  })
  const rest = attachments.filter((a) => !used.has(a))
  return (
    <>
      {rest.map((a) => {
        const kind: ChipKind = a.quote !== undefined ? 'quote' : isImage(a.mime, a.name) ? 'image' : 'file'
        return (
          <MessageChip
            key={a.path}
            kind={kind}
            name={a.name}
            attachment={a}
            src={urls[a.path]}
            onOpen={() => open(kind, a.name, a)}
          />
        )
      })}
      {rest.length > 0 && parts.length > 0 && ' '}
      {body}
      <AttachmentViewer target={view} onClose={() => setView(null)} />
    </>
  )
}
