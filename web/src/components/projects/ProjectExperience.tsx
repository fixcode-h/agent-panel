import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, Loader2, Plus, Search, Sparkles, Trash2 } from 'lucide-react'
import {
  EXPERIENCE_KINDS,
  EXP_BODY_MAX,
  EXP_TITLE_MAX,
  experienceHaystack,
  experienceProblems,
  kindLabel,
  type ExperienceEdit,
  type ExperienceKind,
  type ExperienceListView,
  type ExperienceReviewView,
  type ProjectExperience as Experience,
} from '@shared/experience'
import { t } from '@shared/i18n'
import { experienceApi } from '@/lib/api-experience'
import { setProjectExperience } from '@/lib/experience-store'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { timeAgo } from '@/lib/tasks'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ChipGroup } from '@/components/ui/chip-group'
import { EmptyPanel } from '@/components/ui/empty-panel'
import { IconButton } from '@/components/ui/icon-button'
import { Field, Input, Select, Textarea } from '@/components/ui/input'

/** 输入框里的列表：逗号、顿号、换行都能分隔（路径里可能有空格，不按空格拆） */
const splitList = (s: string) =>
  s
    .split(/[,，、\n]+/)
    .map((x) => x.trim())
    .filter(Boolean)

const blank = (): ExperienceEdit => ({ kind: 'locate', title: '', body: '', keywords: [], paths: [], enabled: true })

type KindTab = ExperienceKind | 'all'

/**
 * 项目设置 →「经验」：整个对话完成后面板自动学到的条目（不用确认，学到就加），也能手动加、改、删。
 * 「AI 评审」逐条判断符不符合「经验记什么」：不该记的和写得太细的默认勾上，用户确认后删掉或换成精简写法。
 * 每次改动直接存进项目文档的 agent-knowledge/experience/（不跟项目设置的「确认」一起保存）
 */
