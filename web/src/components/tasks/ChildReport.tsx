import { useEffect, useRef, useState } from 'react'
import { FileSearch, Loader2 } from 'lucide-react'
import type { Task } from '@shared/schema'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { toastError } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { DiagnosisDialog } from './DiagnosisDialog'

/**
 * 诊断报告在父对话页上的入口（ADR 0045）：以前「查看报告」只放在子对话里交报告的那一行工具调用上，
 * 父对话页只写「等你查看诊断报告第 N 版」、点不开，用户要先进子对话再找那一行（用户报过找不到入口）。
 * 这里给父对话页的子对话行、「正在运行」面板一个按钮，点了取子对话的报告直接打开审阅弹窗；
 * 报告交上来时也自动弹一次（每一版只弹一次，关掉后不再弹，记在浏览器里）
 */

/** 这一版有没有自动弹过：子对话页和父对话页共用一个记号，同一版不会两边各弹一次 */
const KEY = (id: string, version: number, tag: string) => `diagnosis-shown:${id}:${version}${tag ? `:${tag}` : ''}`
/** 标记这一版已经弹过；返回 true 表示是第一次（该弹） */
export function firstShow(id: string, version: number, tag = ''): boolean {
  try {
    if (localStorage.getItem(KEY(id, version, tag))) return false
    localStorage.setItem(KEY(id, version, tag), '1')
    return true
  } catch {
    // 浏览器不让存（隐私模式）：不自动弹，入口按钮照样能点
    return false
  }
}

/** 最新一版在等确认时的版本号；没有在等的返回 0 */
const pendingVersion = (task: Pick<Task, 'diagnoses'>) => {
  const last = task.diagnoses?.at(-1)
  return last?.status === 'pending' ? last.version : 0
}

/** 同一版回到等你（加好日志等你复现）也要再弹一次：记号带上这个 */
export const showTag = (task: Pick<Task, 'diagnoses'>) => (task.diagnoses?.at(-1)?.awaiting ? 'logs' : '')

/** 「查看报告」按钮：点了取子对话（要它的各版报告），取到就打开审阅弹窗 */
export function ChildReportButton({ childId, className }: { childId: string; className?: string }) {
  const [task, setTask] = useState<Task | null>(null)
  const [busy, setBusy] = useState(false)
  const open = async () => {
    setBusy(true)
    try {
      setTask(await api.task(childId))
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <Button
        size="sm"
        variant="primary"
        className={className ?? 'h-6 shrink-0 px-2 text-xs'}
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation()
          void open()
        }}
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <FileSearch className="h-3 w-3" />}
        {t('查看报告')}
      </Button>
      {task && <DiagnosisDialog task={task} open onOpenChange={(o) => !o && setTask(null)} />}
    </>
  )
}

/**
 * 父对话页上：在等你确认诊断报告的子对话，每一版报告交上来时自动打开一次审阅弹窗。
 * ids 是这一刻在等确认的子对话；一次只弹一个，关掉后看下一个
 */
export function DiagnosisAutoOpen({ ids }: { ids: string[] }) {
  const [task, setTask] = useState<Task | null>(null)
  const busy = useRef(false)
  const key = ids.join(',')
  useEffect(() => {
    if (task || busy.current || !ids.length) return
    busy.current = true
    void (async () => {
      for (const id of ids) {
        const k = await api.task(id).catch(() => null)
        const v = k ? pendingVersion(k) : 0
        if (k && v && firstShow(id, v, showTag(k))) {
          setTask(k)
          break
        }
      }
      busy.current = false
    })()
    // 只在这批在等确认的子对话变了时再查一遍：task 关掉（变回 null）后也要接着查下一个
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [key, task])
  return task ? <DiagnosisDialog task={task} open onOpenChange={(o) => !o && setTask(null)} /> : null
}
