import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { Task, TaskJob, ToolUse } from '@shared/schema'
import { useNow } from '@/lib/useNow'
import { RowShell, ToolRow } from './ToolRow'
import { useChildList, useChildOpen } from './child-open'
import { t } from '@shared/i18n'

/** 这一轮里还在跑的工具：回复说完了它们还在跑，要拿出来放在总结上面，不能跟着过程一起折叠 */
export const runningTools = (msgs: { role: string; tools: ToolUse[] }[]) =>
  msgs.flatMap((m) => (m.role === 'agent' ? m.tools.filter((x) => x.running) : []))

const spin = <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" />

/**
 * 子对话这一行右边显示的时长：还在干活就走到现在（每秒刷新）；
 * 停在等你（待确认的请求、没回答的提问）时停在最后一次有变化的时刻，不会一直往上涨
 */
function childMs(
  k: { working?: boolean; requests?: number; asking?: number; startedAt?: string; updatedAt?: string },
  now: number,
) {
  const start = k.startedAt ? Date.parse(k.startedAt) : 0
  // 没有开始时间（旧数据、演示数据）就不显示，别从 1970 算起
  if (!start) return undefined
  const waiting = !k.working || !!k.requests || !!k.asking
  const end = waiting && k.updatedAt ? Date.parse(k.updatedAt) : now
  return Math.max(0, (Number.isFinite(end) ? end : now) - start)
}

function JobRow({ job, now }: { job: TaskJob; now: number }) {
  const [open, setOpen] = useState(false)
  const started = job.startedAt ? Date.parse(job.startedAt) : 0
  return (
    <RowShell
      glyph={spin}
      verb={t('后台命令')}
      title={job.name}
      detail={job.state === 'queued' && <span className="shrink-0 font-sans text-subtle">{t('排队中')}</span>}
      ms={started ? now - started : undefined}
      open={open}
      onToggle={() => setOpen(!open)}
    >
      <pre className="border-t bg-card/60 px-3.5 py-2.5 font-mono text-[0.75rem] leading-[1.65] whitespace-pre-wrap text-fg/90 [overflow-wrap:anywhere]">
        {job.command}
      </pre>
    </RowShell>
  )
}

/**
 * 还在运行的东西统一放在一段回复的总结上面：没收尾的工具调用、后台命令、还在干活的子对话。
 * 不收进过程的折叠，一直转圈，跑完就从这里消失；命令的结果推回来后 AI 会接着处理、重新总结，
 * 新的一段回复上面再按那时的情况列一遍。什么都没在跑时不占位置
 */
export function RunningNow({
  task,
  tools,
  background,
  indent,
}: {
  task?: Task
  /** 这一段里还没收尾的工具调用；回复还在流式输出时它们就在过程里转圈，不用再列一遍 */
  tools: ToolUse[]
  /** 列出对话的后台命令和子对话：只在对话最新的一轮上列，旧的几轮不重复 */
  background: boolean
  /** 不在折叠开关下面、单独成行时，和工具调用一样缩进在头像后面 */
  indent?: boolean
}) {
  const children = useChildList()
  const openChild = useChildOpen()
  const jobs = background ? (task?.jobs ?? []) : []
  // 子对话在后台干活：看 working（CLI 正在处理一轮），进程只是活着、等下一句时不算
  const kids = background && task ? children.filter((x) => x.working && !x.resolved) : []
  const now = useNow(jobs.length > 0 || kids.length > 0)
  if (!tools.length && !jobs.length && !kids.length) return null
  const list = (
    <div className="flex flex-col gap-1" aria-label={t('运行中')}>
      {tools.map((x, i) => (
        <ToolRow key={`t${i}`} tool={x} task={task} />
      ))}
      {jobs.map((j) => (
        <JobRow key={j.id} job={j} now={now} />
      ))}
      {kids.map((k) => (
        <RowShell
          key={k.id}
          glyph={spin}
          verb={t('子对话')}
          title={k.title || t('未命名')}
          ms={childMs(k, now)}
          open={false}
          onOpen={openChild ? () => openChild(k.id) : undefined}
          openTip={t('在右侧打开子对话')}
        />
      ))}
    </div>
  )
  if (!indent) return list
  return (
    <div className="flex gap-3">
      <span className="w-[26px] shrink-0" />
      <div className="min-w-0 flex-1">{list}</div>
    </div>
  )
}