export function ProjectExperience({
  projectId,
  initialOpen = '',
}: {
  projectId: string
  /**
   * 打开时展开哪一条（对话里经验卡片的「编辑」）；写 review 表示打开就开始 AI 评审（经验满了那张卡片的按钮）
   */
  initialOpen?: string
}) {
  const [data, setData] = useState<ExperienceListView>()
  const [error, setError] = useState('')
  const [q, setQ] = useState('')
  const [kind, setKind] = useState<KindTab>('all')
  const [open, setOpen] = useState(initialOpen === 'review' ? '' : initialOpen)
  const [adding, setAdding] = useState(false)
  const [review, setReview] = useState<ExperienceReviewView>()
  const [reviewing, setReviewing] = useState(false)
  useEffect(() => {
    experienceApi
      .list(projectId)
      .then((v) => {
        setData(v)
        setProjectExperience(projectId, v.items)
      })
      .catch((e: Error) => setError(e.message))
  }, [projectId])
  const items = useMemo(() => data?.items ?? [], [data])
  const query = useDeferredValue(q.trim().toLowerCase())
  const matched = useMemo(
    () => (query ? items.filter((e) => query.split(/\s+/).every((w) => experienceHaystack(e).includes(w))) : items),
    [items, query],
  )
  const shown = kind === 'all' ? matched : matched.filter((e) => e.kind === kind)
  // 对话里的经验卡片读同一份缓存：这里改了，卡片跟着变
  const setItems = (next: Experience[]) => {
    setData((d) => (d ? { ...d, items: next } : d))
    setProjectExperience(projectId, next)
  }
  const run = async (fn: () => Promise<{ items: Experience[] }>) => {
    try {
      setItems((await fn()).items)
      return true
    } catch (e) {
      toast.error((e as Error).message)
      return false
    }
  }
  const startReview = async () => {
    setReviewing(true)
    setReview(undefined)
    try {
      setReview(await experienceApi.review(projectId))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setReviewing(false)
    }
  }

  // 从「经验满了」卡片点进来：列表拉到就开始 AI 评审，只开一次
  const autoReview = useRef(initialOpen === 'review')
  useEffect(() => {
    if (!autoReview.current || !data?.items.length) return
    autoReview.current = false
    void startReview()
    // startReview 每次渲染都是新函数，只在列表拉到时跑一次
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [data])
  // 从对话里的卡片点「编辑」进来：滚到那一条
  useEffect(() => {
    if (data && initialOpen && initialOpen !== 'review')
      document.getElementById(`exp-${initialOpen}`)?.scrollIntoView({ block: 'center' })
  }, [data, initialOpen])
  if (error) return <EmptyPanel size="sm">{error}</EmptyPanel>
  if (!data)
    return (
      <div className="flex items-center gap-2 text-body text-subtle">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('读取中…')}
      </div>
    )
  const autoN = items.filter((e) => e.source === 'auto').length
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[12rem] flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
          <Input
            className="h-8 pl-8 text-xs"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('搜索标题、关键词、路径')}
            aria-label={t('搜索经验')}
          />
        </div>
        {autoN > 0 && <span className="text-xs text-subtle">{t('其中 {n} 条是自动学到的', { n: autoN })}</span>}
        <Button
          size="sm"
          variant="ghost"
          disabled={!items.length || reviewing}
          title={t('让 Agent 逐条判断符不符合「经验记什么」，不符合的和写得太细的列出来，你勾选后删掉或精简')}
          onClick={() => void startReview()}
        >
          {reviewing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          {reviewing ? t('评审中…') : t('AI 评审')}
        </Button>
        <Button size="sm" variant="secondary" onClick={() => setAdding(true)} disabled={adding}>
          <Plus className="h-3.5 w-3.5" />
          {t('加一条')}
        </Button>
      </div>
      {data.errors.length > 0 && (
        <p className="rounded-lg bg-warning/10 px-3 py-2 text-xs leading-relaxed text-warning">
          {t('这些文件格式不对，已跳过（没有改动它们）：{list}', { list: data.errors.join('；') })}
        </p>
      )}
      {review && (
        <ReviewPanel
          review={review}
          items={items}
          onClose={() => setReview(undefined)}
          onApply={async (input) => {
            if (await run(() => experienceApi.apply(projectId, input))) {
              toast.success(t('已处理 {n} 条', { n: (input.remove?.length ?? 0) + (input.trim?.length ?? 0) }))
              setReview(undefined)
            }
          }}
        />
      )}
      {adding && (
        <div className="rounded-xl bg-card px-3.5 py-3.5 shadow-card">
          <ExperienceForm
            initial={blank()}
            onCancel={() => setAdding(false)}
            onSave={async (e) => {
              if (await run(() => experienceApi.add(projectId, e))) setAdding(false)
            }}
          />
        </div>
      )}
      {items.length > 0 && (
        <ChipGroup
          label={t('按种类筛选')}
          size="sm"
          value={kind}
          onChange={setKind}
          options={[
            { id: 'all' as KindTab, label: t('全部'), trailing: matched.length },
            ...EXPERIENCE_KINDS.map((k) => ({
              id: k as KindTab,
              label: kindLabel(k),
              trailing: matched.filter((e) => e.kind === k).length,
            })),
          ]}
        />
      )}
      {items.length === 0 && !adding && (
        <EmptyPanel size="sm" className="text-xs leading-relaxed">
          {t(
            '还没有经验。整个对话完成后，面板会看这次是不是绕了很多路才找到地方、命令是不是试了几次才成，值得的话自动记一条；也可以在这里手动加。',
          )}
        </EmptyPanel>
      )}
      {items.length > 0 && shown.length === 0 && <p className="px-1 text-xs text-subtle">{t('没有匹配的经验')}</p>}
      <ul className="flex flex-col gap-2">
        {shown.map((e) => {
          const expanded = open === e.id
          return (
            <li
              key={e.id}
              id={`exp-${e.id}`}
              className={cn('rounded-xl bg-card shadow-card', !e.enabled && 'opacity-60')}
            >
              <div className="flex items-center gap-2 px-3 py-2">
                <button
                  type="button"
                  onClick={() => setOpen(expanded ? '' : e.id)}
                  aria-expanded={expanded}
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-left"
                >
                  <ChevronRight
                    className={cn('h-4 w-4 shrink-0 text-subtle transition-transform', expanded && 'rotate-90')}
                    strokeWidth={2.3}
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-body font-medium">{e.title}</span>
                    <span className="flex min-w-0 items-center gap-2 text-caption text-subtle">
                      <span className="truncate font-mono">{e.paths.join('  ')}</span>
                      {e.keywords.length > 0 && (
                        <span className="shrink-0 truncate">{e.keywords.map((x) => `#${x}`).join(' ')}</span>
                      )}
                    </span>
                  </span>
                  <Badge className="shrink-0 text-caption">{kindLabel(e.kind)}</Badge>
                  {e.source === 'auto' && (
                    <Badge tone="accent" className="shrink-0 text-caption" title={t('整个对话完成后面板自动学到的')}>
                      {t('自动学到')}
                    </Badge>
                  )}
                </button>
                <Checkbox
                  checked={e.enabled}
                  onChange={(v) => void run(() => experienceApi.update(projectId, e.id, { ...e, enabled: v }))}
                  label={t('启用')}
                  className="shrink-0 items-center"
                />
                <IconButton
                  icon={Trash2}
                  size="sm"
                  label={t('删除这条经验')}
                  onClick={() => void run(() => experienceApi.apply(projectId, { remove: [e.id] }))}
                />
              </div>
              {expanded && (
                <div className="flex flex-col gap-3 border-t px-3.5 py-3.5">
                  <ExperienceForm
                    initial={e}
                    onCancel={() => setOpen('')}
                    onSave={async (x) => {
                      if (await run(() => experienceApi.update(projectId, e.id, x))) setOpen('')
                    }}
                  />
                  <p className="text-caption text-subtle">
                    {[
                      e.source === 'auto' ? t('自动学到') : t('手动添加'),
                      e.createdAt && timeAgo(e.createdAt),
                      e.updatedAt && t('{time}改过', { time: timeAgo(e.updatedAt) }),
                      e.branch && t('在 {branch} 分支学到', { branch: e.branch }),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>
              )}
            </li>
          )
        })}
      </ul>
      {data.dir && <p className="px-1 text-caption break-all text-subtle">{t('存在 {dir}', { dir: data.dir })}</p>}
    </div>
  )
}

/** 加 / 改一条：保存前按「经验记什么」的字数和条数校验，不合格的在按钮上方说清楚 */
function ExperienceForm({
  initial,
  onSave,
  onCancel,
}: {
  initial: ExperienceEdit
  onSave: (e: ExperienceEdit) => Promise<void>
  onCancel: () => void
}) {
  const [e, setE] = useState(initial)
  const [keywords, setKeywords] = useState(initial.keywords.join(', '))
  const [paths, setPaths] = useState(initial.paths.join(', '))
  const [busy, setBusy] = useState(false)
  const next = { ...e, keywords: splitList(keywords), paths: splitList(paths) }
  const problems = experienceProblems(next)
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
        <Field label={t('种类')}>
          <Select
            aria-label={t('经验的种类')}
            value={e.kind}
            onChange={(x) => setE({ ...e, kind: x.target.value as ExperienceKind })}
            options={EXPERIENCE_KINDS.map((k) => ({ value: k, label: kindLabel(k) }))}
          />
        </Field>
        <Field label={t('标题')} hint={t('一句话：要做的事 + 去哪 / 用什么')}>
          <Input
            autoFocus={!initial.title}
            value={e.title}
            maxLength={EXP_TITLE_MAX}
            onChange={(x) => setE({ ...e, title: x.target.value })}
            placeholder={t('例如：表格相关的代码和配置在哪')}
          />
        </Field>
      </div>
      <Field label={t('关键词')} hint={t('你的说法和代码里的叫法都写上，逗号分隔；Agent 按它查')}>
        <Input
          value={keywords}
          onChange={(x) => setKeywords(x.target.value)}
          placeholder={t('例如：表格, 配表, DataTable')}
        />
      </Field>
      <Field label={t('位置')} hint={t('目录或 glob（相对项目根），命令类写命令本身；写到目录为止，最多 4 个')}>
        <Input
          className="font-mono text-xs"
          value={paths}
          onChange={(x) => setPaths(x.target.value)}
          placeholder="Source/Game/Table/, Content/DataTables/"
        />
      </Field>
      <Field label={t('说明')} hint={t('一两句就够：经验是指路牌，不是文档')}>
        <Textarea
          rows={2}
          value={e.body}
          maxLength={EXP_BODY_MAX}
          onChange={(x) => setE({ ...e, body: x.target.value })}
        />
      </Field>
      {problems.length > 0 && (e.title || keywords) && <p className="text-xs text-danger">{problems.join('；')}</p>}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t('取消')}
        </Button>
        <Button
          size="sm"
          disabled={busy || problems.length > 0}
          onClick={async () => {
            setBusy(true)
            await onSave(next).finally(() => setBusy(false))
          }}
        >
          {t('保存')}
        </Button>
      </div>
    </div>
  )
}

