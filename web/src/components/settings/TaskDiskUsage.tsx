import { useEffect, useMemo, useState } from 'react'
import { toast } from '@/lib/toast'
import { ChevronDown, Loader2, Trash2 } from 'lucide-react'
import { formatBytes } from '@shared/memory'
import { TRASH_RETENTION_DAYS, timeAgo } from '@shared/task'
import { api, type TaskDiskItem } from '@/lib/api'
import { useData } from '@/lib/data'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Select } from '@/components/ui/input'
import { Card } from '@/components/ui/card'
import { t } from '@shared/i18n'

/** 一个顶层对话连同它的子对话：占用、子对话数都合在一起算，删除时也一起进回收站（服务端就是这么删的） */
type Conv = TaskDiskItem & { total: number; kids: number; latest: string; busy: boolean }

type Group = { id: string; name: string; total: number; convs: Conv[] }

/** 每个项目展开后最多列这么多个对话（按占用从大到小），再多的看不过来，也不是要清理的那些 */
const SHOWN = 30
const DAY = 86_400_000

/**
 * 对话的磁盘占用：按项目分组，项目里按「父对话 + 子对话」合计，大的在前。
 * 可以只看很久没动的，逐个或一次删掉（进回收站，到期后才真正释放空间）；正在执行的不能删
 */
