import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Check, ChevronDown, GraduationCap, Loader2, Sparkles } from 'lucide-react'
import type { Project, ProjectLesson, Task } from '@shared/schema'
import { t } from '@shared/i18n'
import { taskSummary } from '@shared/task'
import {
  LESSON_REVIEW_LANG,
  parseLessonReview,
  reviewItemState,
  type LessonReviewItem,
  type ReviewAction,
  type ReviewProblem,
} from '@shared/lesson-review'
import { api } from '@/lib/api'
import { useData, useNav } from '@/lib/data'
import { startLessonReview } from '@/lib/task-transfer'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'

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
 * 「AI 评审」入口：在这个项目里开一个分析对话评审全部教训，开好后跳到那个对话。
 * 评审的是已保存的教训，onLeave 关掉项目设置
 */
export function LessonReviewDialog({
  project,
  open,
  onOpenChange,
  onLeave,
}: {
  project: Project
  open: boolean
  onOpenChange: (o: boolean) => void
  onLeave?: () => void
}) {
  const { agents, upsertTask } = useData()
  const { go } = useNav()
  const [focus, setFocus] = useState('')
  const [busy, setBusy] = useState(false)
  const run = async () => {
    setBusy(true)
    try {
      const created = await startLessonReview({ project, agents, focus })
      upsertTask(taskSummary(created))
      onOpenChange(false)
      setFocus('')
      onLeave?.()
      go({ page: 'projects', id: project.id, sub: created.id })
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t('AI 评审项目教训')}
      footer={
        <>
          <span className="min-w-0 flex-1 text-xs text-subtle">
            {t('在这个项目里开一个分析对话来评审，只评审不改文件')}
          </span>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t('取消')}
          </Button>
          <Button disabled={busy} onClick={() => void run()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {t('开始评审')}
          </Button>
        </>
      }
    >
      <p className="text-[0.8125rem] leading-relaxed text-muted">
        {t(
          'AI 会逐条看已保存的 {n} 条教训：是否必须、是否合理、能不能写得更好、提到的文件和做法是否已经过期、有没有重复。结果在对话里列成建议，每条要你点「应用」才会改，不会自动改。',
          { n: project.lessons.length },
        )}
      </p>
      <label className="flex flex-col gap-1.5 text-[0.8125rem]">
        <span className="font-medium">{t('想重点看什么（可选）')}</span>
        <textarea
          value={focus}
          onChange={(e) => setFocus(e.target.value)}
          maxLength={1000}
          rows={3}
          placeholder={t('例如：角色自己记的那些、和测试有关的')}
          className="resize-none rounded-lg border bg-field px-3 py-2 outline-none focus:border-accent"
        />
      </label>
    </Modal>
  )
}

/**
 * 评审对话的结果：固定在输入框上方，每条建议写明问题、依据和改成什么，用户点「应用」才写进教训。
 * 「已应用」按当前的教训现算，在项目设置里手动改成一样的也算
 */
export function LessonReviewCard({ task, project }: { task: Task; project?: Project }) {
  const { setProjects } = useData()
  const hit = useMemo(() => {
    if (task.mode !== 'chat' || !task.projectId) return undefined
    // 和「AI 分析」的结果一样：正在回复时只看最后一条用户消息之前的，没写完的不解析
    const msgs = task.messages
    let end = msgs.length
    if (task.status === 'running' && task.working) while (end > 0 && msgs[end - 1].role !== 'user') end--
    for (let i = end - 1; i >= 0; i--)
      if (msgs[i].role === 'agent' && msgs[i].text.includes('```' + LESSON_REVIEW_LANG)) return msgs[i]
    return undefined
  }, [task])
  const review = useMemo(() => (hit ? parseLessonReview(hit.text) : null), [hit])
  // 用户接着追问就收起，把位置让给对话；有了新的评审结果再展开
  const userCount = task.messages.filter((m) => m.role === 'user').length
  const hitId = hit?.id ?? ''
  const [open, setOpen] = useState(
    () => !hit || !task.messages.slice(task.messages.indexOf(hit) + 1).some((m) => m.role === 'user'),
  )
  const seen = useRef({ userCount, hitId })
  useEffect(() => {
    const prev = seen.current
    seen.current = { userCount, hitId }
    if (hitId && hitId !== prev.hitId && prev.hitId) setOpen(true)
    else if (userCount > prev.userCount) setOpen(false)
  }, [userCount, hitId])
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
    <section
      aria-label={t('教训评审结果')}
      className="mx-auto mb-2 flex max-h-[50vh] max-w-(--content-w) flex-col overflow-hidden rounded-xl border border-line-strong bg-card shadow-card"
    >
      <header
        className={cn('flex shrink-0 cursor-pointer items-start gap-3 px-4', open ? 'py-3.5' : 'py-2')}
        onClick={() => setOpen(!open)}
      >
        <span
          className={cn(
            'grid shrink-0 place-items-center rounded-lg bg-accent-soft text-accent',
            open ? 'h-8 w-8' : 'h-6 w-6',
          )}
        >
          <GraduationCap className={open ? 'h-4 w-4' : 'h-3.5 w-3.5'} />
        </span>
        <div className={cn('flex min-w-0 flex-1 gap-1', open ? 'flex-col' : 'items-center self-center')}>
          <div className={cn('flex items-center gap-x-2 gap-y-1', open ? 'flex-wrap' : 'shrink-0')}>
            <h3 className="text-[0.875rem] font-semibold">{t('教训评审')}</h3>
            {pending.length > 0 ? (
              <Badge tone="accent">{t('{n} 条建议待处理', { n: pending.length })}</Badge>
            ) : (
              <Badge tone="success">{rows.length ? t('建议都已处理') : t('没有要改的')}</Badge>
            )}
          </div>
          {review.summary &&
            (open ? (
              <p className="text-[0.8125rem] leading-relaxed text-muted">{review.summary}</p>
            ) : (
              <span className="ml-1 min-w-0 truncate text-[0.8125rem] text-subtle">{review.summary}</span>
            ))}
        </div>
        <span className={cn('flex shrink-0 items-center gap-1', open ? '' : 'self-center')}>
          {open && pending.length > 1 && (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation()
                void apply(pending.map((r) => r.it))
              }}
            >
              {t('全部应用（{n}）', { n: pending.length })}
            </Button>
          )}
          <button
            type="button"
            aria-expanded={open}
            aria-label={open ? t('收起评审结果') : t('展开评审结果')}
            title={open ? t('收起评审结果') : t('展开评审结果')}
            className="grid h-6 w-6 cursor-pointer place-items-center rounded text-subtle hover:bg-sel/70 hover:text-fg"
            onClick={(e) => {
              e.stopPropagation()
              setOpen(!open)
            }}
          >
            <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', !open && 'rotate-180')} />
          </button>
        </span>
      </header>
      {open && rows.length > 0 && (
        <ul className="min-h-0 flex-1 divide-y overflow-y-auto border-t">
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
    <li className={cn('flex items-start gap-3 px-4 py-3', state !== 'pending' && 'opacity-60')}>
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
          <span className="flex flex-col gap-0.5 rounded-lg border bg-field/40 px-2.5 py-1.5 text-[0.75rem]">
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
