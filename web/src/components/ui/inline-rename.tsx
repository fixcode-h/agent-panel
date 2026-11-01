import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'

/**
 * 原地改名的输入框（侧栏对话、项目、页签、分类）：挂上就聚焦并全选；回车或失焦提交，Esc 取消。
 * 一次编辑只结束一次：Esc 取消后父组件卸掉输入框时浏览器还可能补发 blur，不能再当成提交；
 * 输入法组字时的回车是选字，不提交。是否真的改了（空串、和原值一样）由 onCommit 自己判。
 * Esc 在 window 的捕获阶段就拦下：Radix 的弹窗 / 菜单在 document 捕获阶段听 Esc，
 * 只在输入框上 stopPropagation 拦不住，放在弹窗里改名时按 Esc 会把整个弹窗关掉
 */
export function InlineRename({
  value,
  onCommit,
  onCancel,
  label,
  size = 'md',
  maxLength = 80,
  className,
}: {
  value: string
  onCommit: (value: string) => void
  onCancel: () => void
  /** 读屏名，如「任务标题」 */
  label: string
  /** sm：侧栏、页签这种紧凑行；md：列表和卡片标题 */
  size?: 'sm' | 'md'
  maxLength?: number
  className?: string
}) {
  const done = useRef(false)
  const input = useRef<HTMLInputElement>(null)
  const finish = (commit: boolean, v: string) => {
    if (done.current) return
    done.current = true
    if (commit) onCommit(v)
    else onCancel()
  }
  // 监听只挂一次，每次渲染把 finish 换成最新的，免得 Esc 调到挂载那一刻的旧 onCancel
  const finishRef = useRef(finish)
  finishRef.current = finish
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing || e.target !== input.current) return
      e.stopPropagation()
      finishRef.current(false, '')
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  return (
    <input
      ref={input}
      autoFocus
      aria-label={label}
      defaultValue={value}
      maxLength={maxLength}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={(e) => finish(true, e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
          e.preventDefault()
          finish(true, e.currentTarget.value)
        }
      }}
      // 行本身常是可点的入口，点进输入框里不能触发行的点击
      onClick={(e) => e.stopPropagation()}
      className={cn(
        'min-w-0 border border-focus bg-field text-fg outline-none',
        size === 'sm' ? 'h-7 rounded-md px-1.5 text-footnote' : 'h-8 rounded-lg px-2 text-body',
        className,
      )}
    />
  )
}
