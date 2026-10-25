// 通用的 AI 对话输入框：附件（选文件、粘贴截图、拖进来）、自动长高、Enter 发送、发送 / 停止按钮。
// 任务对话和 UI 设计的对话共用这一个，不同的地方通过插槽扩展：
// menus（「/」「@」弹出的列表）、above（输入框上面的标注等）、tools（左下角的开关和选项）、actions（换掉右下角的按钮）
import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUp, ListPlus, Loader2, Square } from 'lucide-react'
import type { DesignKind, SavedStyle } from '@shared/design'
import { cn } from '@/lib/utils'
import { t } from '@shared/i18n'
import { AttachMenu, DropHint, FileRefHint, type useAttachments } from './Attachments'
import { RichInput, type RichInputHandle } from './RichInput'
import { useComposerChips } from './composer-chips'
import { ElementPickButton } from './ElementPicker'

const DRAFT = 'chat-draft:'

/**
 * 输入框里还没发出去的内容：每个对话各自记住，切到别的对话再回来还在（刷新页面也在），发出去后清空。
 * 行内卡片（Skill、图片）也是文字的一部分，按原样存着。
 */
export function useDraft(key: string) {
  const read = (k: string) => {
    if (!k) return ''
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
  dropScope,
  onDropOver,
  draftKey,
  onEmptyChange,
  className,
}: {
  /** 不传 value / onChange 时自己管草稿：按 draftKey 记着，打字只重渲染这个输入框 */
  value?: string
  onChange?: (v: string) => void
  draftKey?: string
  /** 从有内容变成空（或反过来）时通知外面：外面只在切换时重渲染一次 */
  onEmptyChange?: (empty: boolean) => void
  onSubmit: (text: string) => void
  files: ReturnType<typeof useAttachments>
  taRef?: React.RefObject<RichInputHandle | null>
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
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => boolean
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
   * 正在回复时：没写东西只显示停止；写了东西显示「发送」「停止」——
   * 发送（Enter）把要求交给正在进行的这一轮。给了 onQueue 时另外显示「排队」（UI 设计的对话用来等这一轮结束）
   */
  running?: boolean
  onStop?: () => void
  onQueue?: () => void
  sending?: boolean
  /** 能不能发：默认是有文字或附件 */
  canSend?: boolean
  size?: 'sm' | 'md'
  /**
   * 拖放文件的接收范围：给了就在这个元素上接收（对话页任意位置都能拖进来），
   * 提示和拖入状态由外面显示，输入框自己不再画第二层提示
   */
  dropScope?: HTMLElement | null
  /** 页面级的拖入状态交给外面画（传了 dropScope 时用） */
  onDropOver?: (over: boolean) => void
  className?: string
}) {
  const own = useRef<RichInputHandle>(null)
  const editor = taRef ?? own
  const sm = size === 'sm'
  const [draft, setDraft] = useDraft(draftKey ?? '')
  const controlled = value !== undefined
  const text = controlled ? value : draft
  const change = useCallback(
    (v: string) => {
      if (controlled) onChange?.(v)
      else setDraft(v)
    },
    [controlled, onChange, setDraft],
  )
  const typed = canSend ?? (!!text.trim() || files.attachments.length > 0)
  const ready = typed && !sending && !files.uploading
  const [hint, setHint] = useState('')
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const warn = useCallback((text: string) => {
    setHint(text)
    if (hintTimer.current) clearTimeout(hintTimer.current)
    hintTimer.current = setTimeout(() => setHint(''), 4000)
  }, [])
  // 发出去（发送、排队）就把「为什么没发出去」的提示收掉：先被拦、马上又发成功时不能还挂着上一句
  const clearHint = () => {
    if (hintTimer.current) clearTimeout(hintTimer.current)
    setHint('')
  }
  const submit = () => {
    clearHint()
    onSubmit(text)
  }
  // 发送被拦下时给一句话：Enter 和按钮走同一个 ready（见下面的 onKeyDown），
  // 拦下却什么都不说，用户只会觉得回车没反应
  const blocker = disabled
    ? t('现在还不能发送')
    : files.uploading
      ? t('附件还在上传，稍等一下')
      : sending
        ? t('上一条还在发送，稍等一下')
        : !typed
          ? t('先写点要求再发送')
          : ''
  useEffect(
    () => () => {
      if (hintTimer.current) clearTimeout(hintTimer.current)
    },
    [],
  )
  // 空 / 非空只在切换时通知一次：外面（任务页）用它决定要不要显示「继续执行」
  const empty = !text.trim()
  const emptyCb = useRef(onEmptyChange)
  emptyCb.current = onEmptyChange
  useEffect(() => {
    emptyCb.current?.(empty)
  }, [empty])

  const chips = useComposerChips({ files, editor, text, change, dropScope })
  const { addFiles, addReady, drop } = chips
  // 页面级的拖入进度交给外面画整页提示，输入框自己不再叠一层
  const overCb = useRef(onDropOver)
  overCb.current = onDropOver
  useEffect(() => {
    overCb.current?.(drop.over)
  }, [drop.over])
  // 切到这个对话时光标放进输入框，接着写
  useEffect(() => {
    if (!disabled && window.matchMedia?.('(pointer: fine)').matches) editor.current?.focus()
    // 只在打开时
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <div
      ref={chips.dropRef}
      {...drop.container}
      className={cn(
        'relative border border-line-strong shadow-card transition-[border-color,box-shadow]',
        sm
          ? 'rounded-2xl bg-field focus-within:border-focus/60 dark:focus-within:border-focus dark:focus-within:ring-[3px] dark:focus-within:ring-focus-soft'
          : 'mx-auto max-w-(--content-w) rounded-[20px] bg-card focus-within:shadow-pop dark:focus-within:border-focus dark:focus-within:ring-[3px] dark:focus-within:ring-focus-soft',
        drop.over && !dropScope && 'border-accent ring-2 ring-accent/25',
        chips.refOver && 'border-accent ring-2 ring-accent/25',
        className,
      )}
    >
      {menus}
      {drop.over && !dropScope && <DropHint />}
      {chips.refOver && <FileRefHint />}
      {chips.viewer}
      {chips.chipMenu}
      {above}
      <RichInput
        id={id}
        handle={editor}
        value={text}
        onChange={chips.onChange}
        onSync={onSync}
        onKeyDown={(e) => {
          if (onKeyDown?.(e)) return true
          if (e.key !== 'Enter' || e.shiftKey) return false
          e.preventDefault()
          // 和发送按钮同一个判定：不能发就说清原因，不要默默什么都不做
          if (!ready || disabled) {
            warn(blocker)
            return true
          }
          submit()
          return true
        }}
        onPaste={chips.onPaste}
        label={label}
        placeholder={placeholder}
        disabled={disabled}
        preview={chips.preview}
        actions={chips.chipActions}
        pad={sm ? 'px-3.5 pt-3 pb-1' : 'px-4 pt-3.5'}
        className={cn(
          'leading-relaxed',
          sm ? 'max-h-[200px] min-h-[60px] text-[0.84375rem]' : 'max-h-48 min-h-[62px] text-[0.90625rem]',
        )}
      />
      <div className={cn('flex min-w-0 items-center gap-1', sm ? 'px-2 pb-2' : 'px-2.5 pb-2.5')}>
        {attach !== false && (
          <AttachMenu
            onFiles={addFiles}
            onMention={attach?.onMention}
            canMention={!!attach?.canMention}
            onSession={addReady}
            self={attach?.self}
            onStyle={attach?.onStyle}
            styleKind={attach?.styleKind}
            className={sm ? 'h-7 w-7' : undefined}
          />
        )}
        <ElementPickButton onPick={chips.addQuote} rootRef={chips.dropRef} />
        {tools}
        <span className="flex-1" />
        {hint && (
          <span role="status" aria-live="polite" className="min-w-0 truncate text-[0.75rem] text-warning">
            {hint}
          </span>
        )}
        {leading}
        {actions ??
          (running ? (
            <>
              {typed && onQueue && (
                <button
                  type="button"
                  onClick={() => {
                    // 排队也算发出去了：不能还挂着上一次被拦下时的「为什么没发出去」
                    clearHint()
                    onQueue()
                  }}
                  disabled={sending}
                  title={t('等这一轮结束再发')}
                  className={cn(
                    'inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-lg px-2 text-[0.78125rem] text-muted transition-colors hover:bg-sel hover:text-fg disabled:opacity-40',
                    sm ? 'h-7' : 'h-8',
                  )}
                >
                  <ListPlus className="h-3.5 w-3.5" />
                  {t('排队')}
                </button>
              )}
              {typed && (
                <SendButton
                  onClick={submit}
                  disabled={!ready || !!disabled}
                  sending={sending}
                  size={size}
                  title={!ready || disabled ? blocker : t('交给正在进行的这一轮（Enter）')}
                />
              )}
              {onStop && <StopButton onClick={onStop} size={size} />}
            </>
          ) : (
            <SendButton
              onClick={submit}
              disabled={!ready || !!disabled}
              sending={sending}
              size={size}
              title={!ready || disabled ? blocker : undefined}
            />
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
