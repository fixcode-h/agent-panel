import { useEffect, useState } from 'react'
import { toast } from '@/lib/toast'
import { Check, CircleAlert, Loader2 } from 'lucide-react'
import { DEFAULT_FILE_FORMAT, type Project, type ProjectInput } from '@shared/schema'
import type { ProjectProposal } from '@shared/project-init'
import { readProjectProposal } from '@shared/project-init'
import { projectDefaultWorkflow } from '@shared/project-workflow'
import { GENERAL_NAME, UE_PROJECT_NAME } from '@shared/builtin/workflows'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { Button } from '@/components/ui/button'
import { InitFileList, RecGroups, buildGroups, type Rec } from './ProjectInitPanel'

const toInput = ({ id: _i, createdAt: _c, updatedAt: _u, ...rest }: Project): ProjectInput => ({
  ...rest,
  initResult: readProjectProposal(rest.initResult),
})

/**
 * AI 初始化项目的报告，画在初始化对话右侧的功能面板里（参照老版本 AI 窗口右边的设置预览，ADR 0016）：
 * 写过的文件、推荐的设置按设置页分组，每项「当前值 → 推荐值」能单独、整组或全部应用。
 * 这里应用直接保存进项目（对话旁边没有项目设置的草稿可填），推荐也一起记进项目，项目设置的「AI 初始化」页还能对照
 */
export function ProjectInitReport({ project, text, prompt }: { project?: Project; text: string; prompt: string }) {
  const { workflows, projectCategories, settings, setProjects } = useData()
  const [res, setRes] = useState<{ proposal?: ProjectProposal; error?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [applied, setApplied] = useState<Set<string>>(new Set())
  const projectId = project?.id ?? ''
  useEffect(() => {
    if (!projectId) return
    let alive = true
    setRes(null)
    // 和对话结束时交回项目设置的是同一个解析（/assist/resolve），推荐里引用的工作流按本机现有的核对
    api
      .assistResolve({
        kind: 'project',
        projectId,
        subject: {},
        messages: [{ role: 'user', text: prompt.slice(0, 40000) }],
        text,
      })
      .then((r) => {
        if (!alive) return
        setRes(r.proposal?.kind === 'project' ? { proposal: r.proposal } : { error: r.error ?? t('没有找到结果') })
      })
      .catch((e) => alive && setRes({ error: (e as Error).message }))
    return () => {
      alive = false
    }
  }, [projectId, text, prompt])
  if (!project) return null
  if (!res)
    return (
      <p className="flex items-center gap-2 px-4 py-4 text-[0.8125rem] text-muted">
        <Loader2 className="h-4 w-4 animate-spin text-accent-text" />
        {t('正在读取推荐的设置…')}
      </p>
    )
  if (!res.proposal)
    return (
      <p className="m-3 flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2.5 text-[0.78125rem] leading-relaxed text-muted">
        <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
        {t('这份结果的格式不对，读不出推荐的设置：{error}。可以在对话里让它重新输出。', { error: res.error ?? '' })}
      </p>
    )
  const p = res.proposal
  const draft = toInput(project)
  const want = p.type === 'ue' ? UE_PROJECT_NAME : GENERAL_NAME
  const fallback =
    workflows.find((w) => w.origin === `builtin:project-${p.type}`) ?? workflows.find((w) => w.name === want)
  const groups = buildGroups(p, draft, {
    workflows,
    activeId: projectDefaultWorkflow(project, projectCategories, workflows)?.id ?? '',
    fallbackId: fallback?.id ?? '',
    globalFormat: settings?.fileFormat ?? DEFAULT_FILE_FORMAT,
  })
  const all = groups.flatMap((g) => g.recs)
  const pending = all.filter((r) => !r.same)
  const skipped = p.workflows.filter((w) => w.verdict === 'skip')
  const apply = async (recs: Rec[]) => {
    const todo = recs.filter((r) => !r.same)
    if (!todo.length || busy) return
    setBusy(true)
    try {
      // 面板上的项目是打开时读的：带上它的 updatedAt 保存，期间别处改过就由服务端拒绝（409），
      // 不再「先 GET 一次再整份 PUT」——GET 失败回落到旧草稿时，旧快照照样会覆盖刚保存的改动
      const next = todo.reduce((acc, r) => r.apply(acc), draft)
      const saved = await api.updateProject(
        project.id,
        {
          ...next,
          // 已有初始化时间时保留：这里只是应用推荐，不是重新初始化
          initializedAt: project.initializedAt || new Date().toISOString(),
          initResult: p,
        },
        project.updatedAt,
      )
      setProjects((ps) => ps.map((x) => (x.id === saved.id ? saved : x)))
      setApplied((s) => new Set([...s, ...todo.map((r) => r.id)]))
      toast.success(t('已应用 {n} 项设置', { n: todo.length }))
    } catch (e) {
      const err = e as Error & { status?: number }
      // 409：项目在别处被改过。刷新列表拿到最新 updatedAt，推荐和草稿都保留，再点一次就能存
      if (err.status === 409) {
        // 刷新失败时不能提示「已刷新」：重试仍会 409，让用户手动刷新页面
        let refreshed = true
        await api
          .projects()
          .then(setProjects)
          .catch(() => {
            refreshed = false
          })
        toast.error(
          refreshed
            ? t('项目在别处被修改过，已刷新，请再点一次「全部应用」')
            : t('项目在别处被修改过，请刷新页面后再保存'),
        )
      } else toast.error(err.message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section aria-label={t('推荐设置')} className="flex flex-col gap-4 px-3 pt-3 pb-4">
      <div className="flex flex-col gap-2 px-1">
        <span className="text-xs font-medium text-subtle">{t('写入的文件')}</span>
        <InitFileList files={p.files} />
      </div>
      <div className="flex flex-wrap items-center gap-3 px-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-[0.8125rem] font-semibold">{t('推荐设置')}</span>
          <span className="text-xs text-subtle">
            {all.length
              ? pending.length
                ? t('{n} 项和项目现在的设置不同，应用后直接保存进项目', { n: pending.length })
                : t('全部推荐都已和项目设置一致')
              : t('没有需要调整的设置')}
          </span>
        </div>
        <Button size="sm" disabled={!pending.length || busy} onClick={() => void apply(all)}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          {t('全部应用')}
        </Button>
      </div>
      <RecGroups groups={groups} apply={(recs) => void apply(recs)} applied={applied} />
      {skipped.length > 0 && (
        <section className="flex flex-col gap-1.5 rounded-xl bg-field px-3.5 py-3">
          <span className="text-xs font-medium text-muted">{t('评估后不适用的工作流')}</span>
          <ul className="flex flex-col gap-1">
            {skipped.map((w) => (
              <li key={w.id} className="text-xs text-subtle">
                <span className="text-muted">{w.name}</span>
                {w.reason && `：${w.reason}`}
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  )
}
