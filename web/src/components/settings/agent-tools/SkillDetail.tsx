import { useEffect, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { t } from '@shared/i18n'
import { agentToolsContract as C, type SkillPushRecord } from '@shared/api-contract/agent-tools'
import type { SkillPatch, SkillRow } from '@shared/skills/rows'
import type { SkillWhen, SkillWhenKind } from '@shared/skills/schema'
import { timeAgo } from '@shared/task'
import { call } from '@/lib/api/call'
import { useNav, useTasks } from '@/lib/data'
import { toastError } from '@/lib/toast'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Input, Select } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { PHASE_OPTIONS, WHEN_KIND_OPTIONS, whenPlaceholder } from './when-text'

/**
 * 「Agent 工具 → 技能」右边的详情：说明、条件（任意一条对上就推，可以增删改）、每个对话都带、恢复默认、最近推送。
 * 条件先改在本地，选完下拉、输入框失焦时把填好的几条存下去（空的那行不存，等填好再说）
 */
export function SkillDetail({
  s,
  limit,
  onPatch,
  onLimit,
}: {
  s: SkillRow
  limit: number
  onPatch: (p: SkillPatch) => Promise<void>
  onLimit: (tokens: number) => Promise<void>
}) {
  const [draft, setDraft] = useState<SkillWhen[]>(s.when)
  const [pushes, setPushes] = useState<SkillPushRecord[]>()
  const [limitText, setLimitText] = useState(String(limit))
  const { tasks } = useTasks()
  const { go, closeSettings } = useNav()
  useEffect(() => {
    let alive = true
    call(C.skillPushes, { params: { name: s.name } })
      .then((r) => alive && setPushes(r.pushes))
      .catch(toastError)
    return () => {
      alive = false
    }
  }, [s.name, s.pushes])

  const commit = (next: SkillWhen[]) => {
    setDraft(next)
    const valid = next.filter((w) => w.value.trim())
    if (JSON.stringify(valid) !== JSON.stringify(s.when)) void onPatch({ when: valid })
  }
  const edit = (i: number, w: Partial<SkillWhen>, save: boolean) => {
    const next = draft.map((x, j) => (j === i ? { ...x, ...w } : x))
    if (save) commit(next)
    else setDraft(next)
  }
  const openTask = (id: string) => {
    const task = tasks.find((x) => x.id === id)
    closeSettings()
    go(task?.projectId ? { page: 'projects', id: task.projectId, sub: id } : { page: 'chat', id })
  }

  return (
    <div
      className="flex min-w-0 flex-1 flex-col gap-5 rounded-xl border border-line px-5 py-4"
      data-skill-detail={s.name}
    >
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="font-mono text-heading text-fg">{s.name}</h3>
        <Badge>{s.source === 'plugin' ? t('插件') : t('自带')}</Badge>
        {s.changed && <Badge tone="accent">{t('已改')}</Badge>}
        <span className="flex-1" />
        {s.changed && (
          <Button variant="link" onClick={() => void onPatch({ reset: true }).then(() => setDraft(s.defaults.when))}>
            {t('恢复默认')}
          </Button>
        )}
      </header>
      <p className="text-body text-muted">
        {s.guide}
        {s.roles.length > 0 && (
          <span className="mt-1 block text-footnote text-subtle">
            {t('这些角色自带，开跑就带上：{names}', { names: s.roles.join('、') })}
          </span>
        )}
      </p>

      <section className="flex flex-col gap-2 border-t border-line pt-4">
        <h4 className="text-footnote text-subtle">{t('什么时候推（任意一条对上）')}</h4>
        {!draft.length && <p className="text-footnote text-subtle">{t('没有条件：只靠角色自带或用户「/名字」点名')}</p>}
        {draft.map((w, i) => (
          <div key={i} className="flex items-center gap-2" data-skill-when={w.kind}>
            <Select
              size="sm"
              className="w-32 shrink-0"
              aria-label={t('条件类型')}
              options={WHEN_KIND_OPTIONS()}
              value={w.kind}
              onChange={(e) => edit(i, { kind: e.target.value as SkillWhenKind, value: '' }, false)}
            />
            {w.kind === 'phase' ? (
              <Select
                size="sm"
                className="min-w-0 flex-1"
                aria-label={t('阶段')}
                placeholder={t('选一个阶段')}
                options={PHASE_OPTIONS()}
                value={w.value}
                onChange={(e) => edit(i, { value: e.target.value }, true)}
              />
            ) : (
              <Input
                size="sm"
                className="min-w-0 flex-1 font-mono"
                aria-label={t('条件的值')}
                placeholder={whenPlaceholder(w.kind)}
                value={w.value}
                onChange={(e) => edit(i, { value: e.target.value }, false)}
                onBlur={() => commit(draft)}
              />
            )}
            <IconButton icon={X} label={t('删掉这条条件')} onClick={() => commit(draft.filter((_, j) => j !== i))} />
          </div>
        ))}
        <Button variant="link" className="self-start" onClick={() => setDraft([...draft, { kind: 'edit', value: '' }])}>
          <Plus className="h-3.5 w-3.5" />
          {t('加条件')}
        </Button>
      </section>

      <section className="flex items-center gap-3 border-t border-line pt-4">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-body text-fg">{t('每个对话都带')}</span>
          <span className="text-footnote text-muted">{t('当成所有角色的自带技能，开跑就带上')}</span>
        </div>
        <Switch
          checked={s.always}
          onCheckedChange={(v) => void onPatch({ always: v })}
          aria-label={t('每个对话都带')}
        />
      </section>

      <section className="flex items-center gap-3 border-t border-line pt-4">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-body text-fg">{t('单个对话推送上限（token）')}</span>
          <span className="text-footnote text-muted">{t('所有技能共用；超过后只推一行路径，0 表示只推路径')}</span>
        </div>
        <Input
          size="sm"
          type="number"
          className="w-28 shrink-0"
          aria-label={t('单个对话推送上限（token）')}
          value={limitText}
          onChange={(e) => setLimitText(e.target.value)}
          onBlur={() => {
            const n = Number(limitText)
            if (Number.isInteger(n) && n !== limit) void onLimit(n)
          }}
        />
      </section>

      <section className="flex flex-col gap-1 border-t border-line pt-4">
        <h4 className="text-footnote text-subtle">{t('最近推送')}</h4>
        {pushes && !pushes.length && <p className="text-footnote text-subtle">{t('重启以来还没推过')}</p>}
        <ul className="flex flex-col">
          {(pushes ?? []).map((p, i) => (
            <li key={i}>
              <button
                type="button"
                onClick={() => openTask(p.taskId)}
                className="flex w-full cursor-pointer items-center gap-3 rounded-md px-1.5 py-1 text-left hover:bg-sel/60"
              >
                <span className="w-16 shrink-0 text-caption text-subtle tabular-nums">{timeAgo(p.at)}</span>
                <span className="min-w-0 flex-1 truncate text-body text-fg">{p.title || t('对话')}</span>
                <span className="max-w-[40%] shrink-0 truncate font-mono text-caption text-muted" title={p.trigger}>
                  {p.trigger === 'restored' ? t('压缩后补推') : p.trigger === 'slash' ? t('用户点名') : p.trigger}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
