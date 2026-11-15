import { useState } from 'react'
import { ArrowRight, Check, Compass, SearchX, ShieldAlert, X } from 'lucide-react'
import type { Project } from '@shared/schema'
import type { KnowledgeCandidate } from '@shared/knowledge/candidate'
import { t } from '@shared/i18n'
import { knowledgeApi } from '@/lib/api-experience'
import { useData } from '@/lib/data'
import { toast } from '@/lib/toast'
import { timeAgo } from '@/lib/tasks'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { EmptyPanel } from '@/components/ui/empty-panel'
import { PageIntro } from '../settings/parts'
import { useKnowledgeState } from './use-knowledge-state'

/**
 * 项目设置 →「候选」：面板从「失败后改对」机械捕获的、子对话记下的教训和经验（shared/knowledge/candidate.ts），
 * 用户逐条收下或忽略；下面列出 Agent 搜了、查了却没配上任何经验的查询。改动直接保存，不走「确认」
 */
export function CandidatesPage({ project }: { project: Project }) {
  const { setProjects } = useData()
  const { state, error, reload } = useKnowledgeState(project.id)
  const [busy, setBusy] = useState('')
  const act = async (c: KnowledgeCandidate, action: 'accept' | 'dismiss') => {
    setBusy(c.id)
    try {
      const r = await knowledgeApi.candidate(project.id, c.id, action)
      if (!r.ok) toast.error(r.info)
      else {
        const p = r.project
        if (p) setProjects((ps) => ps.map((x) => (x.id === p.id ? p : x)))
        toast.success(r.info || (action === 'accept' ? t('已收下') : t('已忽略')))
      }
      await reload()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy('')
    }
  }
  const list = state?.candidates ?? []
  const misses = [...(state?.misses ?? [])].sort((a, b) => b.count - a.count)
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-4">
      <PageIntro
        title={t('候选')}
        desc={t(
          '还没生效的教训和经验：命令失败后换了做法才成功时，面板会记下失败的命令、报错和改对的命令；同一个报错在另一个对话里再出现就自动转成教训。子对话记下的也先放在这里。收下就写进项目教训或经验，忽略就删掉。这里的改动直接保存。',
        )}
      />
      {error && <p className="text-footnote text-danger">{error}</p>}
      {state && list.length === 0 && (
        <EmptyPanel size="sm" className="text-xs leading-relaxed">
          {t('现在没有候选。命令失败后换了做法才成功、或子对话记下教训和经验时，会出现在这里。')}
        </EmptyPanel>
      )}
      {list.length > 0 && (
        <ul className="flex flex-col gap-2">
          {list.map((c) => (
            <CandidateRow key={c.id} c={c} busy={busy === c.id} onAct={(a) => void act(c, a)} />
          ))}
        </ul>
      )}
      {misses.length > 0 && (
        <section className="flex flex-col gap-2 pt-2">
          <div className="flex flex-col gap-0.5">
            <h4 className="text-body font-medium">{t('没配上的查询')}</h4>
            <p className="text-footnote text-subtle">
              {t('Agent 搜了、查了却没有经验对得上的说法。反复出现的说明值得补一条经验，可以到「提炼」页让 AI 补。')}
            </p>
          </div>
          <Card as="ul" className="flex flex-col divide-y">
            {misses.map((m) => (
              <li key={m.query} className="flex min-w-0 items-center gap-2.5 px-3 py-2 text-footnote">
                <SearchX className="h-3.5 w-3.5 shrink-0 text-subtle" />
                <span className="min-w-0 flex-1 truncate font-mono text-muted" title={m.query}>
                  {m.query}
                </span>
                <span className="shrink-0 text-caption text-subtle">
                  {t('{n} 次', { n: m.count })}
                  {m.lastAt && ` · ${timeAgo(m.lastAt)}`}
                </span>
              </li>
            ))}
          </Card>
        </section>
      )}
    </div>
  )
}

/** 一条候选：标题、来源、失败的命令 → 改对的命令、报错原文、出现在几个对话；右边收下 / 忽略 */
function CandidateRow({
  c,
  busy,
  onAct,
}: {
  c: KnowledgeCandidate
  busy: boolean
  onAct: (a: 'accept' | 'dismiss') => void
}) {
  const lesson = c.kind === 'lesson'
  const Icon = lesson ? ShieldAlert : Compass
  const sample = c.errors.find((e) => e.sample)?.sample
  return (
    <Card as="li" className="flex flex-col gap-2 px-3.5 py-3">
      <div className="flex min-w-0 items-start gap-2.5">
        <Icon className={lesson ? 'mt-0.5 h-4 w-4 shrink-0 text-warning' : 'mt-0.5 h-4 w-4 shrink-0 text-run'} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-body font-medium">
            {c.title || (lesson ? t('（还没写规则）') : t('（还没写标题）'))}
          </span>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-caption text-subtle">
            <span>{lesson ? t('教训') : t('经验')}</span>
            <span>·</span>
            <span>
              {c.origin === 'episode'
                ? t('失败后改对')
                : c.origin === 'agent'
                  ? t('对话记录（只在记下它的对话里生效）')
                  : t('子对话记录')}
            </span>
            <span>·</span>
            <span>{t('出现在 {n} 个对话', { n: Math.max(c.convs.length, 1) })}</span>
            {c.lastAt && <span>· {timeAgo(c.lastAt)}</span>}
          </span>
        </div>
        {c.convs.length > 1 && (
          <Badge tone="warning" className="shrink-0 text-caption" title={t('同一个报错在不止一个对话里出现过')}>
            {t('复发')}
          </Badge>
        )}
      </div>
      {(c.failed || c.fixed) && (
        <div className="flex min-w-0 flex-col gap-1 rounded-lg bg-field px-3 py-2 font-mono text-caption">
          {c.failed && (
            <span className="flex min-w-0 items-center gap-2">
              <X className="h-3 w-3 shrink-0 text-danger" />
              <span className="min-w-0 truncate text-muted" title={c.failed}>
                {c.failed}
              </span>
            </span>
          )}
          {c.fixed && (
            <span className="flex min-w-0 items-center gap-2">
              <ArrowRight className="h-3 w-3 shrink-0 text-success" />
              <span className="min-w-0 truncate text-fg" title={c.fixed}>
                {c.fixed}
              </span>
            </span>
          )}
        </div>
      )}
      {(c.rule || c.body) && <p className="text-footnote leading-relaxed text-muted">{c.rule || c.body}</p>}
      {sample && (
        <p className="truncate font-mono text-caption text-subtle" title={sample}>
          {t('报错：{text}', { text: sample })}
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => onAct('dismiss')}>
          {t('忽略')}
        </Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => onAct('accept')}>
          <Check className="h-3.5 w-3.5" />
          {lesson ? t('收下为教训') : t('收下为经验')}
        </Button>
      </div>
    </Card>
  )
}
