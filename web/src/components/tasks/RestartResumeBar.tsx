import { useEffect, useState } from 'react'
import { ChevronRight, Loader2, RotateCcw, X } from 'lucide-react'
import type { InterruptedTask } from '@shared/version'
import { api } from '@/lib/api'
import { useData, useNav } from '@/lib/data'
import { toast } from '@/lib/toast'
import { t } from '@shared/i18n'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'

type Row = InterruptedTask & { error?: string }

/**
 * 首页的一条提示：上次面板退出 / 重启时有对话在运行，问要不要全部继续（实测报告问题 18）。
 * 以前重启后所有对话都停在「面板重启时中断」，只能一个个打开点「继续」。
 * 不做成自动继续：继续会花钱、会接着改项目，要用户点一下。
 * 名单只有顶层对话（见 shared/resume-kids.ts 的 restartResumable）：子对话由父对话继续时连带拉起，
 * 用户停掉的、已交付的子对话那边会跳过。没能继续的留在列表里写明原因，不悄悄吞掉
 */
export function RestartResumeBar() {
  const { projects, upsertTask } = useData()
  const { go } = useNav()
  const [rows, setRows] = useState<Row[]>([])
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    let live = true
    api
      .appRestartInterrupted()
      .then((r) => live && setRows(r.tasks))
      // 读不到名单只是少一条提示，对话本身还在列表里，不弹错
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])

  if (!rows.length) return null
  const projectName = (x: InterruptedTask) =>
    x.projectId ? (projects.find((p) => p.id === x.projectId)?.name ?? x.projectName) : t('Chat')

  /** 关掉提示：这次重启不再提示，对话照旧停着，用户自己看 */
  const dismiss = () => {
    setRows([])
    void api.appRestartInterruptedAck().catch(() => {})
  }

  const resumeAll = async () => {
    if (pending) return
    setPending(true)
    const left: Row[] = []
    let ok = 0
    // 一个个来：每个父对话继续时还要连带拉起它的子对话，并发起一堆 CLI 容易撞上保活上限
    for (const x of rows) {
      try {
        upsertTask(await api.resumeTask(x.id))
        ok++
      } catch (e) {
        left.push({ ...x, error: e instanceof Error ? e.message : String(e) })
      }
    }
    setPending(false)
    setRows(left)
    if (left.length) setOpen(true)
    else void api.appRestartInterruptedAck().catch(() => {})
    if (ok) toast.success(t('已继续 {n} 个对话', { n: ok }))
  }

  const openTask = (x: InterruptedTask) =>
    go(x.projectId ? { page: 'projects', id: x.projectId, sub: x.id } : { page: 'chat', id: x.id })

  return (
    <section data-surface="" aria-label={t('被面板重启打断的对话')} className="rounded-xl bg-field px-4 py-3">
      <div className="flex items-center gap-3">
        <RotateCcw className="h-4 w-4 shrink-0 text-muted" />
        <p className="min-w-0 flex-1 text-body text-fg">
          {t('上次面板关闭时有 {n} 个对话在运行，已经中断', { n: rows.length })}
        </p>
        <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? t('收起') : t('逐个看')}
        </Button>
        <Button size="sm" disabled={pending} onClick={() => void resumeAll()}>
          {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {t('全部继续')}
        </Button>
        <IconButton icon={X} size="sm" label={t('不用了')} disabled={pending} onClick={dismiss} />
      </div>
      {open && (
        <ul className="mt-2 flex flex-col">
          {rows.map((x) => (
            <li key={x.id}>
              <button
                type="button"
                onClick={() => openTask(x)}
                className="group flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-hover"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body text-fg">{x.title}</span>
                  {x.error ? (
                    <span className="block truncate text-footnote text-danger" title={x.error}>
                      {t('没能继续：{error}', { error: x.error })}
                    </span>
                  ) : (
                    <span className="block truncate text-footnote text-subtle">
                      {[projectName(x), x.doing && t('被打断时：{doing}', { doing: x.doing })]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  )}
                </span>
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-subtle group-hover:text-fg" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
