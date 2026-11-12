import { useState } from 'react'
import { toast } from '@/lib/toast'
import type { Project, ProjectInput, Workflow } from '@shared/schema'
import type { ProjectProposal } from '@shared/assist'
import type { DocFile } from '@shared/docs'
import { readProjectProposal } from '@shared/project-init'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { useData, useNav } from '@/lib/data'
import type { SetDraft } from './project-draft'

/**
 * 项目设置的「确认」（保存或新建）和「删除项目」（从 ProjectSettingsDialog.tsx 的 Body 挪出）。
 * 草稿、说明文件改动和初始化结果都由弹窗持有，这里按参数拿。
 */
export function useProjectSave({
  project,
  draft,
  setDraft,
  valid,
  init,
  inherited,
  general,
  changedDocs,
  created,
  keep,
  stash,
  onCreated,
  onClose,
}: {
  project?: Project
  draft: ProjectInput
  setDraft: SetDraft
  valid: boolean
  /** 这次打开弹窗里 AI 初始化的结果 */
  init: ProjectProposal | null
  inherited?: Workflow
  general?: Workflow
  changedDocs: [DocFile, string][]
  created: { current: boolean }
  keep: { current: boolean }
  stash: { current: ProjectInput | null }
  onCreated: (id: string) => void
  onClose: () => void
}) {
  const { setProjects, reloadTasks } = useData()
  const { go, route } = useNav()
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [lessonIds0] = useState(() => new Set(project?.lessons.map((l) => l.id)))

  const confirm = async () => {
    if (!valid || saving || !draft.initializedAt) return
    setSaving(true)
    try {
      // 初始化结果不在表单里编辑：本次刚初始化出来的用新的，否则用打开时读到的那份。
      // 期间别处重新初始化或应用过推荐，由下面保存时的乐观锁拦下（409），不拿旧值静默覆盖
      // 弹窗开着时角色在对话里新记的教训（打开时还没有、草稿里也没有）一起留下：
      // 这类写入会推进 updatedAt，第一次保存被 409 拦下并刷新列表；再点一次时 project 已是最新，fresh 就能把它们算出来
      // 取舍：弹窗内刚初始化过（init 非空）又遇上期间别处也写过推荐时，以本次初始化为准（用户主动操作优先），不合并别处那份
      const inDraft = new Set(draft.lessons.map((x) => x.id))
      const fresh = (project?.lessons ?? []).filter((l) => !lessonIds0.has(l.id) && !inDraft.has(l.id))
      const input = {
        ...draft,
        name: draft.name.trim(),
        workflowId: draft.workflowId || (inherited ? '' : (general?.id ?? '')),
        lessons: [...draft.lessons, ...fresh],
        // 服务端会在保存时严格校验推荐，坏值原样发回去会让整个设置保存被 400 拒掉（数据文件是用户可改的）
        // 初始化结果和初始化时间不在表单里编辑：本次刚初始化出来的用新值；否则取刷新后的项目——
        // 409 重试时 draft 还是打开时的快照，用它会把这期间别处写入的新推荐回滚
        initResult: init ?? readProjectProposal(project?.initResult ?? draft.initResult),
        initializedAt: init ? draft.initializedAt : (project?.initializedAt ?? draft.initializedAt),
      }
      if (project) {
        // 说明文件先存：写到项目目录里，失败时项目设置也不算保存成功，改动还留在弹窗里
        for (const [f, c] of changedDocs) await api.saveProjectDoc(project.id, f, c)
        // 带着当前 project.updatedAt 保存：期间别处改过（应用了推荐、角色记了教训）就 409；刷新后重试用的就是最新版本
        const saved = await api.updateProject(project.id, input, project.updatedAt)
        setProjects((ps) => ps.map((p) => (p.id === saved.id ? saved : p)))
        toast.success(t('项目设置已保存'))
      } else {
        const p = await api.createProject(input)
        setProjects((ps) => [...ps, p])
        created.current = true
        keep.current = false
        stash.current = null
        onCreated(p.id)
        go({ page: 'projects', id: p.id })
      }
      onClose()
    } catch (e) {
      const err = e as Error & { status?: number }
      // 409：项目在别处被改过。刷新列表拿到最新 updatedAt，草稿里的编辑保留，再点一次「确认」就能存
      if (err.status === 409) {
        // 刷新失败时不能提示「已刷新」：重试仍会 409，让用户手动刷新页面
        let refreshed = true
        await api
          .projects()
          .then((list) => {
            setProjects(list)
            // 界面上的初始化时间和推荐也换成最新那份，让重试保存和界面显示用同一份数据
            const cur = list.find((x) => x.id === project?.id)
            if (cur)
              setDraft((d) => ({
                ...d,
                initializedAt: cur.initializedAt || d.initializedAt,
                initResult: readProjectProposal(cur.initResult) ?? d.initResult,
              }))
          })
          .catch(() => {
            refreshed = false
          })
        toast.error(
          refreshed ? t('项目在别处被修改过，已刷新，请再点一次「确认」') : t('项目在别处被修改过，请刷新页面后再保存'),
        )
      } else toast.error(err.message)
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!project) return
    try {
      await api.deleteProject(project.id)
      setProjects((ps) => ps.filter((p) => p.id !== project.id))
      // 后端连同任务一起删了，侧栏的对话也要去掉
      void reloadTasks()
      toast.success(t('已删除「{name}」', { name: project.name }))
      setDeleting(false)
      onClose()
      if (route.page === 'projects' && route.id === project.id) go({ page: 'home' })
    } catch (e) {
      toast.error((e as Error).message)
      setDeleting(false)
    }
  }

  return { saving, confirm, deleting, setDeleting, remove }
}
