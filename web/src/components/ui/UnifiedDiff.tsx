import { useEffect, useMemo, useState } from 'react'
import { diffRowsHtml, parseDiff, type DiffRow } from '@/lib/diff-html'
import { ensureHljs, loadedHljs } from '@/lib/workflow-doc'
import { cn } from '@/lib/utils'

/**
 * 界面里的 diff 都用它画（对话里的改文件、确认改文件的请求、差异弹窗的上下对照、优化建议）：
 * 和 Markdown 里的 ```diff 一个画法（lib/diff-html.ts，照 Claude Code），样式是 index.css 的 .cdiff。
 * 给 diff（unified diff 文本）或者现成的 rows（自己比出来的改前改后）；file 认语言着色，highlight.js 用到时再加载
 */
export function UnifiedDiff({
  diff,
  rows: given,
  file,
  wrap = true,
  max,
  className,
  label,
}: {
  diff?: string
  rows?: DiffRow[]
  file?: string
  /** 长行折行（默认）；不折时整块横向滚动 */
  wrap?: boolean
  /** 只画前这么多行（差异弹窗分批显示） */
  max?: number
  className?: string
  label?: string
}) {
  const [hl, setHl] = useState(loadedHljs)
  useEffect(() => {
    if (hl || !file) return
    let off = false
    void ensureHljs().then(() => !off && setHl(loadedHljs()))
    return () => {
      off = true
    }
  }, [hl, file])
  const rows = useMemo(() => given ?? parseDiff(diff ?? '') ?? [], [given, diff])
  const html = useMemo(() => diffRowsHtml(rows, { hl, file, max }), [rows, hl, file, max])
  return (
    <div className={cn('cdiff', className)} data-wrap={wrap ? '' : undefined} aria-label={label}>
      <div className="cdiff-in" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}
