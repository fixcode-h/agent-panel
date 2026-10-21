import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Eye, Loader2, PenLine, RotateCcw, Rocket, Save, Sparkles } from 'lucide-react'
import { BUNDLED_CATEGORIES } from '@shared/library'
import { SKILL_TARGET, type DeployConfig, type DeployState, type DeployStatus } from '@shared/deploy'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { cliColor } from '@/lib/cli-style'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/input'
import { Markdown } from '@/components/tasks/Markdown'
import { Optimizer } from '@/components/projects/ProjectDocs'
import { Group } from './parts'

const NO_TEAM = new Set<string>()

const DOC_STATUS: Record<DeployStatus, string> = {
  missing: t('未部署'),
  same: t('已是最新'),
  changed: t('内容不同，部署时旧文件备份为 .bak'),
}

/**
 * 部署：全局说明（AGENTS.md）写进各个 CLI 的用户目录；选中的自带 Skill 放到 ~/.agents/skills/<分类>/<名字>/，
 * 默认不加载，全局说明末尾附上技能清单，任务需要时再读。和 fixcode-h/Agent 原来的部署脚本做的事一样。
 */
export function DeploySection() {
  const { clis } = useData()
  // 只有已安装、已启用的 CLI 能部署；没启用的列出来但不能选
  const active = (id: string) => clis.some((c) => c.id === id && c.installed && c.enabled)
  const [st, setSt] = useState<DeployState | null>(null)
  const [draft, setDraft] = useState<DeployConfig | null>(null)
  const [error, setError] = useState('')
  const [mode, setMode] = useState<'edit' | 'preview'>('edit')
  const [optimizing, setOptimizing] = useState(false)
  const [overwrite, setOverwrite] = useState(false)
  const [busy, setBusy] = useState<'' | 'save' | 'run'>('')

  const apply = (s: DeployState) => {
    setSt(s)
    setDraft(s.config)
  }
  useEffect(() => {
    api
      .deployState()
      .then(apply)
      .catch((e) => setError((e as Error).message))
  }, [])

  const groups = useMemo(() => {
    const list = st?.skills ?? []
    const cats = [...BUNDLED_CATEGORIES, ...[...new Set(list.map((s) => s.category))].map((id) => ({ id, label: id }))]
    return cats
      .filter((c, i) => cats.findIndex((x) => x.id === c.id) === i)
      .map((c) => ({ ...c, items: list.filter((s) => s.category === c.id) }))
      .filter((g) => g.items.length)
  }, [st])

  if (error) return <p className="text-[0.8125rem] text-warning">{t('读取失败：{error}', { error })}</p>
  if (!st || !draft) return <p className="text-[0.8125rem] text-subtle">{t('读取中…')}</p>

  const dirty = JSON.stringify(draft) !== JSON.stringify(st.config)
  const set = (patch: Partial<DeployConfig>) => setDraft({ ...draft, ...patch })
  const toggle = <K extends 'skills' | 'clis'>(key: K, id: string, on: boolean) =>
    set({ [key]: on ? [...draft[key], id] : draft[key].filter((x) => x !== id) })
  const changed = st.skills.some((s) => s.status === 'changed')

  const save = async () => {
    setBusy('save')
    try {
      apply(await api.saveDeploy(draft))
      toast.success(t('已保存'))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy('')
    }
  }
  const run = async () => {
    setBusy('run')
    try {
      const { result: r, state } = await api.runDeploy({
        ...draft,
        clis: draft.clis.filter(active),
        overwrite,
      })
      apply(state)
      const docs = r.docs.filter((d) => d.result !== 'same').length
      toast.success(
        r.skills.length || r.removed.length || docs
          ? t('部署好了：技能新装 {a} 个、移除 {b} 个，全局说明写入 {c} 个 Agent', {
              a: r.skills.length,
              b: r.removed.length,
              c: docs,
            })
          : t('都已经是最新的了'),
      )
      if (r.kept.length)
        toast.warning(t('{names} 在本机改过，没有覆盖', { names: r.kept.join(t('、')) }), { duration: 8000 })
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="flex flex-col">
      <p className="text-[0.8125rem] leading-relaxed text-subtle">
        {t(
          '全局说明会写进下面选中的 Agent 的用户目录，在所有项目里每次启动时读入。选中的技能放到 {dir}/<分类>/<名字>/，默认不加载：全局说明末尾会附上技能清单，任务用得上时再去读。',
          { dir: SKILL_TARGET },
        )}
      </p>

      <Group title={t('全局说明（AGENTS.md）')}>
        <div className="flex min-h-[380px] flex-col overflow-hidden rounded-xl border bg-field/40">
          <div className="flex flex-wrap items-center gap-2 border-b bg-panel/60 px-3 py-2">
            <span className="font-mono text-[0.78125rem]">AGENTS.md</span>
            {draft.agentsMd !== st.config.agentsMd && (
              <span className="text-xs text-subtle">{t('已修改，保存或部署时写入')}</span>
            )}
            <div className="ml-auto flex items-center gap-1">
              <div className="flex rounded-lg border p-0.5">
                {(
                  [
                    ['edit', PenLine, t('编辑')],
                    ['preview', Eye, t('预览')],
                  ] as const
                ).map(([m, Icon, label]) => (
                  <button
                    key={m}
                    onClick={() => setMode(m)}
                    aria-pressed={mode === m}
                    className={cn(
                      'flex h-6 cursor-pointer items-center gap-1 rounded-md px-2 text-xs',
                      mode === m ? 'bg-sel text-fg' : 'text-subtle hover:text-fg',
                    )}
                  >
                    <Icon className="h-3 w-3" />
                    {label}
                  </button>
                ))}
              </div>
              <Button
                size="sm"
                variant="ghost"
                disabled={draft.agentsMd === st.template}
                onClick={() => set({ agentsMd: st.template })}
                title={t('换回内置的通用约束')}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {t('恢复默认')}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setOptimizing(true)}>
                <Sparkles className="h-3.5 w-3.5 text-accent" />
                {draft.agentsMd.trim() ? t('AI 优化') : t('AI 生成')}
              </Button>
            </div>
          </div>
          {optimizing && (
            <Optimizer
              title={draft.agentsMd.trim() ? t('用 AI 优化全局说明') : t('用 AI 生成全局说明')}
              hint={t(
                'Agent 在用户目录里只读运行，只写跨项目都成立的约束，不会改任何文件。结果先给你看，采用后再保存。',
              )}
              placeholder={t('想怎么写（可以不填），例如：加上 Windows 下的编码注意事项')}
              busyText={t('正在整理…')}
              start={(request, cli) =>
                api.optimizeGlobalDoc({ content: draft.agentsMd, request, cli, model: '', effort: '' })
              }
              onClose={() => setOptimizing(false)}
              onApply={(c) => {
                set({ agentsMd: c })
                setOptimizing(false)
                toast.success(t('已替换为 AI 给出的内容，保存或部署后生效'))
              }}
            />
          )}
          {mode === 'edit' ? (
            <Textarea
              value={draft.agentsMd}
              onChange={(e) => set({ agentsMd: e.target.value })}
              spellCheck={false}
              aria-label={t('全局说明')}
              placeholder={t('# 全局约束\n\n写给编码助手看、所有项目都适用的约定：语言、编码、提问方式、安全边界…')}
              className="min-h-[320px] flex-1 resize-y rounded-none border-0 bg-transparent px-4 py-3 font-mono text-[0.8125rem] leading-[1.65] focus:ring-0"
            />
          ) : (
            <div className="max-h-[520px] min-h-[320px] overflow-y-auto px-5 py-4">
              {draft.agentsMd.trim() ? (
                <Markdown text={draft.agentsMd} teamNames={NO_TEAM} />
              ) : (
                <p className="text-[0.8125rem] text-subtle">{t('还没有内容')}</p>
              )}
            </div>
          )}
        </div>
      </Group>

      <Group title={t('写到哪些 Agent')}>
        <ul className="flex flex-col divide-y overflow-hidden rounded-xl border bg-card">
          {st.targets.map((d) => (
            <li
              key={d.cli}
              title={active(d.cli) ? undefined : t('没有启用，先在这个 Agent 的设置里启用')}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5"
            >
              <Checkbox
                checked={active(d.cli) && draft.clis.includes(d.cli)}
                disabled={!active(d.cli)}
                onChange={(v) => toggle('clis', d.cli, v)}
                label={
                  <span className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full" style={{ background: cliColor(d.cli) }} />
                    {d.name}
                  </span>
                }
              />
              <span className="min-w-0 flex-1 truncate font-mono text-[0.75rem] text-subtle" title={d.path}>
                {d.path}
              </span>
              <span
                className={cn(
                  'text-[0.75rem]',
                  d.status === 'same' ? 'text-success' : d.status === 'changed' ? 'text-warning' : 'text-subtle',
                )}
              >
                {active(d.cli) ? DOC_STATUS[d.status] : t('未启用')}
              </span>
            </li>
          ))}
        </ul>
      </Group>

      <Group title={t('要部署的技能（已选 {n} 个）', { n: draft.skills.length })}>
        <div className="mb-2 flex flex-wrap items-center gap-3 text-[0.78125rem] text-subtle">
          <span className="min-w-0 flex-1 truncate font-mono" title={st.skillRoot}>
            {st.skillRoot}
          </span>
          <button
            className="cursor-pointer hover:text-fg"
            onClick={() => set({ skills: st.skills.map((s) => s.name) })}
          >
            {t('全选')}
          </button>
          <button className="cursor-pointer hover:text-fg" onClick={() => set({ skills: [] })}>
            {t('全不选')}
          </button>
        </div>
        <div className="flex flex-col gap-3">
          {groups.map((g) => (
            <section key={g.id} className="flex flex-col gap-1.5">
              <h4 className="px-1 text-[0.75rem] text-subtle">
                {g.label} · {g.items.length}
              </h4>
              <ul className="flex flex-col divide-y overflow-hidden rounded-xl border bg-card">
                {g.items.map((s) => {
                  const on = draft.skills.includes(s.name)
                  return (
                    <li key={s.name}>
                      <label className="flex cursor-pointer items-center gap-3 px-4 py-2.5 hover:bg-sel/40">
                        <div className="min-w-0 flex-1">
                          <p className="flex items-center gap-2 font-mono text-[0.8125rem]">
                            {s.name}
                            {s.status !== 'missing' && (
                              <span
                                className={cn(
                                  'font-sans text-[0.71875rem]',
                                  s.status === 'same' ? 'text-success' : 'text-warning',
                                )}
                              >
                                {s.status === 'same' ? t('已部署') : t('本机改过')}
                              </span>
                            )}
                          </p>
                          {s.description && (
                            <p className="line-clamp-1 text-[0.75rem] text-muted" title={s.description}>
                              {s.description}
                            </p>
                          )}
                        </div>
                        <Switch checked={on} onCheckedChange={(v) => toggle('skills', s.name, v)} aria-label={s.name} />
                      </label>
                    </li>
                  )
                })}
              </ul>
            </section>
          ))}
        </div>
      </Group>

      {/* 吸底的操作栏：滚动区域底下还有一段内边距（pb-10），栏下面和两侧用同色底盖住，下面的列表不会透上来 */}
      <div className="sticky -bottom-10 z-10 -mx-5 mt-5 -mb-10 flex flex-wrap items-center gap-3 border-t bg-card px-5 pt-3 pb-13 md:-mx-8 md:px-8">
        {changed && (
          <Checkbox
            checked={overwrite}
            onChange={setOverwrite}
            label={t('覆盖本机改过的技能')}
            hint={t('不勾时保留你改过的版本')}
          />
        )}
        <span className="ml-auto" />
        <Button variant="secondary" disabled={!dirty || !!busy} onClick={() => void save()}>
          {busy === 'save' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          {t('保存')}
        </Button>
        <Button disabled={!!busy} onClick={() => void run()}>
          {busy === 'run' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Rocket className="h-3.5 w-3.5" />}
          {t('部署')}
        </Button>
      </div>
    </div>
  )
}
