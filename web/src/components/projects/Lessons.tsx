import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import * as D from '@radix-ui/react-dialog'
import { toast } from '@/lib/toast'
import { ChevronRight, GraduationCap, Loader2, Plus, RotateCcw, Search, Sparkles, Trash2 } from 'lucide-react'
import type { GlobalLesson, Project, ProjectLesson } from '@shared/schema'
import {
  DEFAULT_TAB,
  applyGlobalChanges,
  inTab,
  lessonHaystack,
  lessonTabs,
  newGlobalLessonId,
  newLessonId,
  normTags,
  queryMatcher,
  tagCounts,
} from '@shared/lessons'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { useData, useNav } from '@/lib/data'
import { Button } from '@/components/ui/button'
import { Field, Input, Textarea } from '@/components/ui/input'
import { ConfirmDialog } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { timeAgo } from '@/lib/tasks'
import { AssistDialog } from '@/components/assist/AssistDialog'
import { AnalyzeDialog } from '@/components/tasks/Evolution'
import { startLessonReview } from '@/lib/task-transfer'

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
  tags: [],
  enabled: true,
  source: 'user',
  taskId: '',
  createdAt: new Date().toISOString(),
  updatedAt: '',
  history: [],
})

/** 列表一次画多少条：上万条一次全画出来要好几秒，搜索框也会一个字卡一秒 */
const PAGE = 100

/**
 * 项目设置里的「教训」：增删改、启停，Agent 自己记的标出来方便复查。
 * 和别的设置一样改完点「确认」才保存
 */
