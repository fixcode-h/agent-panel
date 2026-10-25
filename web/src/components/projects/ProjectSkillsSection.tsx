import { useEffect, useMemo, useState } from 'react'
import { toast } from '@/lib/toast'
import {
  ChevronRight,
  CircleAlert,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  Wand2,
  Wrench,
} from 'lucide-react'
import type { ProjectSkill, ProjectSkillsView } from '@shared/project-skills'
import { DEFAULT_SKILL_REPO, projectSkillName, skillIssues } from '@shared/project-skills'
import { CLIS } from '@shared/clis'
import { cliSettings, orderClis } from '@shared/settings'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { openAiFix } from '@/lib/ai-fix'
import { cliColor } from '@/lib/cli-style'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Input, Select, Textarea } from '@/components/ui/input'
import { Modal } from '@/components/ui/modal'
import { CliSkills } from '@/components/settings/CliSkills'
import { AssistDialog } from '@/components/assist/AssistDialog'

/** 一个技能的内容和随内容一起读出来的附带文件 */
type Opening = { skill: ProjectSkill; content: string; files: string[] }

/** 列出这项技能会给哪些 Agent 读到（同一个目录常被几个 Agent 共用） */
const cliNames = (ids: string[]) => ids.map((id) => CLIS.find((c) => c.id === id)?.name ?? id).join(t('、'))

/**
 * 项目设置里的 Skill 分节：项目目录下各 Agent 的 skills.repo 里的技能，能新建、改、删，
 * 也能交给 AI —— 格式或说明有问题时「AI 修复」，想写得更好时「AI 优化」（结果先在弹窗里看，点应用才写文件）。
 */
