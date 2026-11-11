import { useEffect, useRef, useState } from 'react'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'

/** 编辑栏最多自动长到几行，再多就出滚动条（可以拖右下角拉高） */
const MAX_LINES = 4

/**
 * 表格上方的编辑栏（像 Excel 的公式栏）：看全当前格的长文本，也能直接在这里改。
 * Enter 确认、Shift+Enter 换行、Esc 放弃；右边是这一列的规则。开关在工具栏「查看」里，记在本机
 */
export function TableEditBar({
  at,
  value,
  rule,
  readOnly,
  onCommit,
  onDone,
}: {
  /** 当前格：「E6 · DisplayName」；没选中格子时空 */
  at: string
  value: string
  /** 这一列的规则：「枚举 Size · 0~4」 */
  rule: string
  readOnly: boolean
  onCommit: (v: string) => void
  /** 确认或放弃后把焦点还给表格 */
  onDone: () => void
}) {
  const [draft, setDraft] = useState(value)
  // Enter / Esc 已经处理过：接着的失焦不再提交一遍（不然撤销里多一步）
  const handled = useRef(false)
  // 换了格子（或格子被别处改了）：编辑栏跟着换
  useEffect(() => setDraft(value), [value, at])
  const lines = Math.min(MAX_LINES, Math.max(1, draft.split('\n').length))
  return (
    <div className="flex shrink-0 items-start gap-2 border-b bg-panel px-3 py-1 text-footnote">
      <span className="flex h-7 w-36 shrink-0 items-center truncate font-mono text-muted" title={at}>
        {at || '—'}
      </span>
      <textarea
        aria-label={t('编辑栏')}
        value={draft}
        disabled={!at}
        readOnly={readOnly}
        rows={lines}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            handled.current = true
            setDraft(value)
            onDone()
          } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            handled.current = true
            if (!readOnly && draft !== value) onCommit(draft)
            onDone()
          }
        }}
        onFocus={() => (handled.current = false)}
        onBlur={() => !handled.current && !readOnly && draft !== value && onCommit(draft)}
        placeholder={at ? '' : t('选中一格看它的完整内容')}
        className={cn(
          'thin-scroll min-h-7 min-w-0 flex-1 resize-y rounded-(--c-input-radius) border border-transparent bg-transparent px-2 py-1 font-(family-name:--c-grid-font) text-body leading-5 text-fg outline-none',
          'hover:border-line focus:border-focus focus:bg-(--c-input-bg) disabled:opacity-60',
        )}
      />
      {rule && (
        <span className="flex h-7 max-w-[40%] shrink items-center truncate text-subtle" title={rule}>
          {rule}
        </span>
      )}
    </div>
  )
}
