import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Clock, Loader2 } from 'lucide-react'
import { t } from '@shared/i18n'
import type { ComfyQueueEntry } from '@shared/local-image'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { ComfyGraphView } from './ComfyGraphView'

/** 只读展示：节点图组件要求一个改图的回调，这里不让改。放模块级，免得每次渲染换函数把节点图重建一遍 */
const NO_CHANGE = () => {}

/** 队列每 2 秒取一次：ComfyUI 的进度只在执行时变，太快没必要 */
function useComfyQueue() {
  const [q, setQ] = useState<Awaited<ReturnType<typeof api.localImageQueue>>>()
  useEffect(() => {
    let alive = true
    const load = () =>
      api
        .localImageQueue()
        .then((s) => alive && setQ(s))
        .catch(() => {})
    void load()
    const timer = setInterval(load, 2000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])
  return q
}

function Item({ item, index }: { item: ComfyQueueEntry; index?: number }) {
  const [open, setOpen] = useState(false)
  const pct =
    item.progress && item.progress.max > 0
      ? Math.min(100, Math.round((item.progress.value / item.progress.max) * 100))
      : undefined
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-2 text-[0.8125rem]">
        {item.status === 'running' ? (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
        ) : (
          <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-sel font-mono text-[0.625rem] text-subtle">
            {index}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate" title={item.workflowName}>
          {item.workflowName || t('未命名工作流')}
        </span>
        {item.source && (
          <span className="shrink-0 rounded bg-sel px-1.5 py-0.5 text-[0.6875rem] text-muted">
            {item.source === 'design' ? t('AI 设计') : t('面板')}
          </span>
        )}
        {pct !== undefined && (
          <span className="w-9 shrink-0 text-right font-mono text-[0.71875rem] tabular-nums text-muted">{pct}%</span>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          title={t('查看节点图')}
          className="h-6 gap-0.5 px-1.5 text-[0.71875rem] font-normal text-subtle"
        >
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          {t('节点图')}
        </Button>
      </div>
      {item.status === 'running' && (
        <Progress label={t('生成进度')} value={pct ?? 0} indeterminate={pct === undefined} />
      )}
      {open && (
        <div className="max-h-[45vh] overflow-y-auto">
          <ComfyGraphView graph={item.prompt} readOnly onChange={NO_CHANGE} />
        </div>
      )}
    </div>
  )
}

/**
 * ComfyUI 里正在跑和排队的工作流：读 ComfyUI 自己的队列，进度来自面板保持的 WebSocket。
 * AI 设计提交的任务带来源信息，能直接看出是哪个工作流；没启动或队列空的时候不占地方
 */
export function ComfyQueuePanel({ compact = false, className }: { compact?: boolean; className?: string }) {
  const q = useComfyQueue()
  if (!q?.up) return null
  const { running, pending } = q
  if (!running.length && !pending.length) return null
  return (
    <section
      aria-label={t('ComfyUI 正在运行的工作流')}
      className={cn('flex flex-col gap-2', compact ? 'py-2' : 'rounded-xl bg-card p-3 shadow-card', className)}
    >
      <div className="flex min-w-0 items-center gap-1.5 text-[0.75rem] font-medium text-muted">
        {running.length ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" />
        ) : (
          <Clock className="h-3.5 w-3.5 shrink-0" />
        )}
        <span>{running.length ? t('正在生成') : t('排队中')}</span>
        <span className="font-normal text-subtle">
          {t('{n} 个任务', { n: String(running.length + pending.length) })}
        </span>
        {!compact && <span className="min-w-0 flex-1" />}
        {!compact && <span className="truncate font-mono text-[0.6875rem] text-subtle">{q.url}</span>}
      </div>
      {running.map((x) => (
        <Item key={x.id} item={x} />
      ))}
      {pending.map((x, i) => (
        <Item key={x.id} item={x} index={i + 1} />
      ))}
    </section>
  )
}