export function LessonsEditor({
  lessons,
  onChange,
  project,
  initialOpen,
}: {
  lessons: ProjectLesson[]
  onChange: (v: ProjectLesson[]) => void
  /** 已保存的项目：有它才能用 AI 提取全局教训（按保存过的教训提取） */
  project?: Project
  /** 打开时展开的那条（项目首页点进来的） */
  initialOpen?: string
}) {
  const [q, setQ] = useState('')
  // 当前页签：DEFAULT_TAB 是「默认」，放一个标签都没有的教训；任何时候都有一个页签选中
  const [tab, setTab] = useState(() => lessons.find((l) => l.id === initialOpen)?.tags[0] ?? DEFAULT_TAB)
  const [limit, setLimit] = useState(PAGE)
  // 新加的那条直接展开，其余默认收起：条目多了一屏也看得过来
  const [open, setOpen] = useState<string>(initialOpen ?? '')
  const [extracting, setExtracting] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const patch = (id: string, p: Partial<ProjectLesson>) =>
    onChange(lessons.map((l) => (l.id === id ? { ...l, ...p } : l)))
  // 搜索按延后的值算：输入框先跟手，过滤和重画排在后面
  const query = useDeferredValue(q.trim())
  // 小写的全文按条目缓存：改了哪条才重算哪条，搜索时不用每个字都把上万条重新拼一遍
  const hay = useMemo(() => {
    const m = new WeakMap<ProjectLesson, string>()
    return (l: ProjectLesson) => {
      let h = m.get(l)
      if (h === undefined) m.set(l, (h = lessonHaystack(l)))
      return h
    }
  }, [])
  const tags = useMemo(() => tagCounts(lessons), [lessons])
  // 先按搜索词筛，页签上的数字跟着变：在一个页签里搜不到时，看数字就知道该去哪个页签找
  const matched = useMemo(() => {
    const match = queryMatcher(query)
    return query ? lessons.filter((l) => match(hay(l))) : lessons
  }, [lessons, query, hay])
  const tabs = useMemo(() => lessonTabs(matched, tags), [matched, tags])
  // 选中的标签被删光了（改了标签、删了条目）就回到「默认」，保证总有一个页签选中
  const current = tab === DEFAULT_TAB || tags.some(([x]) => x === tab) ? tab : DEFAULT_TAB
  const filtered = useMemo(() => matched.filter((l) => inTab(l, current)), [matched, current])
  // 正在展开的那条（项目首页点进来的、刚加的、刚改了标签的）不在这一页或这个页签里也要画出来，免得改着改着不见了
  const shown = useMemo(() => {
    const page = filtered.slice(0, limit)
    const extra = open && !page.some((l) => l.id === open) ? lessons.find((l) => l.id === open) : undefined
    return extra ? [extra, ...page] : page
  }, [filtered, limit, open, lessons])
  // 换了搜索词或页签从头显示
  useEffect(() => setLimit(PAGE), [query, current])
  const fromAgent = lessons.filter((l) => l.source === 'agent').length
  const dirty = useMemo(
    () => !!project && JSON.stringify(project.lessons) !== JSON.stringify(lessons),
    [project, lessons],
  )
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[12rem] flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
          <Input
            className="h-8 pl-8 text-xs"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('搜索规则、起因、文件或标签')}
            aria-label={t('搜索教训')}
          />
        </div>
        {fromAgent > 0 && (
          <span className="text-xs text-subtle">{t('其中 {n} 条是角色自己记的', { n: fromAgent })}</span>
        )}
        {project && (
          <Button
            size="sm"
            variant="ghost"
            // 评审的是已保存的教训；草稿改了没保存时先保存，免得评审的和眼前看到的对不上
            disabled={!project.lessons.length || dirty}
            title={
              dirty
                ? t('教训有没保存的修改，先点「确认」保存再评审')
                : t(
                    '在这个项目里开一个分析对话，逐条看教训是否必须、是否合理、能否优化、是否过期，建议逐条确认后才应用',
                  )
            }
            onClick={() => setReviewing(true)}
          >
            <GraduationCap className="h-3.5 w-3.5" />
            {t('AI 评审')}
          </Button>
        )}
        {project && (
          <Button
            size="sm"
            variant="ghost"
            disabled={!project.lessons.some((l) => l.enabled)}
            title={t('让本机 Agent 从已保存的项目教训里挑出换个项目也适用的，逐条确认后写进全局教训')}
            onClick={() => setExtracting(true)}
          >
            <Sparkles className="h-3.5 w-3.5" />
            {t('提取全局教训')}
          </Button>
        )}
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            // 在某个标签的页签里加的，带上这个标签，加完还留在这个页签里
            const l = { ...blankLesson(), tags: current === DEFAULT_TAB ? [] : [current] }
            onChange([l, ...lessons])
            setOpen(l.id)
            setQ('')
          }}
        >
          <Plus className="h-3.5 w-3.5" />
          {t('加一条')}
        </Button>
      </div>
      {lessons.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label={t('按标签分页')}>
          {tabs.map(([x, n]) => (
            <button
              key={x}
              type="button"
              role="tab"
              aria-selected={current === x}
              // 再点一次选中的页签不取消：总要有一个页签选中
              onClick={() => setTab(x)}
              className={cn(
                'cursor-pointer rounded-full border px-2.5 py-0.5 text-[0.6875rem] transition-colors',
                current === x ? 'border-accent bg-accent-soft text-accent' : 'text-muted hover:bg-sel/70 hover:text-fg',
              )}
            >
              {x === DEFAULT_TAB ? t('默认') : x}
              <span className="ml-1 text-subtle">{n}</span>
            </button>
          ))}
        </div>
      )}
      {lessons.length === 0 && (
        <p className="rounded-xl border border-dashed px-4 py-5 text-center text-xs leading-relaxed text-subtle">
          {t(
            '还没有教训。对话里纠正了角色的做法时，它会自己记一条；也可以在对话里用户消息下面的「记成项目教训」，或者在这里手动加。',
          )}
        </p>
      )}
      {lessons.length > 0 && filtered.length === 0 && (
        <p className="px-1 text-xs text-subtle">
          {query
            ? t('这个页签里没有匹配的教训')
            : current === DEFAULT_TAB
              ? t('没有不带标签的教训，带标签的在各自的页签里')
              : t('这个页签里没有教训')}
        </p>
      )}
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
                    <span className="flex min-w-0 items-center gap-2 text-[0.6875rem] text-subtle">
                      <span className="truncate font-mono">{l.paths.length ? l.paths.join('  ') : t('所有改动')}</span>
                      {l.tags.length > 0 && (
                        <span className="shrink-0 truncate">{l.tags.map((x) => `#${x}`).join(' ')}</span>
                      )}
                    </span>
                  </span>
                  {l.history.length > 0 && (
                    <span
                      className="shrink-0 rounded-full border px-2 py-0.5 text-[0.6875rem] text-muted"
                      title={t('你的新要求和它冲突时，角色找了两全的做法改写过它；展开看改写记录')}
                    >
                      {t('已改写')}
                    </span>
                  )}
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
                  <LessonFields lesson={l} knownTags={tags} onChange={(p) => patch(l.id, p)} />
                  {l.history.length > 0 && <LessonHistory lesson={l} onRestore={(p) => patch(l.id, p)} />}
                </div>
              )}
            </li>
          )
        })}
      </ul>
      {filtered.length > limit && (
        <Button size="sm" variant="ghost" className="self-center" onClick={() => setLimit((n) => n + PAGE)}>
          {t('再显示 {n} 条（还有 {left} 条）', {
            n: Math.min(PAGE, filtered.length - limit),
            left: filtered.length - limit,
          })}
        </Button>
      )}
      {project && <ExtractGlobalLessons project={project} open={extracting} onOpenChange={setExtracting} />}
      {project && (
        <AnalyzeDialog
          open={reviewing}
          onOpenChange={setReviewing}
          title={t('AI 评审项目教训')}
          intro={t(
            'AI 会逐条看已保存的 {n} 条教训：是否必须、是否合理、能不能写得更好、提到的文件和做法是否已经过期、有没有重复。结果在对话里列成建议，每条要你点「应用」才会改，不会自动改。',
            { n: project.lessons.length },
          )}
          placeholder={t('例如：角色自己记的那些、和测试有关的')}
          subject={t('项目教训')}
          start={(focus) => startLessonReview({ project, focus })}
        />
      )}
    </div>
  )
}

