import { useEffect, useState } from 'react'
import { toast } from '@/lib/toast'
import { ChevronDown, Lightbulb, Sparkles, Trash2 } from 'lucide-react'
import type { LessonDraftInput, LessonDraftRecord } from '@shared/lesson-draft'
import { lessonDraftProblems } from '@shared/lesson-draft'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input, Textarea } from '@/components/ui/input'
import { ConfirmDialog } from '@/components/ui/dialog'

/**
 * 候选教训草稿区：从工作总结报告里提炼的半成品，看、改、丢都在这里。
 * 默认收起：多数报告没有返工，展开一大块空区域会把「最近报告」挤到下面；
 * 头部一直显示已提炼几条，需要时点开。
 * 不会自动写进 docs/lessons/：落到哪个分片、怎么改成通用规则由用户决定，指引在底部。
 */
export function LessonDrafts({ reportId, day }: { reportId: string; day: string }) {
  const [drafts, setDrafts] = useState<LessonDraftRecord[]>([])
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    void api
      .lessonDrafts()
      .then((r) => setDrafts(r.drafts))
      .catch((e) => toast.error((e as Error).message))
  }, [])

  const extract = async () => {
    if (busy) return
    setBusy(true)
    try {
      const r = await api.extractLessonDrafts(reportId)
      setDrafts(r.drafts)
      if (r.created) toast.success(t('提炼了 {n} 条候选教训，改好再手动写进 docs/lessons/', { n: r.created }))
      else toast.info(r.info)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="rounded-xl border bg-panel" aria-label={t('候选教训草稿')}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer flex-wrap items-center gap-2 px-4 py-2 text-left hover:bg-sel"
      >
        <Lightbulb className="h-4 w-4 text-warning" />
        <span className="text-[0.8125rem] font-medium">{t('候选教训草稿')}</span>
        <span className="text-xs text-subtle">
          {drafts.length ? t('已提炼 {n} 条', { n: drafts.length }) : t('从报告里提炼返工过的做法')}
        </span>
        <ChevronDown className={cn('ml-auto h-4 w-4 text-subtle transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <>
          <div className="flex flex-wrap items-center gap-2 border-t px-4 py-2">
            <span className="text-xs text-subtle">{t('只生成草稿，确认后自己写进 docs/lessons/')}</span>
            <Button
              variant="secondary"
              size="sm"
              className="ml-auto"
              disabled={busy || !reportId}
              onClick={extract}
              title={t('从这份报告里找返工过的地方，生成候选草稿（同一份报告只提炼一次）')}
            >
              <Sparkles className="h-3.5 w-3.5 text-accent" />
              {t('从这份报告提炼')}
            </Button>
          </div>
          {drafts.length === 0 ? (
            <p className="px-4 py-3 text-[0.8125rem] text-subtle">
              {t('还没有草稿。报告里有用户报的 Bug 或返工过的条目时，点「从这份报告提炼」；没有就不生成，不硬造条目。')}
            </p>
          ) : (
            <ul className="flex flex-col gap-3 px-4 py-3">
              {drafts.map((d) => (
                <DraftCard
                  key={d.id}
                  draft={d}
                  onSaved={(next) => setDrafts((list) => list.map((x) => (x.id === next.id ? next : x)))}
                  onDeleted={(id) => setDrafts((list) => list.filter((x) => x.id !== id))}
                />
              ))}
            </ul>
          )}
          <p className="border-t px-4 py-2.5 text-xs leading-relaxed text-subtle">
            {t(
              '草稿不会自动写进 docs/lessons/：先看 docs/lessons/README.md 的分片表挑一个分片，把这条改成「下次能直接照做的通用规则」再手动写进去。标题一句话写「该怎么做」、规则写做什么不做什么（具体到文件或字段）、起因写哪次返工；每条不超过 6 行，单个分片不超过 6KB（scripts/rules-check.mjs 会检查）。能写成检查的，加进测试或 scripts/rules-check.mjs，分片里只留一行指针。',
            )}
          </p>
        </>
      )}
      {day && <span className="sr-only">{t('来自 {day} 的报告', { day })}</span>}
    </section>
  )
}

/** 一条草稿：标题、规则、起因、落到哪个分片；改完点保存，不要的丢掉 */
function DraftCard({
  draft,
  onSaved,
  onDeleted,
}: {
  draft: LessonDraftRecord
  onSaved: (d: LessonDraftRecord) => void
  onDeleted: (id: string) => void
}) {
  const [form, setForm] = useState<LessonDraftInput>({
    reportId: draft.reportId,
    day: draft.day,
    projectNames: draft.projectNames,
    title: draft.title,
    rule: draft.rule,
    cause: draft.cause,
    shard: draft.shard,
    source: draft.source,
  })
  const [busy, setBusy] = useState(false)
  const [del, setDel] = useState(false)
  const problems = lessonDraftProblems(form)
  const set = (patch: Partial<LessonDraftInput>) => setForm((f) => ({ ...f, ...patch }))

  const save = async () => {
    if (busy || problems.length) return
    setBusy(true)
    try {
      const next = await api.saveLessonDraft(draft.id, form)
      onSaved(next)
      toast.success(t('草稿已保存'))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="flex flex-col gap-2 rounded-lg border bg-field/40 p-3">
      <label className="flex flex-col gap-1">
        <span className="text-xs text-subtle">{t('标题（一句话写该怎么做）')}</span>
        <Input value={form.title} onChange={(e) => set({ title: e.target.value })} aria-label={t('草稿标题')} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-subtle">{t('规则（做什么、不做什么，具体到文件或字段）')}</span>
        <Textarea
          value={form.rule}
          onChange={(e) => set({ rule: e.target.value })}
          aria-label={t('草稿规则')}
          className="min-h-[88px] font-mono text-xs"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-subtle">{t('起因（哪次返工）')}</span>
        <Input value={form.cause} onChange={(e) => set({ cause: e.target.value })} aria-label={t('草稿起因')} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-subtle">{t('写进哪个分片（docs/lessons/ 下的文件名，留空表示还没定）')}</span>
        <Input
          value={form.shard}
          onChange={(e) => set({ shard: e.target.value })}
          aria-label={t('草稿分片')}
          placeholder={t('例如 testing.md')}
          className="max-w-[220px]"
        />
      </label>
      {draft.source && (
        <details className="text-xs text-subtle">
          <summary className="cursor-pointer">{t('提炼依据（报告里的原文）')}</summary>
          <pre className="mt-1 whitespace-pre-wrap font-mono text-[0.6875rem]">{draft.source}</pre>
        </details>
      )}
      {problems.length > 0 && (
        <ul className="rounded-md bg-warning/10 px-2.5 py-1.5 text-xs text-warning">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={busy || problems.length > 0} onClick={save}>
          {t('保存草稿')}
        </Button>
        <Button size="sm" variant="secondary" className="ml-auto" onClick={() => setDel(true)}>
          <Trash2 className="h-3.5 w-3.5" />
          {t('丢弃')}
        </Button>
      </div>
      <ConfirmDialog
        open={del}
        title={t('丢弃这条草稿？')}
        description={t('丢弃后这条草稿就没了；同一份报告不会自动再提炼，需要时得重新点一次提炼。')}
        confirmText={t('丢弃')}
        onOpenChange={setDel}
        onConfirm={async () => {
          await api.deleteLessonDraft(draft.id)
          onDeleted(draft.id)
          setDel(false)
          toast.success(t('已丢弃这条草稿'))
        }}
      />
    </li>
  )
}
