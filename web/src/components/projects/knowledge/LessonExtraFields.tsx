import { useState } from 'react'
import type { ProjectLesson } from '@shared/schema'
import type { KnowledgeHit } from '@shared/knowledge-hits'
import type { LessonSuggestion } from '@shared/knowledge/candidate'
import { t } from '@shared/i18n'
import { Field, Input, Select } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
import { Button } from '@/components/ui/button'
import { knowledgeApi } from '@/lib/api-experience'
import { toast } from '@/lib/toast'

type Severity = ProjectLesson['severity']
type Status = ProjectLesson['status']

/** 命令触发键：命令里有空格，只按逗号、顿号、换行分 */
const splitCommands = (s: string) =>
  s
    .split(/[,，、\n]+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 10)

/**
 * 项目教训二期加的几项（设计稿 4.3、4.7）：错的做法、提醒强度、状态、命令触发键，录入时算好的报错指纹只读显示。
 * 只给项目教训用，全局教训没有这些（不按触发推送）
 */
export function LessonExtraFields({
  lesson,
  onChange,
}: {
  lesson: ProjectLesson
  onChange: (p: Partial<ProjectLesson>) => void
}) {
  const [cmds, setCmds] = useState(lesson.triggers.commands.join(', '))
  const samples = lesson.triggers.errors.map((e) => e.sample).filter(Boolean)
  return (
    <>
      <Field label={t('错的做法')} hint={t('看到这样做时要停下；面板推送时跟在规则后面')}>
        <Input
          value={lesson.wrong}
          maxLength={300}
          onChange={(e) => onChange({ wrong: e.target.value })}
          placeholder={t('例如：直接在 Windows 上跑 npm run test:e2e')}
        />
      </Field>
      <Field
        label={t('命令触发键')}
        hint={t('跑这些命令之前推送这条（按开头几个词比），逗号分隔；说明里用反引号写的命令也会自动算上')}
      >
        <Input
          className="font-mono text-xs"
          value={cmds}
          onChange={(e) => setCmds(e.target.value)}
          onBlur={() => onChange({ triggers: { ...lesson.triggers, commands: splitCommands(cmds) } })}
          placeholder="npm run test:e2e, npx tsc"
        />
      </Field>
      {samples.length > 0 && (
        <Field label={t('报错触发')} hint={t('面板记下的报错特征：同样的报错再出现时推送这条')}>
          <ul className="flex flex-col gap-1">
            {samples.map((s, i) => (
              <li
                key={i}
                className="truncate rounded-lg bg-field px-3 py-1.5 font-mono text-caption text-muted"
                title={s}
              >
                {s}
              </li>
            ))}
          </ul>
        </Field>
      )}
      <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
        <Field label={t('提醒强度')} hint={t('拦截：跑对得上的命令前直接拒绝，并告诉角色对的做法')}>
          <Segmented<Severity>
            label={t('提醒强度')}
            size="sm"
            className="w-fit"
            value={lesson.severity}
            onChange={(v) => onChange({ severity: v })}
            options={[
              { id: 'hint', label: t('只在查询里') },
              { id: 'warn', label: t('按触发推送') },
              { id: 'block', label: t('拦截') },
            ]}
          />
        </Field>
        <Field label={t('状态')}>
          <Select
            size="sm"
            aria-label={t('状态')}
            value={lesson.status}
            onChange={(e) => onChange({ status: e.target.value as Status })}
            options={[
              { value: 'active', label: t('生效') },
              { value: 'pinned', label: t('置顶') },
              { value: 'promoted', label: t('已提炼（不再推送）') },
              { value: 'stale', label: t('过时（推送降权）') },
            ]}
          />
        </Field>
      </div>
    </>
  )
}

/** 行里副标题后面的小字：推送后的反馈，0 的不显示 */
export function FeedbackMeta({ hit }: { hit?: KnowledgeHit }) {
  if (!hit) return null
  const parts = [
    hit.helped ? t('帮上 {n}', { n: hit.helped }) : '',
    hit.violated ? t('违反 {n}', { n: hit.violated }) : '',
    hit.missed ? t('漏推 {n}', { n: hit.missed }) : '',
  ].filter(Boolean)
  if (!parts.length) return null
  return (
    <span
      className="shrink-0"
      title={t('帮上：推送后同样的命令一次就过；违反：推送了还是出现了记下的报错；漏推：报错对上了这条，事前却没推到')}
    >
      {parts.join(' · ')}
    </span>
  )
}

/** 面板对这条教训的建议（shared/knowledge/lifecycle.ts 算）：一个按钮，用户点了才改，改的还是草稿 */
export function SuggestionAction({
  lesson,
  suggestion,
  onChange,
}: {
  lesson: ProjectLesson
  suggestion?: LessonSuggestion
  onChange: (p: Partial<ProjectLesson>) => void
}) {
  if (!suggestion) return null
  if (suggestion.action === 'upgrade' && lesson.severity !== 'block')
    return (
      <Button size="sm" variant="ghost" title={suggestion.why} onClick={() => onChange({ severity: 'block' })}>
        {t('升级为拦截')}
      </Button>
    )
  if (suggestion.action === 'stale' && lesson.status !== 'stale')
    return (
      <Button size="sm" variant="ghost" title={suggestion.why} onClick={() => onChange({ status: 'stale' })}>
        {t('标为过时')}
      </Button>
    )
  if (suggestion.action === 'promote' && lesson.status !== 'promoted')
    return (
      <span className="shrink-0 text-caption text-accent-text" title={`${suggestion.why}${t('（到「提炼」页处理）')}`}>
        {t('可以提炼')}
      </span>
    )
  return null
}

/**
 * 拦截档的教训转成项目钩子（四期，POST /projects/:id/knowledge/distill 的 hook）：转了之后在设置 → 钩子里能看到、能改。
 * 只给升级成拦截的、已保存过的项目里的条目（钩子按服务端存着的这条的命令写，草稿里新加还没保存的读不到）
 */
export function HookAction({
  projectId,
  lesson,
  saved,
}: {
  projectId?: string
  lesson: ProjectLesson
  saved: boolean
}) {
  const [busy, setBusy] = useState(false)
  if (!projectId || !saved || lesson.severity !== 'block') return null
  const run = async () => {
    setBusy(true)
    try {
      const r = await knowledgeApi.distill(projectId, { target: 'hook', lessonId: lesson.id })
      if (r.ok) toast.success(r.info)
      else toast.error(r.info)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={busy}
      title={t('把这条教训的命令写成项目钩子，跑对得上的命令前拒绝')}
      onClick={() => void run()}
    >
      {t('转成钩子')}
    </Button>
  )
}
