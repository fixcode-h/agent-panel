import { useEffect, useMemo, useState } from 'react'
import { t } from '@shared/i18n'
import { agentToolsContract as C, type SkillList } from '@shared/api-contract/agent-tools'
import type { SkillPatch, SkillRow } from '@shared/skills/rows'
import { call } from '@/lib/api/call'
import { toastError } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { EmptyPanel } from '@/components/ui/empty-panel'
import { SearchBox } from '@/components/ui/search-box'
import { Switch } from '@/components/ui/switch'
import { SkillDetail } from './SkillDetail'
import { whenSummary } from './when-text'

/**
 * 「Agent 工具 → 技能」（ADR 0083）：左边是技能目录，按来源分组、可以搜；每行写什么时候推、最近推了几次、开关。
 * 右边是选中技能的详情（SkillDetail）。数据和改动都走 shared/api-contract/agent-tools.ts
 */
export function SkillsTab() {
  const [data, setData] = useState<SkillList>()
  const [q, setQ] = useState('')
  const [sel, setSel] = useState('')
  useEffect(() => {
    let alive = true
    call(C.skills)
      .then((r) => {
        if (!alive) return
        setData(r)
        setSel((s) => s || r.skills[0]?.name || '')
      })
      .catch(toastError)
    return () => {
      alive = false
    }
  }, [])

  const update = async (name: string, patch: SkillPatch) => {
    try {
      const row = await call(C.updateSkill, { params: { name }, body: patch })
      setData((d) => d && { ...d, skills: d.skills.map((x) => (x.name === name ? row : x)) })
    } catch (e) {
      toastError(e)
    }
  }
  const setLimit = async (tokens: number) => {
    try {
      const r = await call(C.setSkillLimit, { body: { tokens } })
      setData((d) => d && { ...d, limit: r.tokens })
    } catch (e) {
      toastError(e)
    }
  }

  const groups = useMemo(() => {
    const list = (data?.skills ?? []).filter((s) => !q || s.name.includes(q) || s.guide.includes(q))
    const by = new Map<string, SkillRow[]>()
    for (const s of list) {
      const key = s.source === 'plugin' ? t('插件 · {name}', { name: s.pluginName ?? s.plugin ?? '' }) : t('自带')
      by.set(key, [...(by.get(key) ?? []), s])
    }
    return [...by]
  }, [data, q])

  if (!data) return <EmptyPanel>{t('读取中…')}</EmptyPanel>
  const cur = data.skills.find((s) => s.name === sel)
  return (
    <div className="flex flex-col gap-4">
      <p className="rounded-lg bg-sel/50 px-4 py-3 text-body text-muted">
        {t(
          '角色自带的技能开跑时就带；其他技能 Agent 一开始看不到，由面板按条件把正文推给它。单个对话推送上限 {n} token，超了只推路径。',
          { n: data.limit },
        )}
        {!data.enabled && (
          <span className="ml-1 text-warning">{t('「按情境推技能」在钩子里关掉了，现在不会推。')}</span>
        )}
      </p>
      <div className="flex flex-col gap-4 md:flex-row md:items-start">
        <div className="flex min-w-0 flex-col gap-3 md:w-[46%] md:shrink-0" data-skill-list>
          <SearchBox live allowEmpty placeholder={t('搜索技能')} onSearch={setQ} />
          {!groups.length && <EmptyPanel size="sm">{t('没有对得上的技能')}</EmptyPanel>}
          {groups.map(([title, rows]) => (
            <section key={title} className="flex flex-col gap-1">
              <h3 className="px-1 text-footnote text-subtle">{title}</h3>
              <ul className="flex flex-col">
                {rows.map((s) => (
                  <SkillLine
                    key={s.name}
                    s={s}
                    active={s.name === sel}
                    onPick={() => setSel(s.name)}
                    onToggle={(on) => void update(s.name, { on })}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
        {cur ? (
          <SkillDetail
            key={cur.name}
            s={cur}
            limit={data.limit}
            onPatch={(p) => update(cur.name, p)}
            onLimit={setLimit}
          />
        ) : (
          <EmptyPanel className="flex-1">{t('选一个技能看详情')}</EmptyPanel>
        )}
      </div>
    </div>
  )
}

function SkillLine({
  s,
  active,
  onPick,
  onToggle,
}: {
  s: SkillRow
  active: boolean
  onPick: () => void
  onToggle: (on: boolean) => void
}) {
  const summary = s.when.length ? whenSummary(s.when) : t('只靠角色自带或「/名字」点名')
  return (
    <li
      data-skill={s.name}
      className={cn('flex items-center gap-3 rounded-lg px-3 py-2', active ? 'bg-sel' : 'hover:bg-sel/60')}
    >
      <button type="button" onClick={onPick} className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 text-left">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-mono text-body text-fg">{s.name}</span>
          {s.roles.length > 0 && <Badge tone="accent">{t('角色自带')}</Badge>}
          {s.always && <Badge tone="success">{t('每个对话都带')}</Badge>}
          {!s.defaults.on && !s.on && <Badge>{t('不自动推')}</Badge>}
        </span>
        <span className="truncate text-footnote text-muted" title={summary}>
          {summary}
        </span>
      </button>
      <span className="shrink-0 text-caption text-subtle tabular-nums">
        {s.pushes ? t('{n} 次', { n: s.pushes }) : '–'}
      </span>
      <Switch checked={s.on} onCheckedChange={onToggle} aria-label={t('自动推 {name}', { name: s.name })} />
    </li>
  )
}
