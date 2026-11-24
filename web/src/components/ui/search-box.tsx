import { Search, X } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'
import { t } from '@shared/i18n'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'

/**
 * 搜索框：按回车或点「搜索」才搜，打字时不发请求（用户 2026-11-10 要求：怕搜索拖慢 UE，所有搜索都这样）。
 * initial 变了（切项目、从别处跳过来）不覆盖正在输入的内容，只在挂载时取一次
 */
export function SearchBox({
  initial = '',
  placeholder,
  hint,
  onSearch,
  busy,
  allowEmpty,
  live,
  addon,
  onEnter,
  onFocusChange,
}: {
  initial?: string
  placeholder: string
  /** 输入框右侧的小字（「前缀」） */
  hint?: string
  onSearch: (q: string) => void
  busy?: boolean
  /** 空的也能搜（资源按类型列、日志清掉筛选） */
  allowEmpty?: boolean
  /** 筛的是已经取到网页上的列表（函数、GM）：边打字边筛，不要「搜索」按钮（用户 2026-11-15） */
  live?: boolean
  /** 输入框里最右边的小控件（资源页的类型筛选图标）：放在 label 外面，点它不会把焦点抢回输入框 */
  addon?: ReactNode
  /** live 时按回车：边打字边筛之外，回车「全力搜」（资源页搜索框：不等停手、列得更多） */
  onEnter?: (q: string) => void
  /** 输入框得到 / 失去焦点：还没打字就可以先准备（取索引） */
  onFocusChange?: (focused: boolean) => void
}) {
  const [q, setQ] = useState(initial)
  const input = useRef<HTMLInputElement>(null)
  // 清空（用户 2026-11-20 要）：边打字边筛的、空的也能搜的，清掉就等于搜空，马上把列表放回原样；
  // 要点「搜索」才搜的只清输入框，结果留着，免得误点一下把刚搜到的东西丢了
  const clear = () => {
    setQ('')
    if (live || allowEmpty) onSearch('')
    input.current?.focus()
  }
  const go = () => {
    if (live && onEnter) return onEnter(q.trim())
    if (q.trim() || allowEmpty) onSearch(q.trim())
  }
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        go()
      }}
    >
      <div className="flex h-8 min-w-0 flex-1 items-center gap-1 rounded-lg border border-line-strong bg-field pr-1 pl-2.5 focus-within:border-focus">
        <label className="flex h-full min-w-0 flex-1 items-center gap-2 pr-1.5">
          <Search className="h-3.5 w-3.5 shrink-0 text-subtle" />
          <input
            ref={input}
            value={q}
            onKeyDown={(e) => {
              // Esc 也清空（有字时）：和清空按钮一样
              if (e.key === 'Escape' && q) {
                e.preventDefault()
                // 别让外层弹窗把 Esc 当成关闭：这一下只清搜索框
                e.stopPropagation()
                clear()
              }
            }}
            onChange={(e) => {
              setQ(e.target.value)
              if (live) onSearch(e.target.value.trim())
            }}
            onFocus={onFocusChange && (() => onFocusChange(true))}
            onBlur={onFocusChange && (() => onFocusChange(false))}
            placeholder={placeholder}
            aria-label={placeholder}
            // 弹窗按它认：有字时 Esc 只清搜索框、不关弹窗（modal.tsx）
            data-esc-clears=""
            className="min-w-0 flex-1 bg-transparent text-body text-fg outline-none placeholder:text-subtle"
          />
          {hint && <span className="shrink-0 text-caption text-subtle">{hint}</span>}
        </label>
        {/* 放在 label 外面：点它不会先把焦点给输入框再清，清完自己把焦点放回去 */}
        {q && <IconButton icon={X} size="xs" label={t('清空')} onClick={clear} />}
        {addon}
      </div>
      {!live && (
        <Button type="submit" size="sm" variant="secondary" disabled={busy || (!q.trim() && !allowEmpty)}>
          {t('搜索')}
        </Button>
      )}
    </form>
  )
}
