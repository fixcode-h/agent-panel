import { useEffect, useState } from 'react'
import { Loader2, Play } from 'lucide-react'
import { t } from '@shared/i18n'
import type { Task } from '@shared/schema'
import { taskSummary } from '@shared/task'
import { api } from '@/lib/api'
import { useData, useNav } from '@/lib/data'
import { useNewAskUser } from '@/components/chat/AskToggle'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Field, Select, Textarea } from '@/components/ui/input'
import { Modal } from '@/components/ui/modal'

/** 上次新建任务用的项目（和输入框的项目选择共用一个记录），默认选它 */
export function lastProject() {
  try {
    return localStorage.getItem('last-project') ?? ''
  } catch {
    return ''
  }
}

/**
 * 工作流只由父对话启动（ADR 0044）：在项目里新建一个父对话（项目的默认角色，一般是主理），
 * 第一条消息点名这个工作流（带 id，不在项目可选列表里也认得出），父对话用 start_workflow 开工作流子对话。
 * 父对话的角色启动不了工作流时，它会直接在对话里做：弹窗里先说清楚
 */
export function workflowPrompt(workflow: { id: string; name: string }, text: string) {
  return `用工作流「${workflow.name}」（id ${workflow.id}）做：\n${text.trim()}`
}

/** 这个项目的父对话能不能启动工作流：默认角色要能开子对话、能启动工作流 */
function canStartFlow(agents: { id: string; canDelegate: boolean; canPlan: boolean }[], agentId: string) {
  const a = agents.find((x) => x.id === agentId)
  return !!a && a.canDelegate && a.canPlan
}

/**
 * 「在项目里运行」：选一个项目、写任务描述，在项目里新建一个父对话，由它启动这个工作流，建好直接跳到对话页。
 * prepare 在新建之前把编辑器里还没自动保存的改动先存下去，免得跑的是旧版本
 */
export function RunInProjectDialog({
  open,
  onOpenChange,
  workflow,
  notReady,
  prepare,
  projectId: preferred,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  workflow: { id: string; name: string }
  /** 就绪检查没通过时的提示（照样可以运行，出错会显示在任务里） */
  notReady?: string
  prepare?: () => Promise<void>
  /** 打开时先选的项目（编辑页底部工具条上选好的）；不传时按上次用的项目 */
  projectId?: string
}) {
  const { projects, agents, upsertTask } = useData()
  const { go } = useNav()
  const [projectId, setProjectId] = useState('')
  const lead = projects.find((p) => p.id === projectId)?.defaultAgentId ?? ''
  const noFlow = !!projectId && !canStartFlow(agents, lead)
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [askUser] = useNewAskUser()
  useEffect(() => {
    if (!open) return
    const last = lastProject()
    const has = (id?: string) => !!id && projects.some((p) => p.id === id)
    setProjectId((cur) => (has(preferred) ? preferred! : has(cur) ? cur : has(last) ? last : (projects[0]?.id ?? '')))
    // 每次打开按当前的项目列表选一次默认项目
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const can = !!projectId && !!prompt.trim() && !busy
  const run = async () => {
    if (!can) return
    setBusy(true)
    try {
      await prepare?.()
      try {
        localStorage.setItem('last-project', projectId)
      } catch {}
      const created = await api.createTask({
        projectId,
        mode: 'chat',
        workflowId: '',
        agentId: lead,
        cli: '',
        model: '',
        effort: '',
        params: {},
        prompt: workflowPrompt(workflow, prompt),
        attachments: [],
        askUser,
      })
      upsertTask(taskSummary(created))
      setPrompt('')
      onOpenChange(false)
      go({ page: 'projects', id: created.projectId, sub: created.id })
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={(v) => !busy && onOpenChange(v)}
      title={t('在项目里运行「{name}」', { name: workflow.name || t('未命名工作流') })}
      footer={
        <>
          {(notReady || noFlow) && (
            <span className="min-w-0 flex-1 truncate text-xs text-warning">
              {notReady || t('这个项目的默认角色不能启动工作流，会直接在对话里做')}
            </span>
          )}
          <Button variant="secondary" className="ml-auto" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('取消')}
          </Button>
          <Button onClick={run} disabled={!can}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-3.5 w-3.5" fill="currentColor" />}
            {t('开始运行')}
          </Button>
        </>
      }
    >
      <Field label={t('项目')}>
        <Select
          aria-label={t('在哪个项目里执行')}
          value={projectId}
          placeholder={t('选择项目')}
          onChange={(e) => setProjectId(e.target.value)}
          options={projects.map((p) => ({ value: p.id, label: p.name }))}
        />
      </Field>
      {projects.length === 0 && (
        <p className="-mt-2 text-xs text-subtle">{t('还没有项目，先在「项目」里添加一个本机目录')}</p>
      )}
      <Field label={t('任务描述')}>
        <Textarea
          aria-label={t('任务描述')}
          rows={5}
          autoFocus
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            // Ctrl/⌘ + Enter 直接开始；单按 Enter 换行，描述常常不止一行
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              void run()
            }
          }}
          placeholder={t('要在这个项目里做什么，例如：商品详情页增加「看了又看」推荐')}
          className="text-body"
        />
      </Field>
    </Modal>
  )
}

/**
 * 「重新运行」：照上次那次执行的参数（任务描述、附件、提问开关、独立分支、执行上限）在同一个项目里再新建一次，
 * 建好直接跳到任务页。和「在项目里运行」走同一个接口；任务列表里只有摘要（描述截到 500 字），先取一次完整任务
 */
export function useRerun(workflowId: string, prepare?: () => Promise<void>) {
  const { projects, workflows, upsertTask } = useData()
  const { go } = useNav()
  const [busy, setBusy] = useState(false)
  const rerun = async (last: Task) => {
    if (busy) return
    setBusy(true)
    try {
      await prepare?.()
      const full = await api.taskLite(last.id)
      const first = full.messages.find((m) => m.role === 'user')
      if (!first?.text.trim()) throw new Error(t('上次运行没有任务描述，无法重新运行'))
      // 上次是老的工作流任务（第一条就是描述）或新的父对话（第一条点名了工作流）：都按新的方式交给父对话再起一次
      const text = first.text.replace(/^用工作流「[^」]*」（id [^）]*）做：\n/, '')
      const project = projects.find((p) => p.id === full.projectId)
      const name = workflows.find((w) => w.id === workflowId)?.name ?? ''
      const created = await api.createTask({
        projectId: full.projectId,
        mode: 'chat',
        workflowId: '',
        agentId: project?.defaultAgentId ?? '',
        cli: '',
        model: '',
        effort: '',
        params: {},
        prompt: workflowPrompt({ id: workflowId, name }, text),
        attachments: first.attachments ?? [],
        askUser: full.askUser,
        childAskUser: full.childAskUser,
        ...(full.worktree ? { isolate: true } : {}),
        ...(full.budgetTokens ? { budgetTokens: full.budgetTokens } : {}),
        ...(full.budgetMinutes ? { budgetMinutes: full.budgetMinutes } : {}),
      })
      upsertTask(taskSummary(created))
      go({ page: 'projects', id: created.projectId, sub: created.id })
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return { rerun, busy }
}
