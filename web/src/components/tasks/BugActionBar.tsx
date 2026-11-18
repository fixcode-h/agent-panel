import { useContext, useState } from 'react'
import { FileSearch, FolderInput, FolderOutput, Loader2 } from 'lucide-react'
import type { Task } from '@shared/schema'
import { patchKindOf } from '@shared/bug/patch'
import { liveProbes, probedReady } from '@shared/bug/probe'
import type { BugPhase } from '@shared/bug/diagnosis-schema'
import { phaseOf } from '@shared/bug/phase'
import { t } from '@shared/i18n'
import { useData } from '@/lib/data'
import { cn } from '@/lib/utils'
import { PaneNavCtx } from './child-open'
import { usePatch } from './DiagnosisEvidence'
import { PROBE_ICON, ProbeForm } from './ProbeForm'

/**
 * Bug 子对话的动作条（设计稿 N1）：输入框上方一行「补排查 · 放到工作区 / 还原 · 查看报告」，跟着报告的阶段变。
 * 这些动作以前都在报告弹窗里，聊着聊着要先找到报告再点。设置 → 通用「Bug 对话的动作条」可以关掉
 */
type BarTask = Pick<Task, 'id' | 'title' | 'bug'>

const PHASE = (): Record<BugPhase, string> => ({
  evidence: t('论证'),
  cause: t('根因'),
  plan: t('修复方案'),
  fix: t('修复'),
  verify: t('验证'),
})

const chip =
  'inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 text-caption text-muted transition-colors hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-50'

export function BugActionBar({ task }: { task: BarTask }) {
  const { settings } = useData()
  const nav = useContext(PaneNavCtx)
  const last = task.bug?.diagnoses?.at(-1)
  const on = settings?.bugBar !== false && task.bug?.kind === 'report' && !!last
  const kind = patchKindOf(last, probedReady(task.bug))
  const patch = usePatch(task.id, on && (!!kind || liveProbes(task.bug).length > 0))
  const [probing, setProbing] = useState(false)
  if (!on || !last) return null
  const closed = last.status === 'cancelled'
  const live = liveProbes(task.bug)
  const applied = patch.status?.applied
  const step = last.status === 'pending' ? (last.awaiting ? t('等你复现') : t('等你确认')) : ''
  return (
    <div data-bug-bar className="flex min-w-0 flex-wrap items-center gap-1 px-3 pt-2">
      <span className="mr-1 shrink-0 text-caption text-subtle">
        {PHASE()[phaseOf(last)]}
        {step && ` · ${step}`}
      </span>
      {!closed && (
        <button type="button" className={chip} onClick={() => setProbing(true)}>
          <PROBE_ICON className="h-3.5 w-3.5" />
          {t('补排查')}
        </button>
      )}
      {patch.status?.eligible && !applied && kind && (
        <button type="button" className={chip} disabled={!!patch.busy} onClick={() => void patch.act('apply')}>
          {patch.busy === 'apply' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <FolderInput className="h-3.5 w-3.5" />
          )}
          {kind === 'fix' ? t('把修复放到工作区') : t('放到我的工作区')}
        </button>
      )}
      {applied && (
        <button
          type="button"
          className={cn(chip, 'text-warning')}
          disabled={!!patch.busy}
          onClick={() => void patch.act('restore')}
          title={patch.fail?.reason}
        >
          {patch.busy === 'restore' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <FolderOutput className="h-3.5 w-3.5" />
          )}
          {t('从我的工作区还原')}
        </button>
      )}
      {nav?.diagnosis && (
        <button type="button" className={chip} onClick={() => nav.diagnosis!(task)}>
          <FileSearch className="h-3.5 w-3.5" />
          {live.length ? t('查看报告 · 临时改动 {n} 处', { n: live.length }) : t('查看报告')}
        </button>
      )}
      <ProbeForm task={task} open={probing} onOpenChange={setProbing} canPatch={!!patch.status?.eligible} />
    </div>
  )
}