export function TaskDiskUsage({ onChanged }: { onChanged?: () => void }) {
  const { projects, removeTask } = useData()
  const [items, setItems] = useState<TaskDiskItem[] | null>(null)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [stale, setStale] = useState('0')
  const [deleting, setDeleting] = useState<Conv[] | null>(null)

  const load = async () => {
    try {
      setItems(await api.taskDisk())
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }
  useEffect(() => {
    void load()
  }, [])

  const groups = useMemo(() => {
    if (!items) return []
    const kids = new Map<string, TaskDiskItem[]>()
    for (const x of items) if (x.parentTaskId) kids.set(x.parentTaskId, [...(kids.get(x.parentTaskId) ?? []), x])
    const ids = new Set(items.map((x) => x.id))
    const cutoff = Number(stale) ? Date.now() - Number(stale) * DAY : Infinity
    const byProject = new Map<string, Group>()
    for (const x of items) {
      if (x.parentTaskId && ids.has(x.parentTaskId)) continue
      const ks = kids.get(x.id) ?? []
      const latest = [x.updatedAt, ...ks.map((k) => k.updatedAt)].sort().at(-1)!
      // 只看很久没动的：父对话和子对话都没动过才算
      if (cutoff !== Infinity && new Date(latest).getTime() > cutoff) continue
      const conv: Conv = {
        ...x,
        total: x.bytes + ks.reduce((a, k) => a + k.bytes, 0),
        kids: ks.length,
        latest,
        busy: x.working || ks.some((k) => k.working),
      }
      const name = x.projectId ? (projects.find((p) => p.id === x.projectId)?.name ?? t('已删除的项目')) : t('聊天')
      const g = byProject.get(x.projectId) ?? { id: x.projectId, name, total: 0, convs: [] }
      g.total += conv.total
      g.convs.push(conv)
      byProject.set(x.projectId, g)
    }
    for (const g of byProject.values()) g.convs.sort((a, b) => b.total - a.total)
    return [...byProject.values()].sort((a, b) => b.total - a.total)
  }, [items, projects, stale])

  const remove = async (convs: Conv[]) => {
    let done = 0
    for (const c of convs) {
      try {
        await api.deleteTask(c.id)
        removeTask(c.id)
        done++
      } catch (e) {
        toast.error(t('删除「{title}」失败：{msg}', { title: c.title, msg: (e as Error).message }))
      }
    }
    if (done) toast.success(t('已移到回收站 {n} 个对话', { n: done }))
    setDeleting(null)
    await load()
    onChanged?.()
  }

  const toggle = (id: string) =>
    setOpen((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const all = groups.flatMap((g) => g.convs)
  const removable = all.filter((c) => !c.busy)

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h3 className="text-[0.8125rem] font-semibold">{t('对话占用')}</h3>
        {items && (
          <span className="text-xs text-subtle">
            {t('{n} 个对话 · 共 {size}', { n: all.length, size: formatBytes(all.reduce((a, c) => a + c.total, 0)) })}
          </span>
        )}
        <Select
          className="ml-auto h-7 w-[132px] text-xs"
          aria-label={t('筛选')}
          value={stale}
          onChange={(e) => setStale(e.target.value)}
          options={[
            { value: '0', label: t('全部') },
            { value: '30', label: t('30 天没动的') },
            { value: '90', label: t('90 天没动的') },
            { value: '180', label: t('半年没动的') },
          ]}
        />
        {stale !== '0' && (
          <Button variant="secondary" size="sm" disabled={!removable.length} onClick={() => setDeleting(removable)}>
            <Trash2 className="h-3.5 w-3.5" />
            {t('全部删除')}
          </Button>
        )}
      </div>
      {error ? (
        <p className="text-xs leading-relaxed text-danger">{t('读取对话占用失败：{msg}', { msg: error })}</p>
      ) : !items ? (
        <p className="flex items-center gap-1.5 text-xs text-subtle">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t('正在统计…')}
        </p>
      ) : !groups.length ? (
        <p className="text-xs text-subtle">{stale !== '0' ? t('没有这么久没动的对话。') : t('还没有对话。')}</p>
      ) : (
        <Card className="overflow-hidden">
          {groups.map((g) => {
            const expanded = open.has(g.id)
            return (
              <div key={g.id || 'chat'} className="border-b last:border-b-0">
                <button
                  onClick={() => toggle(g.id)}
                  aria-expanded={expanded}
                  className="flex w-full cursor-pointer items-center gap-2 px-3.5 py-2.5 text-left hover:bg-sel"
                >
                  <ChevronDown
                    className={cn('h-3.5 w-3.5 shrink-0 text-subtle transition-transform', !expanded && '-rotate-90')}
                  />
                  <span className="min-w-0 flex-1 truncate text-[0.8125rem]">{g.name}</span>
                  <span className="shrink-0 text-xs text-subtle">{t('{n} 个对话', { n: g.convs.length })}</span>
                  <span className="w-[76px] shrink-0 text-right font-mono text-[0.75rem] text-muted">
                    {formatBytes(g.total)}
                  </span>
                </button>
                {expanded && (
                  <div className="border-t bg-card/40">
                    {g.convs.slice(0, SHOWN).map((c) => (
                      <div key={c.id} className="flex items-center gap-3 py-2 pr-3.5 pl-9">
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="truncate text-[0.8125rem]">{c.title}</span>
                          <span className="truncate text-xs text-subtle">
                            {[
                              t('{time}更新', { time: timeAgo(c.latest) }),
                              c.kids ? t('含 {n} 个子对话', { n: c.kids }) : '',
                              c.archived ? t('已归档') : '',
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </span>
                        </span>
                        <span className="shrink-0 font-mono text-[0.75rem] text-muted">{formatBytes(c.total)}</span>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('删除')}
                          title={c.busy ? t('正在执行，不能删除') : t('删除')}
                          disabled={c.busy}
                          onClick={() => setDeleting([c])}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                    {g.convs.length > SHOWN && (
                      <p className="py-2 pl-9 text-xs text-subtle">
                        {t('还有 {n} 个较小的对话没有列出', { n: g.convs.length - SHOWN })}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </Card>
      )}
      <ConfirmDialog
        open={!!deleting}
        title={
          deleting?.length === 1
            ? t('删除「{title}」？', { title: deleting[0].title })
            : t('删除 {n} 个对话？', { n: deleting?.length ?? 0 })
        }
        description={t(
          '对话和子对话一起移到回收站（共 {size}），{days} 天内可以在下面的回收站里恢复，之后自动永久删除、释放空间。',
          {
            size: formatBytes(deleting?.reduce((a, c) => a + c.total, 0) ?? 0),
            days: TRASH_RETENTION_DAYS,
          },
        )}
        onConfirm={() => (deleting ? remove(deleting) : undefined)}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </section>
  )
}
