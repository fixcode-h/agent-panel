import { useEffect, useRef } from 'react'
import { toast } from '@/lib/toast'
import type { Agent, Workflow } from '@shared/schema'
import type { Proposal } from '@shared/assist'
import type { ProjectProposal } from '@shared/projects/init'
import { derivedParams, isDefaultValue } from '@shared/agent-params'
import { t } from '@shared/i18n'
import type { AiSession, ApplyAi, SetDraft, SetField } from './project-draft'

/**
 * 把 AI 的结果填进表单。会话在外壳手里：设置关着时点「填进表单」会先把设置重新打开，
 * Body 挂载后把排队的那份结果应用掉。从 ProjectSettingsDialog.tsx 的 Body 挪出。
 */
export function useApplyAi({
  ai,
  activeId,
  workflows,
  agents,
  setDraft,
  set,
  acceptInit,
  applyRef,
  queued,
}: {
  ai: AiSession | null
  /** 当前实际用的默认工作流 */
  activeId?: string
  workflows: Workflow[]
  agents: Agent[]
  setDraft: SetDraft
  set: SetField
  acceptInit: (p: ProjectProposal) => void
  /** 应用函数和排队的结果由外壳持有，设置重新打开后要接得上 */
  applyRef: { current: ApplyAi | null }
  queued: { current: Proposal[] }
}) {
  const applyAi = (p: Proposal) => {
    if (p.kind === 'params') {
      const id = ai?.workflowId || p.workflowId || activeId
      const wf = workflows.find((w) => w.id === id)
      const spec = wf ? derivedParams(wf, agents) : []
      if (id)
        setDraft((d) => {
          const next = { ...(d.workflowParams[id] ?? {}), ...p.values }
          // 等于默认值的不存：存下来会覆盖工作流节点上的预设（例如第一个节点的「先识别现场」）
          for (const [k, v] of Object.entries(p.values)) {
            const def = spec.find((x) => x.key === k)
            if (def && isDefaultValue(def, v)) delete next[k]
          }
          return { ...d, workflowParams: { ...d.workflowParams, [id]: next } }
        })
      toast.success(t('已填进表单，确认保存后生效'))
    } else if (p.kind === 'project') {
      acceptInit(p)
    } else if (p.kind === 'teststeps') {
      set('testSteps', p.steps)
      toast.success(t('已填进表单，确认保存后生效'))
    }
  }
  // 交给外壳的永远是最新这一份（里面读的是当前草稿）；挂载时把关掉设置期间排队的应用掉
  const applyLatest = useRef(applyAi)
  applyLatest.current = applyAi
  useEffect(() => {
    const handler: ApplyAi = (p) => applyLatest.current(p)
    applyRef.current = handler
    const queuedNow = queued.current
    queued.current = []
    for (const one of queuedNow) handler(one)
    return () => {
      if (applyRef.current === handler) applyRef.current = null
    }
    // 注册一次转发就够：applyLatest 每次渲染都指向当前草稿，不用重挂
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
