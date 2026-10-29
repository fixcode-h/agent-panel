import { useEffect, useState } from 'react'
import { Loader2, Play } from 'lucide-react'
import { t } from '@shared/i18n'
import { taskSummary } from '@shared/task'
import { api } from '@/lib/api'
import { useData, useNav } from '@/lib/data'
import { childAskUserDefault } from '@/lib/askUserDefault'
import { useNewAskUser } from '@/components/chat/AskToggle'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Field, Select, Textarea } from '@/components/ui/input'
import { Modal } from '@/components/ui/modal'

/** 上次新建任务用的项目（和输入框的项目选择共用一个记录），默认选它 */
function lastProject() {
  try {
    return localStorage.getItem('last-project') ?? ''
  } catch {
    return ''
  }
}

/**
 * 「在项目里运行」：选一个项目、写任务描述，用这个工作流在项目里新建任务，建好直接跳到任务页。
 * 和项目输入框新建工作流任务走同一个接口（POST /tasks，mode = workflow）。
 * prepare 在新建之前把编辑器里还没自动保存的改动先存下去，免得跑的是旧版本
 */
export function RunInProjectDialog({
  open,
  onOpenChange,
  workflow,
  notReady,
  prepare,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  workflow: { id: string; name: string }
  /** 就绪检查没通过时的提示（照样可以运行，出错会显示在任务里） */
  notReady?: string
  prepare?: () => Promise<void>
}) {
  const { projects, upsertTask } = useData()
  const { go } = useNav()
  const [projectId, setProjectId] = useState('')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [askUser] = useNewAskUser()
  useEffect(() => {
    if (!open) return
    const last = lastProject()
    setProjectId((cur) =>
      projects.some((p) => p.id === cur) ? cur : projects.some((p) => p.id === last) ? last : (projects[0]?.id ?? ''),
    )
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
        mode: 'workflow',
        workflowId: workflow.id,
        agentId: '',
        cli: '',
        model: '',
        effort: '',
        params: {},
        prompt: prompt.trim(),
        attachments: [],
        askUser,
        childAskUser: childAskUserDefault(),
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
          {notReady && <span className="min-w-0 flex-1 truncate text-xs text-warning">{notReady}</span>}
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
          className="text-[0.8125rem]"
        />
      </Field>
    </Modal>
  )
}
