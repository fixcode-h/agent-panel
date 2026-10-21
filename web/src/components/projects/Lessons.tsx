import { useState } from 'react'
import * as D from '@radix-ui/react-dialog'
import { toast } from 'sonner'
import { ChevronRight, GraduationCap, Loader2, Plus, Search, Sparkles, Trash2 } from 'lucide-react'
import type { Project, ProjectLesson } from '@shared/schema'
import { newLessonId } from '@shared/lessons'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { Button } from '@/components/ui/button'
import { Field, Input, Textarea } from '@/components/ui/input'
import { cn } from '@/lib/utils'

/** 输入框里的范围：逗号、顿号、空白都能分隔 */
const splitPaths = (s: string) =>
  s
    .split(/[,，、\s]+/)
    .map((x) => x.trim())
    .filter(Boolean)

const blankLesson = (): ProjectLesson => ({
  id: newLessonId(),
  title: '',
  rule: '',
  cause: '',
  paths: [],
  enabled: true,
  source: 'user',
  taskId: '',
  createdAt: new Date().toISOString(),
})

/**
 * 项目设置里的「教训」：增删改、启停，Agent 自己记的标出来方便复查。
 * 和别的设置一样改完点「确认」才保存
 */
export function LessonsEditor({
  lessons,
  onChange,
}: {
  lessons: ProjectLesson[]
  onChange: (v: ProjectLesson[]) => void
}) {
  const [q, setQ] = useState('')
  // 新加的那条直接展开，其余默认收起：条目多了一屏也看得过来
  const [open, setOpen] = useState<string>('')
  const patch = (id: string, p: Partial<ProjectLesson>) =>
    onChange(lessons.map((l) => (l.id === id ? { ...l, ...p } : l)))
  const key = q.trim().toLowerCase()
  const shown = key
    ? lessons.filter((l) => [l.title, l.rule, l.cause, ...l.paths].some((x) => x.toLowerCase().includes(key)))
    : lessons
  const fromAgent = lessons.filter((l) => l.source === 'agent').length
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[12rem] flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
          <Input
            className="h-8 pl-8 text-xs"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('搜索规则、起因或文件')}
            aria-label={t('搜索教训')}
          />
        </div>
        {fromAgent > 0 && (
          <span className="text-xs text-subtle">{t('其中 {n} 条是角色自己记的', { n: fromAgent })}</span>
        )}
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            const l = blankLesson()
            onChange([l, ...lessons])
            setOpen(l.id)
            setQ('')
          }}
        >
          <Plus className="h-3.5 w-3.5" />
          {t('加一条')}
        </Button>
      </div>
      {lessons.length === 0 && (
        <p className="rounded-xl border border-dashed px-4 py-5 text-center text-xs leading-relaxed text-subtle">
          {t(
            '还没有教训。对话里纠正了角色的做法时，它会自己记一条；也可以在对话里用户消息下面的「记成项目教训」，或者在这里手动加。',
          )}
        </p>
      )}
      {lessons.length > 0 && shown.length === 0 && <p className="px-1 text-xs text-subtle">{t('没有匹配的教训')}</p>}
      <ul className="flex flex-col gap-2">
        {shown.map((l) => {
          const expanded = open === l.id || !l.title.trim()
          return (
            <li key={l.id} className={cn('rounded-xl border bg-card', !l.enabled && 'opacity-60')}>
              <div className="flex items-center gap-2 px-3 py-2">
                <button
                  type="button"
                  onClick={() => setOpen(expanded ? '' : l.id)}
                  aria-expanded={expanded}
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-left"
                >
                  <ChevronRight
                    className={cn('h-4 w-4 shrink-0 text-subtle transition-transform', expanded && 'rotate-90')}
                    strokeWidth={2}
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-[0.8125rem] font-medium">{l.title || t('（还没写规则）')}</span>
                    <span className="truncate font-mono text-[0.6875rem] text-subtle">
                      {l.paths.length ? l.paths.join('  ') : t('所有改动')}
                    </span>
                  </span>
                  {l.source === 'agent' && (
                    <span
                      className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-[0.6875rem] text-accent"
                      title={t('角色被纠正后自己记的，看一下写得对不对')}
                    >
                      {t('角色记录')}
                    </span>
                  )}
                </button>
                <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-muted">
                  <input
                    type="checkbox"
                    className="accent-accent"
                    checked={l.enabled}
                    onChange={(e) => patch(l.id, { enabled: e.target.checked })}
                  />
                  {t('启用')}
                </label>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t('删除这条教训')}
                  title={t('删除这条教训')}
                  onClick={() => onChange(lessons.filter((x) => x.id !== l.id))}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
              {expanded && (
                <div className="flex flex-col gap-3 border-t px-3.5 py-3.5">
                  <LessonFields lesson={l} onChange={(p) => patch(l.id, p)} />
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** 一条教训的输入项：设置页和「记成项目教训」弹窗共用 */
function LessonFields({
  lesson,
  onChange,
  autoFocus,
}: {
  lesson: ProjectLesson
  onChange: (p: Partial<ProjectLesson>) => void
  autoFocus?: boolean
}) {
  // 范围在输入时保留原样（含末尾的逗号），离开输入框再拆成列表
  const [paths, setPaths] = useState(lesson.paths.join(', '))
  return (
    <>
      <Field label={t('规则')} hint={t('一句话写该怎么做，不是发生了什么')}>
        <Input
          autoFocus={autoFocus}
          value={lesson.title}
          maxLength={120}
          onChange={(e) => onChange({ title: e.target.value })}
          placeholder={t('例如：CLI 才有的能力写进 CLI 的配置字段，代码按字段走')}
        />
      </Field>
      <Field label={t('说明')}>
        <Textarea
          rows={3}
          value={lesson.rule}
          maxLength={1500}
          onChange={(e) => onChange({ rule: e.target.value })}
          placeholder={t('具体到文件、字段、做法和不要做的事')}
        />
      </Field>
      <Field label={t('起因')}>
        <Input
          value={lesson.cause}
          maxLength={500}
          onChange={(e) => onChange({ cause: e.target.value })}
          placeholder={t('哪次返工、怎么被纠正的')}
        />
      </Field>
      <Field
        label={t('管哪些文件')}
        hint={t(
          '相对项目根，** 跨目录，写目录名也行，逗号分隔；不写表示所有改动都适用。按文件生效的条目平时只给角色看标题，改到这些文件时它再取全文。',
        )}
      >
        <Input
          className="font-mono text-xs"
          value={paths}
          onChange={(e) => setPaths(e.target.value)}
          onBlur={() => onChange({ paths: splitPaths(paths) })}
          placeholder="src/payment/**, docs/api.md"
        />
      </Field>
    </>
  )
}

/**
 * 对话里「记成项目教训」：用户消息往往就是一次纠正。
 * 可以自己改成规则直接存，也可以交给对话里的角色整理（它知道刚才哪里做错了）
 */
export function RecordLessonDialog({
  project,
  text,
  taskId,
  taskTitle,
  onClose,
  onAskAgent,
}: {
  project: Project
  text: string
  taskId: string
  taskTitle: string
  onClose: () => void
  /** 交给对话里的角色整理；对话不能发消息时不提供 */
  onAskAgent?: (message: string) => Promise<void>
}) {
  const { setProjects } = useData()
  const firstLine = text.trim().split('\n')[0] ?? ''
  const [lesson, setLesson] = useState<ProjectLesson>(() => ({
    ...blankLesson(),
    title: firstLine.slice(0, 120),
    rule: text.trim().length > firstLine.length ? text.trim().slice(0, 1500) : '',
    cause: t('对话「{title}」里的纠正', { title: taskTitle }).slice(0, 500),
    taskId,
  }))
  const [saving, setSaving] = useState<'' | 'save' | 'agent'>('')
  const save = async () => {
    if (!lesson.title.trim() || saving) return
    setSaving('save')
    try {
      const p = await api.addProjectLesson(project.id, lesson)
      setProjects((ps) => ps.map((x) => (x.id === p.id ? p : x)))
      toast.success(t('已记进「{name}」的项目教训', { name: project.name }))
      onClose()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving('')
    }
  }
  const askAgent = async () => {
    if (!onAskAgent || saving) return
    setSaving('agent')
    try {
      await onAskAgent(
        `把我下面这条纠正整理成一条项目教训，用 record_lesson 记下来：写成以后换个场景也能照做的通用规则，具体事件写进起因，paths 填它管的文件或目录；同类的已经有了就更新那一条。\n\n> ${text.trim().split('\n').join('\n> ')}`,
      )
      onClose()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving('')
    }
  }
  return (
    <D.Root open onOpenChange={(o) => !o && onClose()}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/45 animate-[fade-in_150ms_ease-out]" />
        <D.Content
          aria-describedby={undefined}
          onInteractOutside={(e) => e.preventDefault()}
          className="fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[min(560px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-line-strong bg-card shadow-pop animate-[pop-in_160ms_ease-out] focus:outline-none"
        >
          <header className="flex shrink-0 items-center gap-2.5 border-b px-5 py-4">
            <GraduationCap className="h-[18px] w-[18px] shrink-0 text-accent" strokeWidth={1.8} />
            <D.Title className="min-w-0 flex-1 truncate font-serif text-[1.0625rem] font-semibold">
              {t('记成项目教训')}
            </D.Title>
          </header>
          <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-5 py-5">
            <p className="text-[0.78125rem] leading-relaxed text-subtle">
              {t(
                '记下来以后，这个项目里的角色改到相关文件时都会看到它。写成通用的规则（例如「新能力写进配置文件」），下次换个地方也用得上。',
              )}
            </p>
            <LessonFields autoFocus lesson={lesson} onChange={(p) => setLesson((l) => ({ ...l, ...p }))} />
          </div>
          <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t px-5 py-3.5">
            {onAskAgent && (
              <Button
                variant="ghost"
                disabled={!!saving}
                onClick={() => void askAgent()}
                title={t('把这条消息交给对话里的角色，由它结合刚才的上下文整理成规则再记')}
              >
                {saving === 'agent' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5" />
                )}
                {t('让角色整理')}
              </Button>
            )}
            <span className="flex-1" />
            <Button variant="secondary" onClick={onClose}>
              {t('取消')}
            </Button>
            <Button disabled={!lesson.title.trim() || !!saving} onClick={() => void save()}>
              {saving === 'save' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t('记下')}
            </Button>
          </footer>
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}
