import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'

/**
 * 实时输出的一段文字：思考过程、模型正在写的工具入参（交诊断报告、建子对话、派子任务……）都用它，
 * 左边一道竖线，正在输出时限高并一直跟着最新内容滚到底；输出完展开看是全文不限高。
 * 外观在设置 → 组件 →「实时输出」里调（正在输出时最多多高、左边竖线）；
 * 同一处还能关掉「正在写」下面的内容（只留那一行），由用它的地方读设置（RunningNow 的 DraftRow）
 */
export function LiveText({
  text,
  live,
  className,
}: {
  text: string
  /** 还在输出：限高、跟着滚到底 */
  live?: boolean
  className?: string
}) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (live && box.current) box.current.scrollTop = box.current.scrollHeight
  }, [text, live])
  return (
    <div
      ref={box}
      className={cn(
        'border-l-(length:--c-liveText-bar) border-line-strong pl-3 text-body leading-relaxed whitespace-pre-wrap text-muted [overflow-wrap:anywhere]',
        live && 'max-h-(--c-liveText-maxH) overflow-y-auto',
        className,
      )}
    >
      {text.trim()}
    </div>
  )
}