/** 改写记录：每一版的规则和为什么改，可以恢复成那一版（恢复也只改草稿，确认保存才生效） */
function LessonHistory({
  lesson,
  onRestore,
}: {
  lesson: ProjectLesson
  onRestore: (p: Partial<ProjectLesson>) => void
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium text-muted">{t('改写记录')}</span>
      <ol className="flex flex-col gap-2">
        {lesson.history.map((h, i) => (
          <li key={i} className="flex flex-col gap-1 rounded-lg border border-dashed px-3 py-2 text-xs">
            <span className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-muted">{t('原来：{text}', { text: h.title })}</span>
              {h.at && <span className="shrink-0 text-subtle">{timeAgo(h.at)}</span>}
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs"
                onClick={() =>
                  onRestore({
                    title: h.title,
                    rule: h.rule,
                    history: [
                      {
                        title: lesson.title,
                        rule: lesson.rule,
                        why: t('手动恢复成之前的版本'),
                        at: new Date().toISOString(),
                      },
                      ...lesson.history.filter((_, j) => j !== i),
                    ].slice(0, 5),
                  })
                }
              >
                <RotateCcw className="h-3 w-3" />
                {t('恢复')}
              </Button>
            </span>
            {h.rule && <span className="leading-relaxed text-subtle">{h.rule}</span>}
            {h.why && <span className="text-subtle">{t('为什么改：{text}', { text: h.why })}</span>}
          </li>
        ))}
      </ol>
    </div>
  )
}

