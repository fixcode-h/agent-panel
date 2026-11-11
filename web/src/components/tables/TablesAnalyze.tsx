import { useMemo, useState, useSyncExternalStore } from 'react'
import { Loader2, Sparkles } from 'lucide-react'
import { t } from '@shared/i18n'
import type { Proposal } from '@shared/assist'
import { applyTablesDraft, draftHeaders, draftItemIds, TablesDraft } from '@shared/tables-assist'
import { TYPE_NAMES } from '@shared/tables'
import { runAssistInProject } from '@/lib/assist-conv'
import { tablesApi } from '@/lib/tables-api'
import { saveTableSchema, useTableSchema } from '@/lib/table-schema'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { roleShort } from '@/components/files/sheet-roles'

/**
 * AI 分析表格的结果：对话可能跑几分钟，设置关了也要留着，所以记在模块里（按项目），
 * 回到项目设置的「表格」页再勾选应用。也存一份在本机浏览器里：刷新页面、重开面板后还能接着应用
 */
const STORE_KEY = 'agent-panel:tables-analysis'
const pending = new Map<string, TablesDraft>(loadPending())
const subs = new Set<() => void>()
const emit = () => {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(Object.fromEntries(pending)))
  } catch {
    // 存不了（隐私模式、存满）就只记在内存里
  }
  subs.forEach((f) => f())
}
function loadPending(): [string, TablesDraft][] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') as Record<string, unknown>
    return Object.entries(raw).flatMap(([id, d]) => {
      const p = TablesDraft.safeParse(d)
      return p.success ? [[id, p.data] as [string, TablesDraft]] : []
    })
  } catch {
    return []
  }
}
const subscribe = (f: () => void) => {
  subs.add(f)
  return () => subs.delete(f)
}

/** 这个项目有没有还没处理的 AI 分析结果（项目设置「AI 分析」子页签上的小红点） */
export const useTablesAnalysisPending = (projectId: string | undefined) =>
  useSyncExternalStore(subscribe, () => !!projectId && pending.has(projectId))

/** 收到结果时调（设置开着关着都行） */
function deliverTables(projectId: string, p: Proposal) {
  if (p.kind !== 'tables') return
  pending.set(projectId, p.draft)
  emit()
}

/**
 * 项目设置「表格」页底下的 AI 分析：读几张表的样本，在项目里开一个对话让 AI 总结风格，
 * 结果逐项勾选后写进结构文件（不经过「确认」，结构文件不在项目设置里）
 */
