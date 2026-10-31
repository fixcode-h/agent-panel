import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from '@/lib/toast'
import type { InterruptedTask } from '@shared/version'
import { api } from '@/lib/api'
import { useData, useNav } from '@/lib/data'
import { t } from '@shared/i18n'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Modal } from '@/components/ui/modal'

/**
 * 强制更新会停掉所有正在执行的任务。新版本启动后问一次：这些任务要不要接着跑？
 * 默认全部勾选，取消勾选的不处理；点「稍后再说」或关掉弹窗不再自动弹，记录留在缓存目录里。
 */
export function UpdateResumeDialog() {
  const { projects } = useData()
  const { go } = useNav()
  const [tasks, setTasks] = useState<InterruptedTask[]>([])
  const [open, setOpen] = useState(false)
  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const [pending, setPending] = useState(false)

  useEffect(() => {
    let live = true
    api
      .appInterrupted()
      .then((r) => {
        // 已经处理过的、或者在页面打开前就清空了的不弹
        if (!live || r.acknowledged || !r.tasks.length) return
        setTasks(r.tasks)
        setChecked(Object.fromEntries(r.tasks.map((x) => [x.id, true])))
        setOpen(true)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])

  const projectNames = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects])
  const selected = tasks.filter((x) => checked[x.id])

  /** 关掉弹窗：记下「处理过了」，下次启动不再弹 */
  const close = useCallback(() => {
    setOpen(false)
    void api.appInterruptedAck().catch(() => {})
  }, [])

  /** 逐个继续：有的任务可能已经被删掉、状态不允许继续，最后汇总一条提示 */
  const resume = async () => {
    if (pending) return
    const list = selected
    setPending(true)
    setOpen(false)
    let ok = 0
    let failed = 0
    for (const x of list) {
      try {
        await api.resumeTask(x.id)
        ok++
      } catch {
        failed++
      }
    }
    setPending(false)
    void api.appInterruptedAck().catch(() => {})
    if (ok && failed) toast.warning(t('已在后台继续 {ok} 个任务，{failed} 个没能继续', { ok, failed }))
    else if (failed) toast.error(t('{failed} 个任务没能继续，可能已经被删除或状态不允许', { failed }))
    else if (ok) toast.success(t('已在后台继续 {ok} 个任务', { ok }))
  }

  // 打开任务页看结果；弹窗不再需要了
  const openTask = (x: InterruptedTask) => {
    setOpen(false)
    go(x.projectId ? { page: 'projects', id: x.projectId, sub: x.id } : { page: 'chat', id: x.id })
  }

  // 按模式、再按项目分组（用户要求）：Agent 模式的任务按项目各成一组，Chat（不属于项目）单独一组放最后。
  // 任务多的时候一眼看出是哪个项目的，也能整组勾掉
  const groups = useMemo(() => {
    const by = new Map<string, { key: string; mode: string; name: string; items: InterruptedTask[] }>()
    for (const x of tasks) {
      const key = x.projectId ? `agent:${x.projectId}` : 'chat'
      const g = by.get(key) ?? {
        key,
        mode: x.projectId ? 'Agent' : 'Chat',
        name: x.projectId ? (projectNames.get(x.projectId) ?? x.projectName) || t('未命名项目') : '',
        items: [],
      }
      g.items.push(x)
      by.set(key, g)
    }
    return [...by.values()].sort(
      (a, b) => Number(a.mode === 'Chat') - Number(b.mode === 'Chat') || a.name.localeCompare(b.name),
    )
  }, [tasks, projectNames])

  if (!open) return null
  const setAll = (items: InterruptedTask[], v: boolean) =>
    setChecked((c) => ({ ...c, ...Object.fromEntries(items.map((x) => [x.id, v])) }))

  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && !pending && close()}
      title={t('有 {n} 个任务被强制更新打断', { n: tasks.length })}
      footer={
        <>
          <Button variant="secondary" disabled={pending} onClick={close}>
            {t('稍后再说')}
          </Button>
          <Button disabled={pending || !selected.length} onClick={() => void resume()}>
            {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t('继续执行选中的任务（{n}）', { n: selected.length })}
          </Button>
        </>
      }
    >
      <p className="text-body leading-relaxed text-muted">
        {t('强制更新停掉了这些任务正在做的事。勾选的任务会接着往下执行，没勾选的不处理。')}
      </p>
      <div className="flex flex-col gap-4">
        {groups.map((g) => {
          const on = g.items.filter((x) => checked[x.id]).length
          return (
            <section key={g.key} className="flex flex-col gap-2" data-resume-group={g.key}>
              <div className="flex items-center gap-2 px-1">
                <Checkbox
                  checked={on === g.items.length}
                  onChange={(v) => setAll(g.items, v)}
                  ariaLabel={t('整组勾选：{name}', { name: g.name || g.mode })}
                />
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted">
                  {g.mode}
                  {g.name && <span className="text-fg"> · {g.name}</span>}
                </span>
                <span className="shrink-0 text-xs text-subtle">{t('{on}/{n} 个', { on, n: g.items.length })}</span>
              </div>
              <ul className="flex flex-col gap-2">
                {g.items.map((x) => (
                  <li key={x.id} className="rounded-lg bg-field px-3 py-2.5">
                    <div className="flex items-start gap-2.5">
                      <Checkbox
                        checked={!!checked[x.id]}
                        onChange={(v) => setChecked((c) => ({ ...c, [x.id]: v }))}
                        label={<span className="font-medium">{x.title}</span>}
                        hint={x.doing ? t('被打断时：{doing}', { doing: x.doing }) : undefined}
                        className="min-w-0 flex-1"
                      />
                      <Button variant="link" tone="muted" onClick={() => openTask(x)} className="shrink-0 text-xs">
                        {t('打开')}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )
        })}
      </div>
    </Modal>
  )
}
