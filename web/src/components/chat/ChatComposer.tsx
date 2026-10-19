// 通用的 AI 对话输入框：附件（选文件、粘贴截图、拖进来）、自动长高、Enter 发送、发送 / 停止按钮。
// 任务对话和 UI 设计的对话共用这一个，不同的地方通过插槽扩展：
// menus（「/」「@」弹出的列表）、above（输入框上面的标注等）、tools（左下角的开关和选项）、actions（换掉右下角的按钮）
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowUp, ListPlus, Loader2, Square } from 'lucide-react'
import type { DesignKind, SavedStyle } from '@shared/design'
import { cn } from '@/lib/utils'
import { t } from '@shared/i18n'
import { AttachMenu, AttachmentChips, DropHint, useDropPaste, type useAttachments } from './Attachments'

const DRAFT = 'chat-draft:'

/**
 * 输入框里还没发出去的内容：每个对话各自记住，切到别的对话再回来还在（刷新页面也在），发出去后清空
 */
export function useDraft(key: string) {
  const read = (k: string) => {
    try {
      return localStorage.getItem(DRAFT + k) ?? ''
    } catch {
      return ''
    }
  }
  const [state, setState] = useState(() => ({ key, text: read(key) }))
  // 同一个输入框换了对话：换成那个对话的草稿
  const cur = state.key === key ? state : { key, text: read(key) }
  if (cur !== state) setState(cur)
  const set = useCallback(
    (v: string) => {
      setState({ key, text: v })
      try {
        if (v) localStorage.setItem(DRAFT + key, v)
        else localStorage.removeItem(DRAFT + key)
      } catch {}
    },
    [key],
  )
  return [cur.text, set] as const
}

