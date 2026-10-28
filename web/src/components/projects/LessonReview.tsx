import { useMemo, useState } from 'react'
import { toast } from '@/lib/toast'
import { Check, GraduationCap } from 'lucide-react'
import type { Project, ProjectLesson } from '@shared/schema'
import { t } from '@shared/i18n'
import {
  parseLessonReview,
  reviewItemState,
  type LessonReviewItem,
  type ReviewAction,
  type ReviewProblem,
} from '@shared/lesson-review'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

const actionText = (a: ReviewAction) =>
  a === 'rewrite' ? t('改写') : a === 'merge' ? t('合并') : a === 'disable' ? t('停用') : t('删除')

const problemText = (p: ReviewProblem) =>
  p === 'unnecessary'
    ? t('不必要')
    : p === 'unreasonable'
      ? t('不合理')
      : p === 'optimize'
        ? t('可优化')
        : p === 'outdated'
          ? t('已过期')
          : t('重复')

/**
 * 教训评审的报告，画在分析对话右侧的功能面板里（ADR 0016）：每条建议写明问题、依据和改成什么，
 * 用户点「应用」才写进教训。「已应用」按当前的教训现算，在项目设置里手动改成一样的也算
 */
export function LessonReviewReport({ text, project }: { text: string; project?: Project }) {
  const { setProjects } = useData()
  const review = useMemo(() => parseLessonReview(text), [text])
  const [busy, setBusy] = useState(false)
  if (!review || !project) return null
  const lessons = project.lessons
  const rows = review.items.map((it) => ({ it, state: reviewItemState(lessons, it) }))
  const pending = rows.filter((r) => r.state === 'pending')
  // 一条一条按顺序写：后一条要基于前一条写完的结果（合并删掉的条目，后面就不再动它）
  const apply = async (items: LessonReviewItem[]) => {
    setBusy(true)
    let done = 0
    try {
      for (const it of items) {
        const p = await api.applyLessonReview(project.id, it)
        setProjects((ps) => ps.map((x) => (x.id === p.id ? p : x)))
        done++
      }
      toast.success(t('已应用 {n} 条建议', { n: done }))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section aria-label={t('教训评审结果')} className="flex flex-col pb-3">
      <div className="flex flex-col gap-2 px-4 pt-3">
        <div className="flex flex-wrap items-center gap-2">
          <GraduationCap className="h-3.5 w-3.5 text-accent" />
          <span className="text-[0.8125rem] font-medium">{t('教训评审')}</span>
          {pending.length > 0 ? (
            <Badge tone="accent">{t('{n} 条建议待处理', { n: pending.length })}</Badge>
          ) : (
            <Badge tone="success">{rows.length ? t('建议都已处理') : t('没有要改的')}</Badge>
          )}
          <span className="flex-1" />
          {pending.length > 1 && (
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void apply(pending.map((r) => r.it))}>
              {t('全部应用（{n}）', { n: pending.length })}
            </Button>
          )}
        </div>
        {review.summary && <p className="text-[0.8125rem] leading-relaxed text-muted">{review.summary}</p>}
      </div>
      {rows.length > 0 && (
        <ul className="mx-3 mt-3 flex flex-col divide-y overflow-hidden rounded-lg bg-card shadow-card">
          {rows.map(({ it, state }, i) => (
            <ReviewRow
              key={`${it.id}-${i}`}
              it={it}
              state={state}
              lessons={lessons}
              busy={busy}
              onApply={() => void apply([it])}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

function ReviewRow({
  it,
  state,
  lessons,
  busy,
  onApply,
}: {
  it: LessonReviewItem
  state: 'applied' | 'missing' | 'pending'
  lessons: ProjectLesson[]
  busy: boolean
  onApply: () => void
}) {
  const l = lessons.find((x) => x.id === it.id)
  const merged = it.merge.map((m) => lessons.find((x) => x.id === m)?.title).filter(Boolean)
  const rewrites = it.action === 'rewrite' || it.action === 'merge'
  return (
    <li className={cn('flex items-start gap-3 px-3 py-3', state !== 'pending' && 'opacity-60')}>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <Badge tone={it.action === 'delete' || it.action === 'disable' ? 'warning' : 'accent'}>
            {actionText(it.action)}
          </Badge>
          {it.problems.map((p) => (
            <Badge key={p}>{problemText(p)}</Badge>
          ))}
          <span className="min-w-0 truncate text-[0.8125rem] font-medium">
            {l?.title ?? (state === 'applied' ? t('（已删除）') : t('（这条教训已经不在了）'))}
          </span>
        </span>
        {it.why && <span className="text-[0.78125rem] leading-relaxed text-muted">{it.why}</span>}
        {merged.length > 0 && (
          <span className="text-[0.75rem] text-subtle">
            {t('并入：{titles}', { titles: merged.map((x) => `「${x}」`).join('') })}
          </span>
        )}
        {rewrites && (
          <span className="flex flex-col gap-0.5 rounded-lg bg-sel/40 px-2.5 py-1.5 text-[0.75rem]">
            <span className="font-medium text-fg">{t('改成：{text}', { text: it.title })}</span>
            {it.rule && <span className="leading-relaxed text-muted">{it.rule}</span>}
            {it.paths && (
              <span className="font-mono text-subtle">{it.paths.length ? it.paths.join('  ') : t('所有改动')}</span>
            )}
            {it.tags && it.tags.length > 0 && (
              <span className="text-subtle">{it.tags.map((x) => `#${x}`).join(' ')}</span>
            )}
          </span>
        )}
      </div>
      <span className="shrink-0 pt-0.5">
        {state === 'applied' ? (
          <span className="flex items-center gap-1 text-xs text-success">
            <Check className="h-3.5 w-3.5" />
            {t('已应用')}
          </span>
        ) : state === 'missing' ? (
          <span className="text-xs text-subtle">{t('已不在')}</span>
        ) : (
          <Button size="sm" variant="secondary" disabled={busy} onClick={onApply}>
            {t('应用')}
          </Button>
        )}
      </span>
    </li>
  )
}
