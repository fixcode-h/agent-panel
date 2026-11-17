import { useEffect, useState } from 'react'
import { toast } from '@/lib/toast'
import type { ProjectSkill, ProjectSkillsView } from '@shared/projects/skills'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { openAiFix } from '@/lib/ai-fix'
import { ConfirmDialog } from '@/components/ui/dialog'
import { AssistDialog } from '@/components/assist/LazyAssistDialog'
import { CreateSkillDialog, EditSkillDialog, type Opening } from './SkillDialogs'

/**
 * 「技能与 MCP」页「项目自己的」里的技能：项目目录下各 Agent 的 skills.repo 里的技能，能新建、改、删，
 * 也能交给 AI —— 格式或说明有问题时「AI 修复」，想写得更好时「AI 优化」（结果先在弹窗里看，点应用才写文件）。
 * 状态和弹窗都在这里，列表怎么画归 OwnBlock
 */
export function useOwnSkills(projectId: string, onChanged: () => void) {
  const [view, setView] = useState<ProjectSkillsView | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [editing, setEditing] = useState<Opening | null>(null)
  const [creating, setCreating] = useState(false)
  const [removing, setRemoving] = useState<ProjectSkill | null>(null)
  const [optimizing, setOptimizing] = useState<Opening | null>(null)

  const load = () => {
    setLoading(true)
    return api
      .projectSkills(projectId)
      .then((v) => {
        setView(v)
        setError('')
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false))
  }
  // 新建、改、删之后：自己这份和页面上的计数都要重读
  const reload = () => {
    void load()
    onChanged()
  }
  useEffect(() => {
    setView(null)
    void load()
    // load 每次渲染都是新的函数，只在换项目时重新读；新建、删掉后自己调 load
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  const read = (skill: ProjectSkill) => api.projectSkillFile(projectId, skill.source, skill.name)
  const open = async (skill: ProjectSkill) => {
    try {
      const f = await read(skill)
      setEditing({ skill, content: f.content, files: f.files, scan: f.scan, scanScope: f.scanScope })
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  const optimize = async (skill: ProjectSkill) => {
    try {
      const f = await read(skill)
      setOptimizing({ skill, content: f.content, files: f.files })
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  const fixWith = (skill: ProjectSkill, content: string) => {
    openAiFix({
      title: t('Skill「{name}」格式有问题', { name: skill.name }),
      error: skill.issues.join('\n'),
      context: [
        t('项目：{path}', { path: view?.path ?? '' }),
        t('SKILL.md：{file}', { file: skill.path }),
        '',
        t('当前的 SKILL.md：'),
        '```markdown',
        content,
        '```',
      ].join('\n'),
      cwd: view?.path ?? '',
      topic: 'project-skill',
      home: { kind: 'project', projectId },
      onDone: reload,
    })
  }
  const fix = (skill: ProjectSkill) =>
    void read(skill)
      .then((f) => fixWith(skill, f.content))
      .catch((e) => toast.error((e as Error).message))

  const dialogs = (
    <>
      {view?.path && creating && (
        <CreateSkillDialog
          projectId={projectId}
          view={view}
          onClose={() => setCreating(false)}
          onDone={(dir) => {
            setCreating(false)
            reload()
            toast.success(t('已创建 {dir}，接着改里面的 SKILL.md', { dir }))
          }}
        />
      )}
      {editing && (
        <EditSkillDialog
          projectId={projectId}
          opening={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            reload()
          }}
          onOptimize={() => {
            setOptimizing(editing)
            setEditing(null)
          }}
          onFix={(content) => fixWith(editing.skill, content)}
        />
      )}
      {optimizing && (
        <AssistDialog
          open
          onOpenChange={(o) => !o && setOptimizing(null)}
          kind="skill"
          title={optimizing.skill.name}
          subject={{ name: optimizing.skill.name, content: optimizing.content }}
          onApply={async (p) => {
            if (p.kind !== 'skill') return
            await api.saveProjectSkill({
              projectId,
              repo: optimizing.skill.source,
              name: optimizing.skill.name,
              content: p.content,
            })
            toast.success(t('已更新 {dir}/SKILL.md', { dir: optimizing.skill.dir }))
            setOptimizing(null)
            reload()
          }}
        />
      )}
      {removing && (
        <ConfirmDialog
          open
          title={t('删除 Skill「{name}」', { name: removing.name })}
          description={
            <span>
              {t('会删掉项目里的整个文件夹 {dir}（包括里面的脚本等文件），删了要去 Git 里找回来。', {
                dir: removing.dir,
              })}
            </span>
          }
          onOpenChange={(o) => !o && setRemoving(null)}
          onConfirm={async () => {
            try {
              await api.deleteProjectSkill(projectId, removing.source, removing.name)
              toast.success(t('已删除 {dir}', { dir: removing.dir }))
              setRemoving(null)
              reload()
            } catch (e) {
              toast.error((e as Error).message)
            }
          }}
        />
      )}
    </>
  )

  return {
    view,
    error,
    loading,
    load,
    canCreate: !!view?.path,
    create: () => setCreating(true),
    open,
    optimize,
    fix,
    remove: setRemoving,
    dialogs,
  }
}

export type OwnSkills = ReturnType<typeof useOwnSkills>