export function ChatComposer({
  value,
  onChange,
  onSubmit,
  files,
  taRef,
  id,
  label,
  placeholder,
  disabled,
  menus,
  above,
  onSync,
  onKeyDown,
  attach,
  tools,
  actions,
  leading,
  running,
  onStop,
  onQueue,
  sending,
  canSend,
  size = 'md',
  className,
}: {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  files: ReturnType<typeof useAttachments>
  taRef?: React.RefObject<HTMLTextAreaElement | null>
  id?: string
  label: string
  placeholder: string
  disabled?: boolean
  /** 「/」「@」弹出的列表，放在输入框里定位 */
  menus?: React.ReactNode
  /** 附件下面、文字上面的内容（例如 UI 设计的标注） */
  above?: React.ReactNode
  /** 文字或光标变了（「/」「@」列表跟着更新） */
  onSync?: () => void
  /** 先交给「/」「@」列表处理按键；返回 true 表示处理掉了 */
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean
  /** 左下角「+」菜单的选项；false 不显示 */
  attach?:
    | {
        onMention?: () => void
        canMention?: boolean
        self?: string
        /** 引入风格（UI 设计用）：选好的风格交回来；styleKind 限定只列哪一类 */
        onStyle?: (s: SavedStyle) => void
        styleKind?: DesignKind
      }
    | false
  /** 「+」后面的开关和选项 */
  tools?: React.ReactNode
  /** 换掉右下角默认的按钮 */
  actions?: React.ReactNode
  /** 右下角默认按钮前面再加的按钮（例如「重试」） */
  leading?: React.ReactNode
  /**
   * 正在回复时：没写东西只显示停止；写了东西显示「排队」「发送」「停止」——
   * 发送（Enter）是补充给正在进行的这一轮，排队是等这一轮结束再发
   */
  running?: boolean
  onStop?: () => void
  onQueue?: () => void
  sending?: boolean
  /** 能不能发：默认是有文字或附件 */
  canSend?: boolean
  size?: 'sm' | 'md'
  className?: string
}) {
  const own = useRef<HTMLTextAreaElement>(null)
  const ta = taRef ?? own
  const drop = useDropPaste(files.add)
  const sm = size === 'sm'
  const typed = canSend ?? (!!value.trim() || files.attachments.length > 0)
  const ready = typed && !sending && !files.uploading
  // 跟着内容长高，到上限后出滚动条
  useLayoutEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(sm ? 200 : 192, el.scrollHeight)}px`
  }, [value, ta, sm])
  // 切到这个对话时光标放进输入框，接着写
  useEffect(() => {
    if (!disabled && window.matchMedia?.('(pointer: fine)').matches) ta.current?.focus({ preventScroll: true })
    // 只在打开时
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <div
      {...drop.container}
      className={cn(
        'relative border border-line-strong shadow-card transition-[border-color,box-shadow]',
        sm
          ? 'rounded-2xl bg-field focus-within:border-focus/60 dark:focus-within:border-focus dark:focus-within:ring-[3px] dark:focus-within:ring-focus-soft'
          : 'mx-auto max-w-(--content-w) rounded-[20px] bg-card focus-within:shadow-pop dark:focus-within:border-focus dark:focus-within:ring-[3px] dark:focus-within:ring-focus-soft',
        drop.over && 'border-accent ring-2 ring-accent/25',
        className,
      )}
    >
      {menus}
      {drop.over && <DropHint />}
      <AttachmentChips items={files.items} onRemove={files.remove} />
      {above}
      {id && (
        <label htmlFor={id} className="sr-only">
          {label}
        </label>
      )}
      <textarea
        id={id}
        ref={ta}
        rows={2}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          onChange(e.target.value)
          onSync?.()
        }}
        onSelect={onSync}
        onPaste={drop.onPaste}
        onKeyDown={(e) => {
          if (onKeyDown?.(e)) return
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            onSubmit()
          }
        }}
        placeholder={placeholder}
        aria-label={id ? undefined : label}
        className={cn(
          'block w-full resize-none bg-transparent leading-relaxed outline-none placeholder:text-subtle focus-visible:outline-none',
          sm ? 'max-h-[200px] px-3.5 pt-3 pb-1 text-[13.5px]' : 'max-h-48 px-4 pt-3.5 text-[14.5px]',
        )}
      />
      <div className={cn('flex min-w-0 items-center gap-1', sm ? 'px-2 pb-2' : 'px-2.5 pb-2.5')}>
        {attach !== false && (
          <AttachMenu
            onFiles={files.add}
            onMention={attach?.onMention}
            canMention={!!attach?.canMention}
            onSession={files.addReady}
            self={attach?.self}
            onStyle={attach?.onStyle}
            styleKind={attach?.styleKind}
            className={sm ? 'h-7 w-7' : undefined}
          />
        )}
        {tools}
        <span className="flex-1" />
        {leading}
        {actions ??
          (running ? (
            <>
              {typed && onQueue && (
                <button
                  type="button"
                  onClick={onQueue}
                  disabled={sending}
                  title={t('等这一轮结束再发')}
                  className={cn(
                    'inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-lg px-2 text-[12.5px] text-muted transition-colors hover:bg-sel hover:text-fg disabled:opacity-40',
                    sm ? 'h-7' : 'h-8',
                  )}
                >
                  <ListPlus className="h-3.5 w-3.5" />
                  {t('排队')}
                </button>
              )}
              {typed && (
                <SendButton
                  onClick={onSubmit}
                  disabled={!ready || !!disabled}
                  sending={sending}
                  size={size}
                  title={t('补充给正在进行的这一轮（Enter）')}
                />
              )}
              {onStop && <StopButton onClick={onStop} size={size} />}
            </>
          ) : (
            <SendButton onClick={onSubmit} disabled={!ready || !!disabled} sending={sending} size={size} />
          ))}
      </div>
    </div>
  )
}

/** 停止正在进行的回复 */
export function StopButton({ onClick, size = 'md' }: { onClick: () => void; size?: 'sm' | 'md' }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={t('停止')}
      title={t('停止')}
      className={cn(
        'grid shrink-0 cursor-pointer place-items-center rounded-full bg-fg text-bg hover:opacity-85',
        size === 'sm' ? 'h-7 w-7' : 'h-8 w-8',
      )}
    >
      <Square className="h-3 w-3 fill-current" />
    </button>
  )
}

/** 发送按钮：自定义 actions 时也能拿来用 */
export function SendButton({
  onClick,
  disabled,
  sending,
  size = 'md',
  title,
}: {
  onClick: () => void
  disabled?: boolean
  sending?: boolean
  size?: 'sm' | 'md'
  title?: string
}) {
  return (
    <button
      type="button"
      aria-label={t('发送')}
      title={title ?? t('发送（Enter）')}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'grid shrink-0 cursor-pointer place-items-center bg-accent text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40',
        size === 'sm' ? 'h-7 w-7 rounded-full' : 'h-8 w-8 rounded-lg',
      )}
    >
      {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowUp className="h-4 w-4" strokeWidth={2.4} />}
    </button>
  )
}
