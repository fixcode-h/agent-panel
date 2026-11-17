import { useState } from 'react'
import { toast } from '@/lib/toast'
import { CircleAlert, Loader2, Wand2, Wrench } from 'lucide-react'
import type { ProjectSkill, ProjectSkillsView } from '@shared/projects/skills'
import { DEFAULT_SKILL_REPO, projectSkillName, skillIssues } from '@shared/projects/skills'
import { CLIS } from '@shared/clis'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input, Select, Textarea } from '@/components/ui/input'
import { Modal } from '@/components/ui/modal'
import type { ConfigFinding } from '@shared/config-scan'
import { ScanFindings } from '@/components/ui/scan-findings'
import { configScanApi } from '@/lib/api-config-scan'

/**
 * 项目技能的新建、编辑弹窗（「技能与 MCP」页「项目自己的」里用，状态在 use-own-skills）
 */

/** 一个技能的内容和随内容一起读出来的附带文件 */
export type Opening = {
  skill: ProjectSkill
  content: string
  files: string[]
  scan?: ConfigFinding[]
  scanScope?: string
}

/** 列出这项技能会给哪些 Agent 读到（同一个目录常被几个 Agent 共用） */
const cliNames = (ids: string[]) => ids.map((id) => CLIS.find((c) => c.id === id)?.name ?? id).join(t('、'))

/** 新建：只定名字、目录和一句说明；骨架由服务端按项目技能模板写 */
export function CreateSkillDialog({
  projectId,
  view,
  onClose,
  onDone,
}: {
  projectId: string
  view: ProjectSkillsView
  onClose: () => void
  onDone: (dir: string) => void
}) {
  const repos = view.repos
  const [repo, setRepo] = useState(repos.find((r) => r.dir === DEFAULT_SKILL_REPO)?.dir ?? repos[0]?.dir ?? '')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const valid = projectSkillName(name)
  const dup = view.skills.some((s) => s.source === repo && s.name === name)
  const create = async () => {
    setBusy(true)
    try {
      const r = await api.createProjectSkill({ projectId, repo, name, description })
      onDone(r.dir)
    } catch (e) {
      toast.error((e as Error).message)
      setBusy(false)
    }
  }
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('新建 Skill')}
      footer={
        <>
          <span className="flex-1 text-footnote text-warning">{dup ? t('这个目录里已经有同名的了') : ''}</span>
          <Button variant="secondary" onClick={onClose}>
            {t('取消')}
          </Button>
          <Button onClick={create} disabled={!valid || !repo || dup || busy}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t('创建')}
          </Button>
        </>
      }
    >
      <label className="flex flex-col gap-1.5">
        <span className="text-body font-medium">{t('名字')}</span>
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value.trim())}
          placeholder="release-notes"
          className="font-mono"
        />
        <span className="text-footnote text-subtle">
          {name && !valid ? t('只能用字母、数字、. _ -，以字母或数字开头') : t('也是文件夹名，建好后不能改')}
        </span>
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-body font-medium">{t('放在哪个目录')}</span>
        <Select
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          options={repos.map((r) => ({ value: r.dir, label: r.dir }))}
        />
        <span className="text-footnote text-subtle">
          {t('{clis} 会读这个目录', { clis: cliNames(repos.find((r) => r.dir === repo)?.clis ?? []) })}
        </span>
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-body font-medium">{t('一句话说明什么时候用它')}</span>
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('例如：按团队约定写提交说明，先看改动再写')}
        />
        <span className="text-footnote text-subtle">
          {t('写在 SKILL.md 的 description 里，Agent 靠它判断什么时候该用；之后也可以让 AI 改写')}
        </span>
      </label>
    </Modal>
  )
}

/** 编辑 SKILL.md：改的时候实时提示格式问题，保存才写盘 */
export function EditSkillDialog({
  projectId,
  opening,
  onClose,
  onSaved,
  onOptimize,
  onFix,
}: {
  projectId: string
  opening: Opening
  onClose: () => void
  onSaved: () => void
  onOptimize: () => void
  onFix: (content: string) => void
}) {
  const { skill } = opening
  const [content, setContent] = useState(opening.content)
  const [busy, setBusy] = useState(false)
  const issues = skillIssues(skill.name, content)
  const changed = content !== opening.content
  const [scan, setScan] = useState(opening.scan ?? [])
  const save = async () => {
    setBusy(true)
    try {
      await api.saveProjectSkill({ projectId, repo: skill.source, name: skill.name, content })
      toast.success(t('已保存 {file}', { file: skill.dir }))
      onSaved()
    } catch (e) {
      toast.error((e as Error).message)
      setBusy(false)
    }
  }
  return (
    <Modal
      open
      wide
      onOpenChange={(o) => !o && onClose()}
      title={t('编辑「{name}」', { name: skill.name })}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onOptimize} title={t('让 AI 改写这份 SKILL.md，看完再决定用不用')}>
            <Wand2 className="h-3.5 w-3.5" />
            {t('AI 优化')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onFix(content)}
            title={t('把当前内容和问题一起交给 AI 排查并修好')}
          >
            <Wrench className="h-3.5 w-3.5" />
            {t('AI 修复')}
          </Button>
          <span className="flex-1" />
          <Button variant="secondary" onClick={onClose}>
            {t('取消')}
          </Button>
          <Button onClick={save} disabled={!changed || busy}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t('保存')}
          </Button>
        </>
      }
    >
      <div className="flex min-w-0 flex-col gap-1">
        <p className="truncate font-mono text-caption text-subtle">{skill.path}</p>
        {opening.files.length > 0 && (
          <p className="truncate text-caption text-subtle">
            {t('文件夹里还有：{files}', { files: opening.files.join('、') })}
          </p>
        )}
      </div>
      <ScanFindings
        findings={scan}
        onIgnore={async (f) => {
          await configScanApi.ignore(f, opening.scanScope ?? '')
          setScan((l) => l.filter((x) => x !== f))
        }}
      />
      <Textarea
        aria-label={t('SKILL.md 内容')}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        spellCheck={false}
        rows={18}
        className="min-h-[18rem] font-mono text-footnote leading-relaxed"
      />
      {issues.length > 0 ? (
        <div className="flex flex-col gap-1 rounded-lg bg-warning/10 px-3 py-2 text-footnote text-warning">
          {issues.map((x) => (
            <p key={x} className="flex items-start gap-1.5">
              <CircleAlert className="mt-0.5 h-3 w-3 shrink-0" />
              {x}
            </p>
          ))}
        </div>
      ) : (
        <p className="text-footnote text-subtle">{t('格式没问题：name、description 和正文都齐了。')}</p>
      )}
    </Modal>
  )
}
