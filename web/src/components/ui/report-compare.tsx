import { useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import type { DiffRow } from '@/lib/diff-html'
import { cn } from '@/lib/utils'
import { t } from '@shared/i18n'
import { Collapse } from './collapse'
import { StatusPill, type StatusTone } from './status-pill'
import { UnifiedDiff } from './UnifiedDiff'

/**
 * 文档和上一份的逐节对比（诊断报告「对比上一份」，用户 2026-11-13 定）：改了的小节标「已更新」、展开是逐行差异，
 * 没改的小节收成一行。比较本身由调用方做（诊断报告在 shared/bug/diagnosis-compare.ts），这里只管画；
 * 设置 → 组件 里有示例
 */
export interface CompareItem {
  title: string
  state: 'same' | 'changed' | 'added' | 'removed'
  lines: { kind: 'add' | 'del' | 'ctx'; text: string }[]
  add: number
  del: number
}

/** 改动前后各留几行没改的：再远的收成一行「⋯」 */
const CONTEXT = 2

/** 逐行差异转成 diff 行：离改动远的上下文收成一行 */
function rowsOf(lines: CompareItem['lines']): DiffRow[] {
  const near = lines.map((l, i) =>
    lines.slice(Math.max(0, i - CONTEXT), i + CONTEXT + 1).some((x) => x.kind !== 'ctx' && x.text.trim()),
  )
  const out: DiffRow[] = []
  lines.forEach((l, i) => {
    if (l.kind !== 'ctx' || near[i]) out.push({ kind: l.kind, text: l.text })
    else if (out.at(-1)?.kind !== 'hunk') out.push({ kind: 'hunk', text: '' })
  })
  return out
}

const STATE = (): Record<CompareItem['state'], { label: string; tone: StatusTone }> => ({
  same: { label: t('未改'), tone: 'idle' },
  changed: { label: t('已更新'), tone: 'wait' },
  added: { label: t('新加'), tone: 'ok' },
  removed: { label: t('去掉了'), tone: 'err' },
})

function Section({ item }: { item: CompareItem }) {
  // 改了的默认展开：打开对比就是为了看这几节
  const [open, setOpen] = useState(true)
  const s = STATE()[item.state]
  return (
    <section data-compare-section={item.state} className="overflow-hidden rounded-xl border border-line bg-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left hover:bg-hover"
      >
        <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-subtle transition-transform', open && 'rotate-90')} />
        <span className="min-w-0 flex-1 truncate text-body font-medium">{item.title || t('（开头）')}</span>
        <span className="shrink-0 text-footnote tabular-nums">
          {item.add > 0 && <span className="text-success">+{item.add}</span>}
          {item.add > 0 && item.del > 0 && ' '}
          {item.del > 0 && <span className="text-danger">−{item.del}</span>}
        </span>
        <StatusPill tone={s.tone}>{s.label}</StatusPill>
      </button>
      <Collapse open={open}>
        <UnifiedDiff rows={rowsOf(item.lines)} className="border-t border-line" label={item.title} />
      </Collapse>
    </section>
  )
}

export function ReportCompare({
  items,
  summary,
  className,
}: {
  items: CompareItem[]
  /** 最上面固定的几行（诊断报告：结论变没变、回答了几条、它说改了什么） */
  summary?: ReactNode
  className?: string
}) {
  const changed = items.filter((x) => x.state !== 'same')
  const same = items.filter((x) => x.state === 'same')
  return (
    <div data-report-compare className={cn('flex flex-col gap-2.5', className)}>
      {summary && <div className="flex flex-col gap-1.5 rounded-xl bg-hover px-3.5 py-2.5 text-body">{summary}</div>}
      {changed.length === 0 && <p className="py-4 text-center text-body text-subtle">{t('和上一份相比没有改动')}</p>}
      {changed.map((x) => (
        <Section key={`${x.state}:${x.title}`} item={x} />
      ))}
      {same.length > 0 && (
        <p className="px-1 text-footnote text-subtle" data-compare-same>
          {t('{n} 节未改：{names}', { n: same.length, names: same.map((x) => x.title || t('（开头）')).join(t('、')) })}
        </p>
      )}
    </div>
  )
}
