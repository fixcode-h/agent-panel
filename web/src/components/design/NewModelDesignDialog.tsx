import { useEffect, useState } from 'react'
import { Box, Loader2 } from 'lucide-react'
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

/** 上次新建任务用的项目（和输入框、「在项目里运行」共用一个记录） */
function lastProject() {
  try {
    return localStorage.getItem('last-project') ?? ''
  } catch {
    return ''
  }
}

/**
 * 新建模型设计（ADR 0025）：模型设计是 Agent 项目里带 modelDesign 标记的对话，后台挂一个 Blender，
 * Agent 用 blender_python 工具建模。这里选项目、写要建的模型，走普通的 POST /tasks（mode = chat）。
 * 打开时先查一次 Blender 找没找到：找不到照样能建（出错会显示在对话里），但先在这里说清楚、给去设置的入口
 */
export function NewModelDesignDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { projects, upsertTask } = useData()
  const { go, openSettings } = useNav()
  const [projectId, setProjectId] = useState('')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [blender, setBlender] = useState<{ ok: boolean; why: string }>()
  const [askUser] = useNewAskUser()
  useEffect(() => {
    if (!open) return
    const last = lastProject()
    setProjectId((cur) =>
      projects.some((p) => p.id === cur) ? cur : projects.some((p) => p.id === last) ? last : (projects[0]?.id ?? ''),
    )
    setBlender(undefined)
    api
      .blenderStatus()
      .then((s) => setBlender({ ok: !!s.path && !s.error, why: s.error }))
      .catch((e) => setBlender({ ok: false, why: (e as Error).message }))
    // 每次打开按当前的项目列表选一次默认项目
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const can = !!projectId && !!prompt.trim() && !busy
  const create = async () => {
    if (!can) return
    setBusy(true)
    try {
      try {
        localStorage.setItem('last-project', projectId)
      } catch {}
      const created = await api.createTask({
        projectId,
        mode: 'chat',
        workflowId: '',
        agentId: '',
        cli: '',
        model: '',
        effort: '',
        params: {},
        prompt: prompt.trim(),
        attachments: [],
        askUser,
        childAskUser: childAskUserDefault(),
        modelDesign: true,
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
      title={t('新建模型设计')}
      footer={
        <>
          {blender && !blender.ok && (
            <span className="flex min-w-0 flex-1 items-center gap-2 text-xs text-warning">
              <span className="truncate" title={blender.why}>
                {t('没找到 Blender：{why}', { why: blender.why || t('还没设置路径') })}
              </span>
              <Button
                variant="link"
                tone="warning"
                className="shrink-0"
                onClick={() => {
                  onOpenChange(false)
                  openSettings('blender')
                }}
              >
                {t('去设置')}
              </Button>
            </span>
          )}
          <Button variant="secondary" className="ml-auto" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('取消')}
          </Button>
          <Button onClick={() => void create()} disabled={!can}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Box className="h-3.5 w-3.5" />}
            {t('开始建模')}
          </Button>
        </>
      }
    >
      <p className="text-xs leading-relaxed text-subtle">
        {t('模型设计在 Agent 项目里开一个对话，后台启动 Blender，Agent 用它建模并在对话里汇报进度。')}
      </p>
      <Field label={t('项目')}>
        <Select
          aria-label={t('模型放在哪个项目里')}
          value={projectId}
          placeholder={t('选择项目')}
          onChange={(e) => setProjectId(e.target.value)}
          options={projects.map((p) => ({ value: p.id, label: p.name }))}
        />
      </Field>
      {projects.length === 0 && (
        <p className="-mt-2 text-xs text-subtle">{t('还没有项目，先在「项目」里添加一个本机目录')}</p>
      )}
      <Field label={t('要建什么模型')}>
        <Textarea
          aria-label={t('要建什么模型')}
          rows={5}
          autoFocus
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            // Ctrl/⌘ + Enter 直接开始；单按 Enter 换行
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              void create()
            }
          }}
          placeholder={t('例如：低多边形风格的宝箱，带开合的盖子，导出 GLB')}
          className="text-[0.8125rem]"
        />
      </Field>
    </Modal>
  )
}
