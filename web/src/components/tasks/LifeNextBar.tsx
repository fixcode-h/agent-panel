import { useEffect, useState } from 'react'
import { ArrowRight, Loader2, RotateCw } from 'lucide-react'
import type { LifeNode } from '@shared/lifecycle'
import { lifeNext, type LifeNext } from '@shared/life-next'
import type { Task } from '@shared/schema'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { RetryModelMenu } from './RetryModelMenu'

const TONE: Record<LifeNext['tone'], string> = {
  warning: 'border-warning/30 bg-warning/8 text-warning',
  accent: 'border-line bg-sel text-fg',
  danger: 'border-danger/30 bg-danger/8 text-danger',
  subtle: 'border-line bg-sel text-muted',
  success: 'border-success/30 bg-success/8 text-success',
}

/**
 * 「状态」窗口最上面那一句（分析稿 U11）：在等谁、等了多久，后面跟下一步的按钮。
 * 判定在 shared/life-next.ts（服务端已按 taskWord 填好短词和起始时间），这里只把按钮接到动作上：
 * 去回答 / 去确认 / 去回复回到那个对话；继续 / 重试接着原来的会话跑（和任务页的「继续执行」同一个接口）；
 * 换个模型重试复用任务页的 RetryModelMenu；查看在左边的树上选中它在等的子对话
 */
export function LifeNextBar({
  node,
  now,
  onGo,
  onPick,
}: {
  node: LifeNode
  now: number
  /** 回到这个对话（关掉窗口，子对话在右栏打开） */
  onGo?: (node: LifeNode) => void
  /** 在树上选中另一个节点 */
  onPick?: (id: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const next = lifeNext(node.facts, now)
  if (!next) return null
  const act = next.action
  const resume = async () => {
    setBusy(true)
    try {
      await api.resumeTask(node.taskId)
    } catch (e) {
      // 继续没发出去：原因照实显示，可以再点
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const click = () => {
    if (act?.kind === 'resume') void resume()
    else if (act?.kind === 'pick' && act.node) onPick?.(act.node)
    else if (act?.kind === 'go') onGo?.(node)
  }
  const shown = act && (act.kind === 'resume' || (act.kind === 'pick' ? !!onPick : !!onGo))
  return (
    <div
      data-life-next
      className={cn('flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-3 py-2', TONE[next.tone])}
    >
      <p className="min-w-0 flex-1 text-body font-medium" title={next.text}>
        {next.text}
      </p>
      {(shown || next.retryModel) && (
        <span className="flex shrink-0 items-center gap-1.5">
          {shown && (
            <Button
              size="sm"
              variant={act.kind === 'go' ? 'primary' : 'secondary'}
              className="h-7 rounded-lg"
              disabled={busy}
              onClick={click}
              data-life-next-action={act.kind}
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : act.kind === 'resume' ? (
                <RotateCw className="h-3.5 w-3.5" />
              ) : (
                <ArrowRight className="h-3.5 w-3.5" />
              )}
              {act.label}
            </Button>
          )}
          {next.retryModel && <RetryModel taskId={node.taskId} disabled={busy} />}
        </span>
      )}
    </div>
  )
}

/** 换个模型重试：菜单要完整任务（模型、角色），点开状态窗口时才取，只取一次 */
function RetryModel({ taskId, disabled }: { taskId: string; disabled: boolean }) {
  const { agents } = useData()
  const [task, setTask] = useState<Task | null>(null)
  useEffect(() => {
    let alive = true
    api.task(taskId, { limit: 1 }).then(
      (tk) => alive && setTask(tk),
      // 取不到就不出这个按钮：上面的「重试」照样能用，错误不吞，提示出来
      (e: Error) => alive && toast.error(e.message),
    )
    return () => {
      alive = false
    }
  }, [taskId])
  if (!task) return null
  return (
    <RetryModelMenu
      task={task}
      agent={agents.find((a) => a.id === task.agentId)}
      disabled={disabled}
      // 重发出去后窗口每 2 秒刷新，会跟上新的状态
      onDone={() => undefined}
    />
  )
}