export function ProjectSkillsSection({ projectId }: { projectId: string }) {
  const { clis: detected, settings } = useData()
  const [view, setView] = useState<ProjectSkillsView | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [editing, setEditing] = useState<Opening | null>(null)
  const [creating, setCreating] = useState(false)
  const [removing, setRemoving] = useState<ProjectSkill | null>(null)
  const [optimizing, setOptimizing] = useState<Opening | null>(null)
  const [expanded, setExpanded] = useState<string[]>([])

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
  useEffect(() => {
    setView(null)
    void load()
    // load 每次渲染都是新的函数，只在换项目时重新读；新建、删掉后自己调 load
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  // 按来源目录分组：.agents/skills 是几个 Agent 共用的，.claude/skills 只有 Claude Code 读
  const groups = useMemo(() => {
    const m = new Map<string, ProjectSkill[]>()
    for (const s of view?.skills ?? []) m.set(s.source, [...(m.get(s.source) ?? []), s])
    return [...m]
  }, [view])

  // 各 Agent 在这个项目里还能看到的用户级技能：停用、没装的 Agent 不列
  const readers = orderClis(CLIS, settings?.cliOrder ?? []).filter((c) => {
    const st = detected.find((x) => x.id === c.id)
    return st?.installed && (!settings || cliSettings(settings, c.id).enabled)
  })

  const open = async (skill: ProjectSkill) => {
    try {
      const f = await api.projectSkillFile(projectId, skill.source, skill.name)
      setEditing({ skill, content: f.content, files: f.files })
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const optimize = async (skill: ProjectSkill) => {
    try {
      const f = await api.projectSkillFile(projectId, skill.source, skill.name)
      setOptimizing({ skill, content: f.content, files: f.files })
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const fix = (skill: ProjectSkill, content: string) => {
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
      onDone: () => void load(),
    })
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h3 className="text-[0.9375rem] font-semibold">Skill</h3>
          <p className="text-[0.78125rem] leading-relaxed text-subtle">
            {t(
              '这个项目里的技能，放在项目目录下的技能目录里，跟着项目一起提交。Agent 按 SKILL.md 里的 description 判断什么时候用；改了这里的内容，新开的对话就会读到。',
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            {t('刷新')}
          </Button>
          <Button size="sm" onClick={() => setCreating(true)} disabled={!view?.path}>
            <Plus className="h-3.5 w-3.5" />
            {t('新建 Skill')}
          </Button>
        </div>
      </div>

      {error ? (
        <p className="rounded-xl border border-warning/40 bg-warning/5 px-3.5 py-2.5 text-[0.8125rem] text-warning">
          {t('读取失败：{error}', { error })}
        </p>
      ) : !view ? (
        <p className="text-[0.8125rem] text-subtle">{t('读取中…')}</p>
      ) : !view.path ? (
        <p className="rounded-xl border px-3.5 py-2.5 text-[0.8125rem] text-subtle">
          {t('先在「常规」里填好项目目录，再管理这里的技能。')}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.71875rem] text-subtle">
            <span className="truncate font-mono">{view.path}</span>
            <span className="shrink-0">
              {view.repos.map((r) => (
                <span key={r.dir} className="mr-2 inline-flex items-center gap-1 font-mono">
                  {r.dir}
                  {!r.exists && <span className="text-subtle/70">（{t('还没有')}）</span>}
                </span>
              ))}
            </span>
          </div>

          {!view.skills.length ? (
            <p className="rounded-xl border px-3.5 py-2.5 text-[0.8125rem] text-subtle">
              {t('还没有项目技能。点「新建 Skill」写一个，或者把已有的技能文件夹放进上面的目录。')}
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {groups.map(([source, items]) => (
                <div key={source} className="flex flex-col gap-1.5">
                  <p className="flex items-center gap-2 text-[0.71875rem] text-subtle">
                    <span className="truncate font-mono">{source}</span>
                    <span className="shrink-0">{items.length}</span>
                    <span className="truncate">{t('{clis} 会读这里', { clis: cliNames(items[0].clis) })}</span>
                  </p>
                  <ul className="flex flex-col divide-y rounded-lg border bg-card">
                    {items.map((s) => (
                      <li key={s.dir} className="flex items-start gap-2.5 px-3 py-2.5" title={s.path}>
                        <Sparkles
                          className={cn(
                            'mt-0.5 h-3.5 w-3.5 shrink-0',
                            s.issues.length ? 'text-warning' : 'text-accent',
                          )}
                        />
                        <button
                          type="button"
                          onClick={() => void open(s)}
                          className="min-w-0 flex-1 cursor-pointer text-left"
                        >
                          <p className="flex items-center gap-2 text-[0.8125rem]">
                            <span className="truncate font-mono">{s.name}</span>
                            {s.issues.length > 0 && (
                              <span className="shrink-0 rounded-full bg-warning/15 px-1.5 py-px text-[0.65625rem] text-warning">
                                {t('{n} 个问题', { n: s.issues.length })}
                              </span>
                            )}
                          </p>
                          <p
                            className={cn('line-clamp-2 text-[0.75rem]', s.description ? 'text-muted' : 'text-warning')}
                          >
                            {s.description || t('没写 description：Agent 不知道什么时候该用它')}
                          </p>
                          {s.issues.length > 0 && (
                            <p className="mt-0.5 flex items-start gap-1 text-[0.71875rem] text-warning">
                              <CircleAlert className="mt-0.5 h-3 w-3 shrink-0" />
                              <span className="line-clamp-2">{s.issues.join('；')}</span>
                            </p>
                          )}
                        </button>
                        <div className="flex shrink-0 items-center gap-1">
                          {s.issues.length > 0 && (
                            <Button
                              variant="ghost"
                              size="sm"
                              title={t('把 SKILL.md 和问题一起交给 AI 排查并修好')}
                              onClick={() =>
                                void api
                                  .projectSkillFile(projectId, s.source, s.name)
                                  .then((f) => fix(s, f.content))
                                  .catch((e) => toast.error((e as Error).message))
                              }
                            >
                              <Wrench className="h-3.5 w-3.5" />
                              {t('AI 修复')}
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            title={t('让 AI 改写 SKILL.md：说明和触发条件写清楚，看完再决定用不用')}
                            onClick={() => void optimize(s)}
                          >
                            <Wand2 className="h-3.5 w-3.5" />
                            {t('AI 优化')}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={t('编辑 {name}', { name: s.name })}
                            title={t('编辑 {name}', { name: s.name })}
                            onClick={() => void open(s)}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={t('删除 {name}', { name: s.name })}
                            title={t('删除 {name}', { name: s.name })}
                            onClick={() => setRemoving(s)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}

          {readers.length > 0 && (
            <div className="flex flex-col gap-1.5 pt-2">
              <h4 className="text-[0.8125rem] font-medium">{t('各 Agent 还能看到的用户级技能')}</h4>
              <p className="text-[0.75rem] text-muted">
                {t('用户目录里的技能不在这个项目里，改它们去 Skills 页；这里只是看清项目里的 Agent 一共能用哪些。')}
              </p>
              {readers.map((c) => (
                <div key={c.id} className="rounded-lg border">
                  <button
                    type="button"
                    onClick={() => setExpanded((e) => (e.includes(c.id) ? e.filter((x) => x !== c.id) : [...e, c.id]))}
                    aria-expanded={expanded.includes(c.id)}
                    className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-[0.8125rem] hover:bg-sel/50"
                  >
                    <ChevronRight
                      className={cn('h-3.5 w-3.5 shrink-0 text-subtle', expanded.includes(c.id) && 'rotate-90')}
                    />
                    <span className="h-3 w-3 shrink-0 rounded-[3px]" style={{ background: cliColor(c.id) }} />
                    <span className="truncate">{c.name}</span>
                  </button>
                  {expanded.includes(c.id) && (
                    <div className="px-3 pb-3">
                      <CliSkills cli={c.id} projectId={projectId} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {view?.path && creating && (
        <CreateSkillDialog
          projectId={projectId}
          view={view}
          onClose={() => setCreating(false)}
          onDone={(dir) => {
            setCreating(false)
            void load()
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
            void load()
          }}
          onOptimize={() => {
            setOptimizing(editing)
            setEditing(null)
          }}
          onFix={(content) => fix(editing.skill, content)}
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
            void load()
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
              void load()
            } catch (e) {
              toast.error((e as Error).message)
            }
          }}
        />
      )}
    </div>
  )
}

/** 新建：只定名字、目录和一句说明；骨架由服务端按项目技能模板写 */
function CreateSkillDialog({
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
          <span className="flex-1 text-[0.75rem] text-warning">{dup ? t('这个目录里已经有同名的了') : ''}</span>
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
        <span className="text-[0.8125rem] font-medium">{t('名字')}</span>
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value.trim())}
          placeholder="release-notes"
          className="font-mono"
        />
        <span className="text-[0.75rem] text-subtle">
          {name && !valid ? t('只能用字母、数字、. _ -，以字母或数字开头') : t('也是文件夹名，建好后不能改')}
        </span>
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-[0.8125rem] font-medium">{t('放在哪个目录')}</span>
        <Select
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          options={repos.map((r) => ({ value: r.dir, label: r.dir }))}
        />
        <span className="text-[0.75rem] text-subtle">
          {t('{clis} 会读这个目录', { clis: cliNames(repos.find((r) => r.dir === repo)?.clis ?? []) })}
        </span>
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-[0.8125rem] font-medium">{t('一句话说明什么时候用它')}</span>
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('例如：按团队约定写提交说明，先看改动再写')}
        />
        <span className="text-[0.75rem] text-subtle">
          {t('写在 SKILL.md 的 description 里，Agent 靠它判断什么时候该用；之后也可以让 AI 改写')}
        </span>
      </label>
    </Modal>
  )
}

/** 编辑 SKILL.md：改的时候实时提示格式问题，保存才写盘 */
function EditSkillDialog({
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
        <p className="truncate font-mono text-[0.71875rem] text-subtle">{skill.path}</p>
        {opening.files.length > 0 && (
          <p className="truncate text-[0.71875rem] text-subtle">
            {t('文件夹里还有：{files}', { files: opening.files.join('、') })}
          </p>
        )}
      </div>
      <Textarea
        aria-label={t('SKILL.md 内容')}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        spellCheck={false}
        rows={18}
        className="min-h-[18rem] font-mono text-[0.78125rem] leading-relaxed"
      />
      {issues.length > 0 ? (
        <div className="flex flex-col gap-1 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-[0.75rem] text-warning">
          {issues.map((x) => (
            <p key={x} className="flex items-start gap-1.5">
              <CircleAlert className="mt-0.5 h-3 w-3 shrink-0" />
              {x}
            </p>
          ))}
        </div>
      ) : (
        <p className="text-[0.75rem] text-subtle">{t('格式没问题：name、description 和正文都齐了。')}</p>
      )}
    </Modal>
  )
}
