// 附件卡片点开以后怎么看：图片用看图浮层，文件用文件弹窗（看不了的可以用默认程序打开），引用看原文。
// 输入框里的卡片和发出去的消息里的卡片共用这一套
import { useCallback, useEffect, useMemo, useState } from 'react'
import * as D from '@radix-ui/react-dialog'
import { Copy, File as FileIcon, Image as ImageIcon, ImageOff, TextQuote, X } from 'lucide-react'
import { copyText } from '@/lib/copy-text'
import { attachOf, segments, type ChipKind } from '@shared/composer'
import type { Attachment } from '@shared/schema'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { CHIP_SHAPE, CHIP_TONE } from '@/components/ui/chip-tone'
import { quoteLabel, quoteText } from '@/lib/quote'
import { shownImages } from '@/lib/attachment-image'
import { IconButton } from '@/components/ui/icon-button'
import { Modal } from '@/components/ui/modal'
import { Lightbox, type LightboxImage } from '@/components/ui/lightbox'
import { FileDialog } from '@/components/tasks/FileDialog'
import { Markdown } from '@/components/tasks/Markdown'
import { attachmentUrl, isImage } from './Attachments'

/** 点开一张卡片要看的东西 */
export type ViewTarget =
  | { kind: 'image'; name: string; images: LightboxImage[] }
  | { kind: 'file'; path: string }
  | { kind: 'quote'; text: string }

const NO_TEAM = new Set<string>()

/** 引用的原文：按 Markdown 显示，可以复制 */
function QuoteDialog({ text, onClose }: { text: string | null; onClose: () => void }) {
  return (
    // 只看不填：点到外面就关
    <Modal
      open={text !== null}
      onOpenChange={(o) => !o && onClose()}
      title={null}
      size="lg"
      bare
      closeOnOutside
      className="max-h-[min(720px,calc(100dvh-2rem))]"
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <TextQuote className="h-4 w-4 shrink-0 text-subtle" />
        <D.Title className="min-w-0 flex-1 truncate text-[0.875rem] font-medium">{t('引用的内容')}</D.Title>
        <IconButton
          size="sm"
          icon={Copy}
          label={t('复制')}
          onClick={() => void copyText(text ?? '', { done: t('已复制'), fail: false })}
        />
        <D.Close asChild>
          <IconButton size="sm" icon={X} label={t('关闭')} />
        </D.Close>
      </header>
      <div className="min-h-0 flex-1 overflow-auto px-5 py-4 text-[0.875rem]">
        {text !== null && <Markdown text={text} teamNames={NO_TEAM} />}
      </div>
    </Modal>
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

/** 图片能不能真的显示出来：地址对了但文件已经不在了（404）时返回 false */
function canShow(url: string) {
  return new Promise<boolean>((resolve) => {
    const img = new Image()
    img.onload = () => resolve(true)
    img.onerror = () => resolve(false)
    img.src = url
  })
}

/**
 * 一组附件的图片地址：卡片用缩略图，看大图用原图。
 * 加载不出来的不留下地址（气泡显示图标和「附件已经不在了」），浮层也不会打开一张破图
 */
export function useAttachmentUrls(items: readonly Attachment[]) {
  const [state, setState] = useState<{
    urls: Record<string, string>
    fulls: Record<string, string>
    missing: Record<string, true>
  }>({ urls: {}, fulls: {}, missing: {} })
  const key = items.map((a) => a.path).join('\n')
  useEffect(() => {
    let alive = true
    void Promise.all(
      items
        .filter((a) => isImage(a.mime, a.name))
        .map(async (a) => {
          const [thumb, full] = await Promise.all([attachmentUrl(a, { thumb: true }), attachmentUrl(a)])
          if (thumb && (await canShow(thumb))) return [a.path, thumb, full || thumb, true] as const
          // 缩略图这一层坏了（生成失败、缓存读到半张）不能让好好的附件显示成「已经不在了」：退回原图
          const [url, ok] = full && (await canShow(full)) ? [full, true] : ['', false]
          return [a.path, url, full || '', ok] as const
        }),
    ).then((list) => alive && setState(shownImages(list)))
    return () => {
      alive = false
    }
    // 按路径比较：父组件每次渲染给的数组都是新的，内容没变就不重新取
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return state
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
  missing,
  onOpen,
}: {
  kind: ChipKind
  name: string
  attachment?: Attachment
  /** 图片的缩略图 */
  src?: string
  /** 图片已经不在了（取不到、加载不出来）：显图标，点不开 */
  missing?: boolean
  onOpen?: () => void
}) {
  const label = kind === 'quote' ? quoteLabel(name) : name
  const title = missing
    ? t('附件已经不在了')
    : kind === 'quote'
      ? (attachment?.quote ?? (quoteText(name) || label)).slice(0, 600)
      : attachment
        ? attachment.path
        : name
  const Icon = missing ? ImageOff : kind === 'quote' ? TextQuote : kind === 'image' ? ImageIcon : FileIcon
  // 样子和输入框里的卡片一样（RichInput 的 chipNode 也用 CHIP_TONE），发出去前后看起来是同一张
  const tone = CHIP_TONE[missing ? 'missing' : kind]
  return (
    <button
      type="button"
      title={title}
      // 和输入框里的卡片同一套标记（RichInput 的 chipNode），界面检查按它找消息里的卡片
      data-chip={kind}
      data-name={name}
      data-missing={missing ? 'true' : undefined}
      onClick={onOpen}
      disabled={!onOpen}
      className={cn(
        CHIP_SHAPE,
        tone.box,
        tone.hover,
        'cursor-pointer text-left transition-colors disabled:cursor-default',
      )}
    >
      {src ? (
        // 一屏之外的消息图片推到滚到时再取（首屏不再一次拉十几张）
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          className="h-[1.25em] w-[1.25em] shrink-0 rounded-sm object-cover"
        />
      ) : (
        <Icon className={cn('h-[1.05em] w-[1.05em] shrink-0', tone.icon)} strokeWidth={2.3} />
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
  const { urls, fulls, missing } = useAttachmentUrls(attachments)
  const images = useMemo(
    () => attachments.filter((a) => urls[a.path]).map((a) => ({ src: fulls[a.path] ?? urls[a.path], name: a.name })),
    [attachments, urls, fulls],
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
        missing={!!a && !!missing[a.path]}
        onOpen={a && missing[a.path] ? undefined : () => open(kind, name, a)}
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
            missing={!!missing[a.path]}
            onOpen={missing[a.path] ? undefined : () => open(kind, a.name, a)}
          />
        )
      })}
      {rest.length > 0 && parts.length > 0 && ' '}
      {body}
      <AttachmentViewer target={view} onClose={() => setView(null)} />
    </>
  )
}
