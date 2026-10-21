// 通用的 AI 对话输入框：附件（选文件、粘贴截图、拖进来）、自动长高、Enter 发送、发送 / 停止按钮。
// 任务对话和 UI 设计的对话共用这一个，不同的地方通过插槽扩展：
// menus（「/」「@」弹出的列表）、above（输入框上面的标注等）、tools（左下角的开关和选项）、actions（换掉右下角的按钮）
import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUp, ListPlus, Loader2, Square } from 'lucide-react'
import type { DesignKind, SavedStyle } from '@shared/design'
import { dropChip } from '@shared/composer'
import type { Attachment } from '@shared/schema'
import { cn } from '@/lib/utils'
import { t } from '@shared/i18n'
import {
  AttachMenu,
  AttachmentChips,
  chipKind,
  DropHint,
  useDropPaste,
  type AttachHooks,
  type useAttachments,
} from './Attachments'
import { RichInput, type RichInputHandle } from './RichInput'

const DRAFT = 'chat-draft:'

/**
 * 输入框里还没发出去的内容：每个对话各自记住，切到别的对话再回来还在（刷新页面也在），发出去后清空。
 * 行内卡片（Skill、图片）也是文字的一部分，按原样存着。
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
  dropScope,
  onDropOver,
  className,
}: {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
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
  const typed = canSend ?? (!!value.trim() || files.attachments.length > 0)
  const ready = typed && !sending && !files.uploading

  /** 附件加进来时在光标处放一张卡片；上传失败就把卡片撤掉 */
  const addFiles = useCallback(
    (list: File[]) => {
      void files.add(list, {
        added: (items) =>
          items.forEach((x) => editor.current?.insertChip({ kind: chipKind(x.mime, x.name), name: x.name })),
        failed: (name) => onChange(dropChip(editor.current?.text() ?? '', name)),
      })
    },
    [files, editor, onChange],
  )
  const addReady = useCallback(
    (a: Attachment) => {
      const hooks: AttachHooks = {
        added: (items) =>
          items.forEach((x) => editor.current?.insertChip({ kind: chipKind(x.mime, x.name), name: x.name })),
      }
      files.addReady(a, hooks)
    },
    [files, editor],
  )
  /** 附件从附件条上删掉时，输入框里的那张卡片也一起去掉 */
  const removeFile = useCallback(
    (key: string) => {
      const item = files.items.find((x) => x.key === key)
      files.remove(key)
      if (item) onChange(dropChip(editor.current?.text() ?? '', item.name))
    },
    [files, editor, onChange],
  )
  /** 图片卡片显示小缩略图 */
  const preview = useCallback((name: string) => files.items.find((x) => x.name === name)?.preview, [files.items])
  const drop = useDropPaste(addFiles, dropScope)
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
      {...drop.container}
      className={cn(
        'relative border border-line-strong shadow-card transition-[border-color,box-shadow]',
        sm
          ? 'rounded-2xl bg-field focus-within:border-focus/60 dark:focus-within:border-focus dark:focus-within:ring-[3px] dark:focus-within:ring-focus-soft'
          : 'mx-auto max-w-(--content-w) rounded-[20px] bg-card focus-within:shadow-pop dark:focus-within:border-focus dark:focus-within:ring-[3px] dark:focus-within:ring-focus-soft',
        drop.over && !dropScope && 'border-accent ring-2 ring-accent/25',
        className,
      )}
    >
      {menus}
      {drop.over && !dropScope && <DropHint />}
      <AttachmentChips items={files.items} onRemove={removeFile} />
      {above}
      <RichInput
        id={id}
        handle={editor}
        value={value}
        onChange={onChange}
        onSync={onSync}
        onKeyDown={(e) => {
          if (onKeyDown?.(e)) return true
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            onSubmit()
            return true
          }
          return false
        }}
        onPaste={drop.onPaste}
        label={label}
        placeholder={placeholder}
        disabled={disabled}
        preview={preview}
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
                  onClick={onSubmit}
                  disabled={!ready || !!disabled}
                  sending={sending}
                  size={size}
                  title={t('交给正在进行的这一轮（Enter）')}
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