/** AI 评审的结论：不该记的、写得太细的默认勾上；符合的只报个数，展开能看依据 */
function ReviewPanel({
  review,
  items,
  onClose,
  onApply,
}: {
  review: ExperienceReviewView
  items: Experience[]
  onClose: () => void
  onApply: (input: { remove: string[]; trim: { id: string; title: string; body: string }[] }) => Promise<void>
}) {
  const byId = new Map(items.map((e) => [e.id, e]))
  const bad = review.verdicts.filter((v) => v.verdict !== 'keep' && byId.has(v.id))
  const good = review.verdicts.filter((v) => v.verdict === 'keep' && byId.has(v.id))
  const [picked, setPicked] = useState(() => new Set(bad.map((v) => v.id)))
  const [showGood, setShowGood] = useState(false)
  const [busy, setBusy] = useState(false)
  const toggle = (id: string, on: boolean) =>
    setPicked((s) => {
      const n = new Set(s)
      if (on) n.add(id)
      else n.delete(id)
      return n
    })
  const chosen = bad.filter((v) => picked.has(v.id))
  return (
    <div className="flex flex-col gap-2.5 rounded-xl bg-card px-3.5 py-3 shadow-card">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-body font-medium">{t('AI 评审结果')}</span>
        <span className="text-xs text-subtle">
          {t('符合 {good} 条，不符合或写得太细 {bad} 条', { good: good.length, bad: bad.length })}
          {review.total && review.total > review.verdicts.length
            ? t('（只评了前 {n} 条）', { n: review.verdicts.length })
            : ''}
        </span>
      </div>
      {bad.length === 0 && <p className="text-xs text-subtle">{t('都符合「经验记什么」，不用清理。')}</p>}
      <ul className="flex flex-col gap-1.5">
        {bad.map((v) => {
          const e = byId.get(v.id)!
          return (
            <li key={v.id} className="flex items-start gap-2.5 rounded-lg bg-panel px-2.5 py-2">
              <Checkbox
                checked={picked.has(v.id)}
                onChange={(on) => toggle(v.id, on)}
                label={v.verdict === 'delete' ? t('删除') : t('精简')}
                className="shrink-0 pt-0.5"
              />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    className={cn('truncate text-body', v.verdict === 'delete' && 'line-through decoration-subtle')}
                  >
                    {e.title}
                  </span>
                  <Badge tone={v.verdict === 'delete' ? 'danger' : 'warning'} className="shrink-0 text-caption">
                    {v.verdict === 'delete' ? t('不该记') : t('写得太细')}
                  </Badge>
                </span>
                <span className="text-xs leading-relaxed text-subtle">{v.why}</span>
                {v.verdict === 'trim' && v.title && (
                  <span className="text-xs leading-relaxed text-muted">
                    {t('精简为：{text}', { text: [v.title, v.body].filter(Boolean).join(' — ') })}
                  </span>
                )}
              </span>
            </li>
          )
        })}
      </ul>
      {good.length > 0 && (
        <button
          type="button"
          className="self-start text-xs text-subtle hover:text-fg"
          onClick={() => setShowGood((x) => !x)}
          aria-expanded={showGood}
        >
          {showGood ? t('收起符合的 {n} 条', { n: good.length }) : t('看符合的 {n} 条', { n: good.length })}
        </button>
      )}
      {showGood && (
        <ul className="flex flex-col gap-1 pl-1">
          {good.map((v) => (
            <li key={v.id} className="text-xs leading-relaxed text-subtle">
              <span className="text-muted">{byId.get(v.id)!.title}</span> — {v.why}
            </li>
          ))}
        </ul>
      )}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onClose}>
          {t('关闭')}
        </Button>
        <Button
          size="sm"
          disabled={!chosen.length || busy}
          onClick={async () => {
            setBusy(true)
            await onApply({
              remove: chosen.filter((v) => v.verdict === 'delete').map((v) => v.id),
              trim: chosen
                .filter((v) => v.verdict === 'trim' && v.title)
                .map((v) => ({ id: v.id, title: v.title!, body: v.body ?? '' })),
            }).finally(() => setBusy(false))
          }}
        >
          {t('处理勾选的 {n} 条', { n: chosen.length })}
        </Button>
      </div>
    </div>
  )
}
