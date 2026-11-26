import { useState } from 'react'
import { ListChecks } from 'lucide-react'
import type { NeedItem, NeedState } from '@shared/run/need-item'
import { needState, needsSummary } from '@shared/run/needs'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { Collapse } from '@/components/ui/collapse'
import { FoldBar } from '@/components/ui/fold-bar'
import { StatusPill, type StatusTone } from '@/components/ui/status-pill'
import { Modal, ModalHeader } from '@/components/ui/modal'

const LOOK: Record<NeedState, { tone: StatusTone; label: () => string }> = {
  open: { tone: 'wait', label: () => t('未落地') },
  done: { tone: 'ok', label: () => t('已落地') },
  deferred: { tone: 'idle', label: () => t('延期') },
  dropped: { tone: 'idle', label: () => t('不做') },
}

/** 一句话的进度：工作流卡片和对照表的标题行共用 */
export function needsLine(needs: readonly NeedItem[]) {
  const c = needsSummary(needs)
  return [
    t('{n}/{total} 已落地', { n: c.done, total: c.total }),
    c.open ? t('{n} 条未落地', { n: c.open }) : '',
    c.deferred ? t('{n} 条延期', { n: c.deferred }) : '',
    c.dropped ? t('{n} 条不做', { n: c.dropped }) : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

/**
 * 需求原话对照表（2026-11-26 复盘 §5-1，shared/run/needs.ts）：用户原话拆成的每一条、现在落地没有、
 * 最近是哪个节点标的、写了什么。还有没落地的条目时默认展开，让人一眼看到哪条掉了
 */
export function RunNeeds({ needs }: { needs: readonly NeedItem[] }) {
  const open = needsSummary(needs).open > 0
  const [shown, setShown] = useState(open)
  if (!needs.length) return null
  return (
    <section data-run-needs className="flex flex-col gap-1.5">
      <FoldBar open={shown} onToggle={() => setShown((v) => !v)}>
        <span className="shrink-0 font-medium text-fg">{t('需求对照')}</span>
        <span className={cn('min-w-0 truncate', open && 'text-warning')}>{needsLine(needs)}</span>
      </FoldBar>
      <Collapse open={shown}>
        <NeedList needs={needs} />
      </Collapse>
    </section>
  )
}

/**
 * 工作流卡片底下的一行「需求对照 · 2/3 已落地 · 1 条未落地」：点开弹窗看整张表。
 * 卡片本身点了是切到流程图，这里拦下冒泡，只开弹窗
 */
export function NeedsButton({ needs, name }: { needs: readonly NeedItem[]; name?: string }) {
  const [open, setOpen] = useState(false)
  const left = needsSummary(needs).open > 0
  return (
    // 弹窗挂在 body 上，但 React 事件照组件树冒泡：整块拦下，点弹窗里不会顺带切到流程图
    <span className="contents" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <button
        type="button"
        data-needs-line
        onClick={() => setOpen(true)}
        className={cn(
          'flex min-w-0 items-center gap-1.5 self-start rounded-md px-1 text-xs transition-colors hover:bg-sel',
          left ? 'text-warning' : 'text-subtle',
        )}
      >
        <ListChecks className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">
          {t('需求对照')} · {needsLine(needs)} ›
        </span>
      </button>
      <Modal open={open} onOpenChange={setOpen} title={null} size="lg" bare closeOnOutside>
        <ModalHeader icon={ListChecks} title={t('需求对照')} meta={name} />
        <div className="min-h-0 flex-1 overflow-auto px-4 py-4 md:px-6">
          <p className="mb-3 text-footnote text-subtle">{needsLine(needs)}</p>
          <NeedList needs={needs} />
        </div>
      </Modal>
    </span>
  )
}

/** 表本身：一条一行，编号、原话、最近一次标记和状态 */
function NeedList({ needs }: { needs: readonly NeedItem[] }) {
  return (
    <ul className="flex flex-col divide-y rounded-lg border bg-card">
      {needs.map((n) => {
        const st = needState(n)
        const last = n.marks.at(-1)
        return (
          <li key={n.id} data-need={n.id} className="flex items-start gap-2 px-3 py-2">
            <span className="mt-0.5 shrink-0 font-mono text-xs text-subtle">{n.id}</span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className={cn('text-body text-fg', st === 'dropped' && 'text-subtle line-through')}>{n.text}</span>
              {/* 还没人标过的：写清是哪个节点拆出来的，用户知道该去问谁 */}
              {!last && n.by && (
                <span className="text-footnote text-subtle">{t('{by} 拆出，还没有节点标记', { by: n.by })}</span>
              )}
              {last && (
                <span className="text-footnote text-subtle" title={n.marks.map((m) => `${m.by}：${m.note}`).join('\n')}>
                  {last.by}
                  {last.note && `：${last.note}`}
                </span>
              )}
            </span>
            <StatusPill tone={LOOK[st].tone}>{LOOK[st].label()}</StatusPill>
          </li>
        )
      })}
    </ul>
  )
}
