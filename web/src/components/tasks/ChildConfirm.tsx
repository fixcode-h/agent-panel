import { useState } from 'react'
import { ClipboardCheck, Loader2 } from 'lucide-react'
import type { Task, TaskRequest } from '@shared/schema'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { toastError } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { ReviewDialog } from './ReviewDialog'

/**
 * 子对话的工作流节点做完、等你确认这一步结果时，父对话页上的入口：和诊断报告的「查看报告」一样
 * 放在子对话那一行的行尾，点了取子对话的完整请求（/children 里的说明截短过）直接打开审阅弹窗，
 * 确认或退回都在父对话页上做完，不用先进子对话。以前是输入框上方单独一条黄色确认条（用户要求去掉）
 */
export function ChildConfirmButton({ childId, className }: { childId: string; className?: string }) {
  const { agents } = useData()
  const [hit, setHit] = useState<{ task: Task; req: TaskRequest } | null>(null)
  const [busy, setBusy] = useState(false)
  const open = async () => {
    setBusy(true)
    try {
      const task = await api.task(childId)
      const req = task.requests?.find((r) => r.kind === 'confirm')
      // 取到时已经被别处确认掉了（子对话页、另一个窗口）：说清楚，不打开一个空弹窗
      if (!req) throw new Error(t('这一步已经确认过了'))
      setHit({ task, req })
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(false)
    }
  }
  const a = hit && agents.find((x) => x.id === hit.req.agentId)
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
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <ClipboardCheck className="h-3 w-3" />}
        {t('查看结果')}
      </Button>
      {hit && (
        <ReviewDialog
          req={hit.req}
          agent={a ? { name: a.name, icon: a.icon, cli: a.cli } : undefined}
          open
          onOpenChange={(o) => !o && setHit(null)}
          // 出错时抛出：弹窗留着并提示错误，标注不会白写（见 ReviewDialog）
          onAnswer={async (allow, answer) => {
            await api.answerRequest(hit.task.id, hit.req.id, { allow, answer })
          }}
        />
      )}
    </>
  )
}
