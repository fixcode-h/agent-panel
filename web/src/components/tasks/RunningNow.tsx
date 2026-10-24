import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { Task, TaskJob, ToolUse } from '@shared/schema'
import { visibleChildren, splitStepJobs } from '@shared/task'
import { cn } from '@/lib/utils'
import { useNow } from '@/lib/useNow'
import { RowShell, ToolRow } from './ToolRow'
import { useChildList, useChildOpen } from './child-open'
import { childLabelClass, childLabels, childNote, staleLine } from './child-line'
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
      detail={
        job.state === 'queued' ? <span className="shrink-0 font-sans text-subtle">{t('排队中')}</span> : undefined
      }
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
 * 子任务起的后台命令：一个子任务只占一行（行首「子任务」、标题是它的名字），后面写命令名或「n 条后台命令」，
 * 展开看每条命令。计时从最早开始的那条算，和父对话的后台命令同一个口径
 */
function StepJobsRow({ title, jobs, now }: { title: string; jobs: TaskJob[]; now: number }) {
  const [open, setOpen] = useState(false)
  const starts = jobs.map((j) => (j.startedAt ? Date.parse(j.startedAt) : 0)).filter((x) => x > 0)
  const started = starts.length ? Math.min(...starts) : 0
  const queued = jobs.every((j) => j.state === 'queued')
  const names = jobs.map((j) => j.name).join(t('、'))
  return (
    <RowShell
      glyph={spin}
      verb={t('子任务')}
      title={title}
      detail={
        <span className="flex min-w-0 max-w-[58%] shrink items-center gap-1.5 overflow-hidden">
          <span className="min-w-0 truncate font-mono" title={names}>
            {jobs.length === 1 ? jobs[0].name : t('{n} 条后台命令', { n: jobs.length })}
          </span>
          {queued && <span className="shrink-0 font-sans text-subtle">{t('排队中')}</span>}
        </span>
      }
      ms={started ? now - started : undefined}
      open={open}
      onToggle={() => setOpen(!open)}
    >
      <div className="flex flex-col divide-y border-t bg-card/60">
        {jobs.map((j) => (
          <div key={j.id} className="px-3.5 py-2.5">
            <p className="mb-1 flex items-center gap-1.5 text-xs text-subtle">
              <span className="truncate font-mono">{j.name}</span>
              {j.state === 'queued' && <span className="shrink-0">{t('排队中')}</span>}
            </p>
            <pre className="font-mono text-[0.75rem] leading-[1.65] whitespace-pre-wrap text-fg/90 [overflow-wrap:anywhere]">
              {j.command}
            </pre>
          </div>
        ))}
      </div>
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
  jobs,
  kids,
  indent,
}: {
  task?: Task
  /** 这一段里还没收尾的工具调用；回复还在流式输出时它们就在过程里转圈，不用再列一遍 */
  tools: ToolUse[]
  /** 列出对话的后台命令：只在对话最新的一轮上列，旧的几轮不重复 */
  jobs: boolean
  /**
   * 列出子对话：读的是和悬浮层「运行中」、状态栏计数同一批（见 shared/task.ts 的 visibleChildren），
   * 所以两处条目数、顺序、状态标签一致；不再自己写 `working && !resolved`
   */
  kids: boolean
  /** 不在折叠开关下面、单独成行时，和工具调用一样缩进在头像后面 */
  indent?: boolean
}) {
  const children = useChildList()
  const openChild = useChildOpen()
  const list = jobs ? (task?.jobs ?? []) : []
  // 后台命令按来源分两批：子任务（slot='sub' 的步骤）起的单独列，父对话自己起的照旧；判定只有 splitStepJobs 一处
  const { sub: stepJobs, own: ownJobs } = splitStepJobs(task?.steps ?? [], list)
  // 已标记解决但还在跑、在等后台命令、计划没做完的子对话都要列（见 visibleChildren），
  // 以前这里只认 working 且没标解决，弹层里有、运行区没有，同一个页面对不上数
  const rows = kids ? visibleChildren(children) : []
  const now = useNow(ownJobs.length > 0 || stepJobs.length > 0 || rows.length > 0)
  if (!tools.length && !ownJobs.length && !stepJobs.length && !rows.length) return null
  const box = (
    <div className="flex flex-col gap-1" aria-label={t('运行中')}>
      {tools.map((x, i) => (
        <ToolRow key={`t${i}`} tool={x} task={task} />
      ))}
      {stepJobs.map(({ step, jobs }) => (
        <StepJobsRow key={step.id} title={step.title || t('未命名')} jobs={jobs} now={now} />
      ))}
      {ownJobs.map((j) => (
        <JobRow key={j.id} job={j} now={now} />
      ))}
      {rows.map((k) => {
        // 行上的状态标签、当前活动、多久没新输出都和悬浮层那一行读同一份（见 ./child-line）：
        // 标题、状态、计划进度、正在做什么两处显示一致。
        // 这段详情按弹层里的观感跟在标题后面左对齐（detailStart），不再贴到行尾
        const labels = childLabels(k)
        const note = childNote(k, true)
        const stale = staleLine(k)
        return (
          <RowShell
            key={k.id}
            glyph={<Loader2 className={cn('h-3.5 w-3.5 shrink-0 animate-spin', stale?.cls ?? 'text-accent')} />}
            // 窄屏不写动作名：把宽度留给标题、状态标签和耗时，否则「计划 1/2」后面的「执行中」会被裁掉。
            // 用 sr-only 不用 hidden：不占宽度，读屏仍能读到这行是子对话
            verb={<span className="sr-only md:not-sr-only">{t('子对话')}</span>}
            title={k.title || t('未命名')}
            open={false}
            onOpen={openChild ? () => openChild(k.id) : undefined}
            // 标题被前宽截断时，悬停能看全文（活动文字本来就有 title）
            openTip={t('在右侧打开子对话「{title}」', { title: k.title || t('未命名') })}
            detailStart
            detail={
              <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
                {labels.map((l, i) => (
                  // 超窄屏（<359px）只留第一个状态标签：两个并排会被 overflow-hidden 裁掉，
                  // 读起来像「等结 0.1s」；这时活动文字也已隐藏，只保留最要紧的那个状态
                  <span key={l.text} className={cn(childLabelClass[l.tone], i > 0 && 'max-[359px]:hidden')}>
                    {l.text}
                  </span>
                ))}
                {/* 窄屏下行的宽度留给状态标签和耗时：活动文字是补充信息，md 以上再显示，
                    不让标签被 overflow-hidden 裁成「计划 1」 */}
                {(note || stale) && (
                  <span
                    className={cn('hidden min-w-0 truncate font-sans md:block', stale ? stale.cls : 'text-subtle')}
                    title={[note, stale?.text].filter(Boolean).join(' · ')}
                  >
                    {stale ? stale.text : note}
                  </span>
                )}
              </span>
            }
            ms={childMs(k, now)}
          />
        )
      })}
    </div>
  )
  if (!indent) return box
  return (
    <div className="flex gap-3">
      <span className="w-[26px] shrink-0" />
      <div className="min-w-0 flex-1">{box}</div>
    </div>
  )
}