export function TablesAnalyze({ projectId, projectName }: { projectId: string; projectName: string }) {
  const draft = useSyncExternalStore(subscribe, () => pending.get(projectId))
  const { schema } = useTableSchema(projectId)
  const [busy, setBusy] = useState(false)

  const start = async () => {
    setBusy(true)
    try {
      const sample = await tablesApi.sample(projectId)
      if (!sample.text.trim()) throw new Error(t('表格目录里还没有能读的表格'))
      runAssistInProject({
        kind: 'tables',
        projectId,
        title: t('AI 分析表格风格：{name}', { name: projectName }),
        start: t('分析这个项目的表格风格：有几套表头、每套几行、主键、列表分隔符、枚举和引用'),
        subject: { sample: sample.text },
        // 结果回到项目设置的「表格」页勾选，对话右侧不出项目设置的应用面板
        analysis: 'run',
        onProposal: (p) => deliverTables(projectId, p),
      })
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 text-footnote leading-relaxed text-subtle">
          {schema?.analyzedAt
            ? t('上次分析：{time}。表格加了新类型、换了表头写法时可以再分析一次。', {
                time: new Date(schema.analyzedAt).toLocaleString(),
              })
            : t(
                '让 AI 读几张表的开头几行，总结有几套表头、每套几行每行是什么、主键、列表分隔符、哪些类型是枚举、哪些列引用别的表。',
              )}
        </p>
        <Button size="sm" onClick={() => void start()} disabled={busy}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          {t('AI 分析')}
        </Button>
      </div>
      {draft && schema && (
        <DraftReview
          draft={draft}
          onCancel={() => {
            pending.delete(projectId)
            emit()
          }}
          onApply={async (picked) => {
            try {
              // 在最新的结构文件上并：设置页别的地方刚存的不会被盖掉；存好后上面的「表头」「通用枚举」跟着更新
              await saveTableSchema(projectId, (cur) => applyTablesDraft(cur, draft, picked, new Date().toISOString()))
              pending.delete(projectId)
              emit()
              toast.success(t('已应用到表格设置：上面的表头、通用枚举已经更新，表格页按新的结构显示'))
            } catch (e) {
              toast.error((e as Error).message)
            }
          }}
        />
      )}
    </div>
  )
}

/** 一项一行：勾上的才写进去 */
function DraftReview({
  draft,
  onCancel,
  onApply,
}: {
  draft: TablesDraft
  onCancel: () => void
  onApply: (picked: Set<string>) => Promise<void>
}) {
  const ids = useMemo(() => draftItemIds(draft), [draft])
  const [picked, setPicked] = useState(() => new Set(ids))
  const [saving, setSaving] = useState(false)
  const s = draft.style
  const header = (h: { start: number; roles: Parameters<typeof roleShort>[0][]; labels?: string[] }) =>
    t('从第 {n} 行开始：{roles}', {
      n: h.start + 1,
      roles: h.roles.map((r, i) => h.labels?.[i] || roleShort(r)).join(' / '),
    })
  const items: { id: string; label: string; detail: string }[] = ids.map((id) => {
    if (id === 'headers') {
      const hs = draftHeaders(s)
      return {
        id,
        label: hs.length > 1 ? t('表头（{n} 套，按内容自动挑）', { n: hs.length }) : t('表头'),
        detail: hs.map((h) => t('{n} 行', { n: h.roles.length }) + ' · ' + header(h)).join('；'),
      }
    }
    if (id === 'arrayMarks') return { id, label: t('表示数组的修饰'), detail: s.arrayMarks!.join(', ') }
    if (id === 'roleEnums')
      return {
        id,
        label: t('表头行能填什么'),
        detail: Object.entries(s.roleEnums!)
          .map(
            ([r, e]) =>
              `${roleShort(r as Parameters<typeof roleShort>[0])} = ${e === TYPE_NAMES ? t('基础类型和通用枚举名') : e}`,
          )
          .join(' · '),
      }
    if (id === 'key') return { id, label: t('主键'), detail: s.key! }
    if (id === 'listSep') return { id, label: t('列表分隔符'), detail: s.listSep! }
    if (id === 'primitives') return { id, label: t('基础类型'), detail: s.primitives!.join(', ') }
    if (id.startsWith('ex:')) {
      const e = s.exceptions![Number(id.slice(3))]
      return {
        id,
        label: t('例外：{glob}', { glob: e.glob }),
        detail: [header(e.header), e.why].filter(Boolean).join(' · '),
      }
    }
    if (id.startsWith('enum:')) {
      const e = draft.enums[id.slice(5)]
      return {
        id,
        label: t('枚举：{name}', { name: id.slice(5) }),
        detail: e.values.map((v) => v.name).join(', '),
      }
    }
    const c = draft.columns[id.slice(4)]
    return {
      id,
      label: t('列：{key}', { key: id.slice(4).replace('#*#', ' · ') }),
      detail: [
        c.ref && t('引用 {ref}', { ref: c.ref }),
        c.min !== undefined && t('最小 {n}', { n: c.min }),
        c.max !== undefined && t('最大 {n}', { n: c.max }),
        c.allow?.length && t('也允许 {v}', { v: c.allow.join(', ') }),
        c.note,
      ]
        .filter(Boolean)
        .join(' · '),
    }
  })
  return (
    <section aria-label={t('AI 分析结果')} className="rounded-(--c-card-radius) border bg-panel">
      <header className="border-b px-3 py-2.5">
        <p className="text-body font-medium">{t('AI 分析结果')}</p>
        {draft.summary && <p className="mt-0.5 text-footnote text-muted">{draft.summary}</p>}
      </header>
      {items.length === 0 ? (
        <p className="px-3 py-3 text-footnote text-subtle">{t('这次分析没有给出可以写进结构文件的内容')}</p>
      ) : (
        <ul className="max-h-80 divide-y overflow-y-auto">
          {items.map((it) => (
            <li key={it.id} className="flex items-start gap-3 px-3 py-2">
              <Checkbox
                checked={picked.has(it.id)}
                ariaLabel={it.label}
                onChange={(v) =>
                  setPicked((p) => {
                    const n = new Set(p)
                    if (v) n.add(it.id)
                    else n.delete(it.id)
                    return n
                  })
                }
                className="mt-0.5"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-footnote font-medium">{it.label}</span>
                <span className="block truncate font-mono text-caption text-subtle" title={it.detail}>
                  {it.detail}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      <footer className="flex items-center justify-end gap-2 border-t px-3 py-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t('不要了')}
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={!picked.size || saving}
          onClick={async () => {
            setSaving(true)
            await onApply(picked)
            setSaving(false)
          }}
        >
          {t('应用到表格设置（{n} 项）', { n: picked.size })}
        </Button>
      </footer>
    </section>
  )
}
