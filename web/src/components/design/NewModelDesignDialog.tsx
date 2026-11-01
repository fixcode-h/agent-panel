import { useEffect, useState } from 'react'
import { Box, Loader2 } from 'lucide-react'
import { t } from '@shared/i18n'
import { taskSummary } from '@shared/task'
import { api } from '@/lib/api'
import { useData, useNav } from '@/lib/data'
import { useNewAskUser } from '@/components/chat/AskToggle'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Field, Input, Select, Textarea } from '@/components/ui/input'
import { Modal } from '@/components/ui/modal'
import { Segmented } from '@/components/ui/segmented'
import { DirPicker, useDirInfo } from '@/components/projects/DirPicker'

/** 项目放在哪：已有项目里，还是拿一个本机文件夹新建项目（文件夹不存在就建出来） */
type Where = 'existing' | 'folder'

/** 路径的最后一段：新建项目默认用文件夹名当项目名 */
const baseName = (p: string) =>
  p
    .trim()
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() ?? ''
/** 路径去掉最后一段：文件夹不存在时在它的上一级里建出来 */
const parentOf = (p: string) => {
  const s = p.trim().replace(/[\\/]+$/, '')
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
  return i < 0 ? '' : i === 0 ? s.slice(0, 1) : s.slice(0, i)
}

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
  const { projects, setProjects, upsertTask } = useData()
  const { go, openSettings } = useNav()
  const [projectId, setProjectId] = useState('')
  // 没有项目时直接停在「本机文件夹」：不用先去项目页加一个
  const [where, setWhere] = useState<Where>('existing')
  const [dir, setDir] = useState('')
  const [name, setName] = useState('')
  // 项目名没手动改过就跟着文件夹名走
  const [nameTouched, setNameTouched] = useState(false)
  const dirInfo = useDirInfo(where === 'folder' ? dir : '')
  // 选的文件夹已经是某个项目：直接用那个项目，不重复建
  const sameDir = projects.find((p) => dirInfo?.exists && (p.path === dirInfo.path || p.path === dir.trim()))
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
    setWhere(projects.length ? 'existing' : 'folder')
    setBlender(undefined)
    api
      .blenderStatus()
      .then((s) => setBlender({ ok: !!s.path && !s.error, why: s.error }))
      .catch((e) => setBlender({ ok: false, why: (e as Error).message }))
    // 每次打开按当前的项目列表选一次默认项目
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const folderOk = !!dir.trim() && !!(sameDir || name.trim()) && !(dirInfo?.exists && !dirInfo.isDir)
  const can = (where === 'existing' ? !!projectId : folderOk) && !!prompt.trim() && !busy
  /** 「本机文件夹」：文件夹不存在先建出来，再拿它新建项目；已经是项目的直接用 */
  const ensureProject = async () => {
    if (where === 'existing') return projectId
    if (sameDir) return sameDir.id
    let path = dir.trim()
    if (dirInfo && !dirInfo.exists) path = (await api.makeDir(parentOf(path), baseName(path))).path
    const p = await api.createProject({ name: name.trim(), path } as Parameters<typeof api.createProject>[0])
    setProjects((ps) => [...ps, p])
    return p.id
  }
  const create = async () => {
    if (!can) return
    setBusy(true)
    try {
      const projectId = await ensureProject()
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
        modelDesign: true,
      })
      upsertTask(taskSummary(created))
      setPrompt('')
      onOpenChange(false)
      go({ page: 'model', id: created.id })
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
        {t(
          '模型设计在选定的项目目录里开一个对话（不列进 Agent 模式），后台启动 Blender，Agent 用它建模并在对话里汇报进度。',
        )}
      </p>
      {/* 不用 Field：它是一个 <label>，里面放了分段切换、目录选择好几个控件，读屏名会串成一长串 */}
      <section aria-label={t('项目')} className="flex min-w-0 flex-col gap-1.5">
        <span className="text-xs text-muted">{t('项目')}</span>
        <div className="flex flex-col gap-3">
          <Segmented
            fill
            size="sm"
            label={t('模型放在哪里')}
            value={where}
            onChange={setWhere}
            options={[
              { id: 'existing', label: t('已有项目'), disabled: !projects.length },
              { id: 'folder', label: t('新建项目 / 指定文件夹') },
            ]}
          />
          {where === 'existing' ? (
            <Select
              aria-label={t('模型放在哪个项目里')}
              value={projectId}
              placeholder={t('选择项目')}
              onChange={(e) => setProjectId(e.target.value)}
              options={projects.map((p) => ({ value: p.id, label: p.name }))}
            />
          ) : (
            <>
              <DirPicker
                label={t('文件夹')}
                value={dir}
                info={dirInfo}
                hint={t('选一个本机文件夹当项目；填一个还不存在的路径，开始建模时会新建这个文件夹。')}
                onChange={(v) => {
                  setDir(v)
                  if (!nameTouched) setName(baseName(v))
                }}
              />
              {sameDir ? (
                <p className="text-xs text-subtle">
                  {t('这个文件夹已经是项目「{name}」，直接用它。', { name: sameDir.name })}
                </p>
              ) : (
                dir.trim() && (
                  <Field label={t('项目名')}>
                    <Input
                      aria-label={t('项目名')}
                      value={name}
                      onChange={(e) => {
                        setName(e.target.value)
                        setNameTouched(true)
                      }}
                    />
                  </Field>
                )
              )}
              {dirInfo && !dirInfo.exists && dir.trim() && (
                <p className="-mt-1 text-xs text-subtle">{t('开始建模时会新建这个文件夹')}</p>
              )}
            </>
          )}
        </div>
      </section>
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
          className="text-body"
        />
      </Field>
    </Modal>
  )
}