/** 「提取全局教训」：本机 Agent 挑出通用的条目，用户在预览里逐条勾选，确认后才写进全局教训 */
function ExtractGlobalLessons({
  project,
  open,
  onOpenChange,
}: {
  project: Project
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const [globals, setGlobals] = useState<GlobalLesson[]>([])
  useEffect(() => {
    if (!open) return
    api
      .globalLessons()
      .then(setGlobals)
      .catch((e) => toast.error((e as Error).message))
  }, [open])
  return (
    <AssistDialog
      open={open}
      onOpenChange={onOpenChange}
      kind="lessons"
      projectId={project.id}
      globalLessons={globals}
      onApply={async (p) => {
        if (p.kind !== 'lessons' || !p.changes.length) return
        // 写之前再读一次：别的项目刚确认过的改动不被这次盖掉
        const latest = await api.globalLessons()
        await api.saveGlobalLessons(applyGlobalChanges(latest, p.changes, project.name))
        toast.success(t('已写入 {n} 条全局教训', { n: p.changes.length }))
      }}
    />
  )
}

/** 一条教训的输入项：设置页和「记成项目教训」弹窗共用 */
type LessonText = Pick<ProjectLesson, 'title' | 'rule' | 'cause' | 'paths'> & { tags?: string[] }

function LessonFields({
  lesson,
  onChange,
  autoFocus,
  global,
  knownTags = [],
}: {
  lesson: LessonText
  onChange: (p: Partial<LessonText>) => void
  autoFocus?: boolean
  /** 这个项目已有的标签（按用的条数排好）：点一下加上，少造近义词 */
  knownTags?: [string, number][]
  /** 全局教训：范围一般不写，说明换成全局的口径 */
  global?: boolean
}) {
  // 范围在输入时保留原样（含末尾的逗号），离开输入框再拆成列表
  const [paths, setPaths] = useState(lesson.paths.join(', '))
  const [tagText, setTagText] = useState((lesson.tags ?? []).join(', '))
  const known = knownTags.map(([x]) => x)
  const setTags = (list: string[]) => {
    const v = normTags(list, known)
    setTagText(v.join(', '))
    onChange({ tags: v })
  }
  const suggest = known.filter((x) => !(lesson.tags ?? []).includes(x)).slice(0, 8)
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
        hint={
          global
            ? t('一般不写：每个项目的目录不一样。写了就按相对项目根的路径匹配。')
            : t(
                '相对项目根，** 跨目录，写目录名也行，逗号分隔；不写表示所有改动都适用。按文件生效的条目平时只给角色看标题，改到这些文件时它再取全文。',
              )
        }
      >
        <Input
          className="font-mono text-xs"
          value={paths}
          onChange={(e) => setPaths(e.target.value)}
          onBlur={() => onChange({ paths: splitPaths(paths) })}
          placeholder="src/payment/**, docs/api.md"
        />
      </Field>
      {!global && lesson.tags && (
        <Field
          label={t('标签')}
          hint={t('按主题归类，最多 5 个，逗号分隔；能按标签筛选，角色也能按标签查不对应具体文件的条目')}
        >
          <Input
            value={tagText}
            onChange={(e) => setTagText(e.target.value)}
            onBlur={() => setTags(splitPaths(tagText))}
            placeholder={t('例如：并发, 测试')}
          />
          {suggest.length > 0 && (lesson.tags?.length ?? 0) < 5 && (
            <span className="flex flex-wrap items-center gap-1.5 pt-1.5">
              {suggest.map((x) => (
                <button
                  key={x}
                  type="button"
                  onClick={() => setTags([...(lesson.tags ?? []), x])}
                  className="cursor-pointer rounded-full border px-2 py-0.5 text-[0.6875rem] text-muted hover:bg-sel/70 hover:text-fg"
                >
                  + {x}
                </button>
              ))}
            </span>
          )}
        </Field>
      )}
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
            <LessonFields
              autoFocus
              lesson={lesson}
              knownTags={tagCounts(project.lessons)}
              onChange={(p) => setLesson((l) => ({ ...l, ...p }))}
            />
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

/** 按最近记下或改写的时间排，新的在前 */
const lessonTime = (l: { createdAt: string; updatedAt: string }) => l.updatedAt || l.createdAt

/**
 * 项目首页的「项目教训」：列出最近记下或改写的几条，点一条打开项目设置的「教训」并展开它。
 * 角色自己记的、改写过的标出来，方便用户顺手复查
 */
export function ProjectLessonsCard({ project }: { project: Project }) {
  const { openProject } = useNav()
  const all = project.lessons
  const recent = [...all].sort((a, b) => lessonTime(b).localeCompare(lessonTime(a))).slice(0, 5)
  const fromAgent = all.filter((l) => l.source === 'agent').length
  return (
    <section className="flex flex-col">
      <h2 className="mb-2 flex items-center gap-1.5 px-1 text-xs font-medium text-subtle">
        <GraduationCap className="h-3.5 w-3.5" aria-hidden />
        <span className="flex-1">{t('项目教训 · {n}', { n: all.length })}</span>
        {fromAgent > 0 && <span className="font-normal">{t('其中 {n} 条是角色自己记的', { n: fromAgent })}</span>}
        {all.length > 0 && (
          <button
            type="button"
            className="cursor-pointer rounded px-1 font-normal text-accent hover:underline"
            onClick={() => openProject(project.id, 'lessons')}
          >
            {t('全部')}
          </button>
        )}
      </h2>
      {all.length === 0 ? (
        <button
          type="button"
          onClick={() => openProject(project.id, 'lessons')}
          className="cursor-pointer rounded-xl border border-dashed px-4 py-5 text-center text-[0.8125rem] leading-relaxed text-subtle transition-colors hover:bg-field/40"
        >
          {t('还没有教训。角色被纠正、或发现自己走了弯路换了做法时，会自己记一条，下次就不再犯。')}
        </button>
      ) : (
        <ul className="flex flex-col divide-y overflow-hidden rounded-xl border bg-card">
          {recent.map((l) => (
            <li key={l.id}>
              <button
                type="button"
                onClick={() => openProject(project.id, 'lessons', l.id)}
                className={cn(
                  'flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-field/50',
                  !l.enabled && 'opacity-60',
                )}
              >
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-[0.8125rem]">{l.title}</span>
                  <span className="truncate font-mono text-[0.6875rem] text-subtle">
                    {l.paths.length ? l.paths.join('  ') : t('所有改动')}
                  </span>
                </span>
                {l.history.length > 0 && (
                  <span className="shrink-0 rounded-full border px-2 py-0.5 text-[0.6875rem] text-muted">
                    {t('已改写')}
                  </span>
                )}
                {l.source === 'agent' && (
                  <span className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-[0.6875rem] text-accent">
                    {t('角色记录')}
                  </span>
                )}
                {!l.enabled && <span className="shrink-0 text-[0.6875rem] text-subtle">{t('停用')}</span>}
                {lessonTime(l) && (
                  <span className="w-16 shrink-0 text-right text-xs text-subtle">{timeAgo(lessonTime(l))}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

const blankGlobal = (): GlobalLesson => ({
  id: newGlobalLessonId(),
  title: '',
  rule: '',
  cause: '',
  paths: [],
  enabled: true,
  from: [],
  createdAt: new Date().toISOString(),
  updatedAt: '',
})

/** 草稿和已保存的比，数出新加、改了、删了几条，确认时给用户看 */
function globalDiff(saved: GlobalLesson[], draft: GlobalLesson[]) {
  const same = (a: GlobalLesson, b: GlobalLesson) => JSON.stringify(a) === JSON.stringify(b)
  return {
    added: draft.filter((l) => !saved.some((x) => x.id === l.id)),
    changed: draft.filter((l) => saved.some((x) => x.id === l.id && !same(x, l))),
    removed: saved.filter((l) => !draft.some((x) => x.id === l.id)),
  }
}

/**
 * 设置里的「全局教训」：所有项目的对话都会带上。角色改不了它；
 * 这里的增删改先停在草稿里，点「保存」再确认一次才写进去
 */
export function GlobalLessonsSection() {
  const [saved, setSaved] = useState<GlobalLesson[] | null>(null)
  const [draft, setDraft] = useState<GlobalLesson[]>([])
  const [open, setOpen] = useState('')
  const [confirming, setConfirming] = useState(false)
  useEffect(() => {
    api
      .globalLessons()
      .then((ls) => {
        setSaved(ls)
        setDraft(ls)
      })
      .catch((e) => toast.error((e as Error).message))
  }, [])
  const patch = (id: string, p: Partial<GlobalLesson>) =>
    setDraft((ls) => ls.map((l) => (l.id === id ? { ...l, ...p } : l)))
  const diff = globalDiff(saved ?? [], draft)
  const dirty = diff.added.length + diff.changed.length + diff.removed.length > 0
  const invalid = draft.some((l) => !l.title.trim())
  const save = async () => {
    try {
      const now = new Date().toISOString()
      const changed = new Set(diff.changed.map((l) => l.id))
      const ls = await api.saveGlobalLessons(draft.map((l) => (changed.has(l.id) ? { ...l, updatedAt: now } : l)))
      setSaved(ls)
      setDraft(ls)
      setConfirming(false)
      toast.success(t('全局教训已保存'))
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  if (!saved) return <Loader2 className="h-4 w-4 animate-spin text-subtle" />
  return (
    <div className="flex max-w-[760px] flex-col gap-4">
      <p className="text-[0.8125rem] leading-relaxed text-muted">
        {t(
          '全局教训会带进所有项目的对话，优先级低于项目教训和你当次的要求。角色改不了它：在项目设置的「教训」里用「提取全局教训」从项目教训里挑出通用的，或者在这里手动加；所有修改都要你确认后才保存。',
        )}
      </p>
      <div className="flex items-center gap-2">
        <span className="flex-1 text-xs text-subtle">{t('{n} 条', { n: draft.length })}</span>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            const l = blankGlobal()
            setDraft((ls) => [l, ...ls])
            setOpen(l.id)
          }}
        >
          <Plus className="h-3.5 w-3.5" />
          {t('加一条')}
        </Button>
      </div>
      {draft.length === 0 && (
        <p className="rounded-xl border border-dashed px-4 py-5 text-center text-xs leading-relaxed text-subtle">
          {t('还没有全局教训。项目教训攒了一些以后，到项目设置的「教训」里点「提取全局教训」。')}
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {draft.map((l) => {
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
                    <span className="truncate text-[0.6875rem] text-subtle">
                      {l.from.length ? t('来自 {names}', { names: l.from.join('、') }) : t('手动添加')}
                    </span>
                  </span>
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
                  onClick={() => setDraft((ls) => ls.filter((x) => x.id !== l.id))}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
              {expanded && (
                <div className="flex flex-col gap-3 border-t px-3.5 py-3.5">
                  <LessonFields global lesson={l} onChange={(p) => patch(l.id, p)} />
                </div>
              )}
            </li>
          )
        })}
      </ul>
      {dirty && (
        <div className="sticky bottom-0 flex items-center gap-2 rounded-xl border bg-card px-4 py-2.5 shadow-pop">
          <span className="flex-1 text-xs text-muted">{t('有未保存的修改，确认后才会生效')}</span>
          <Button size="sm" variant="ghost" onClick={() => setDraft(saved)}>
            {t('撤销')}
          </Button>
          <Button size="sm" disabled={invalid} onClick={() => setConfirming(true)}>
            {t('保存…')}
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('修改全局教训？')}
        confirmText={t('确认修改')}
        onConfirm={save}
        description={
          <span className="flex flex-col gap-1.5">
            <span>{t('全局教训会带进所有项目的对话。这次的修改：')}</span>
            {diff.added.length > 0 && <span>{t('新加 {n} 条', { n: diff.added.length })}</span>}
            {diff.changed.map((l) => (
              <span key={l.id}>{t('改了「{title}」', { title: l.title })}</span>
            ))}
            {diff.removed.map((l) => (
              <span key={l.id}>{t('删掉「{title}」', { title: l.title })}</span>
            ))}
          </span>
        }
      />
    </div>
  )
}
