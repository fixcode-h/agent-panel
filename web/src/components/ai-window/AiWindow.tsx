import { useEffect, useState } from 'react'

import { CircleAlert, ExternalLink, MessageSquareOff, Minimize2, Sparkles, X } from 'lucide-react'
import { t } from '@shared/i18n'
import { fmtDuration } from '@shared/duration'
import {
  aiWindowRunning,
  analysisRoute,
  closeAiWindow,
  hideAiWindow,
  minimizeAiWindow,
  useAiWindow,
} from '@/lib/ai-window'
import { timingMs } from '@/lib/analysis-report'
import { useData, useNav } from '@/lib/data'
import { cn } from '@/lib/utils'
import { IconButton } from '@/components/ui/icon-button'
import { Modal } from '@/components/ui/modal'
import { Spinner, StatusPill, type StatusTone } from '@/components/ui/status-pill'
import { MinimizedChat, type ChatDockState } from '@/components/ui/minimized-chat'
import { TaskView } from '@/components/tasks/TaskView'

/**
 * 统一的 AI 分析窗口：「AI 处理」报错、「AI 分析执行结果」、子任务分析、内存分析都在这里看，
 * 里面就是那个分析对话（可以接着问）。对话本身按归属规则开在项目里、子对话所属的顶层对话下或 Chat 里
 * （见 shared/analysis-home.ts），「去对话里看」跳到它所在的地方。
 * 最小化后收成右下角的浮条（和「AI 优化」共用同一个组件），分析照常进行。
 * 关闭（浮条和标题栏的 ✕）只收窗口，同样不停分析：对话留在列表里、后台跑完会提醒，
 * 想停分析就去对话里的输入框点停止（窗口里嵌的就是那个对话）。
 * 窗口和对话是两回事：对话被删掉时窗口不自动消失，标成「对话已关闭」等用户自己关。
 */
export function AiWindow() {
  const s = useAiWindow()
  const { open, minimized, gone, job, taskId, status, starting, error, timing } = s
  // 标题栏留给嵌入对话的状态和操作按钮的位置：对话自己的页签行不再画，免得和窗口标题重复
  const [slot, setSlot] = useState<HTMLSpanElement | null>(null)
  const { go } = useNav()
  const { projects, tasks } = useData()
  // 项目里的分析对话要带上项目：分析结果里「开子对话去修」这类操作要知道项目
  const project = projects.find((p) => p.id === s.projectId)
  // 标题栏的「来源」只用列表里已有的数据：分析对话本身（看是不是排查）、它所属的父对话；
  // 子对话不在顶层列表里时就找不到，那时只是少显示一项，不另发请求
  const entry = taskId ? tasks.find((x) => x.id === taskId) : undefined
  const parent = s.parentTaskId ? tasks.find((x) => x.id === s.parentTaskId) : undefined
  // 最小化期间分析结束了：浮条上点一个红点，提醒去看结果
  const [unseen, setUnseen] = useState(false)
  const running = aiWindowRunning()
  useEffect(() => {
    if (!minimized || running || gone || !status) return
    setUnseen(true)
  }, [minimized, running, gone, status])
  useEffect(() => {
    if (!open) setUnseen(false)
  }, [open])
  // 分析中每秒跳一次用时；结束后用记下的起止，不再跳
  const [now, setNow] = useState(() => Date.now())
  const live = !!timing?.since && running && open && !minimized
  useEffect(() => {
    if (!live) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [live])
  if (!job) return null
  const heading = t('{label}：{title}', { label: job.label, title: job.title })
  // 到对话里看：窗口收起，分析照常进行，结束时会提醒
  const openInPlace = () => {
    const r = analysisRoute(s)
    if (!r) return
    hideAiWindow()
    go(r)
  }
  const where = s.parentTaskId ? t('在父对话里打开') : s.projectId ? t('在项目对话里打开') : t('在聊天里打开')
  // 看浮条上的状态：两个窗口共用同一套文字
  const dockState: ChatDockState = gone
    ? 'gone'
    : running
      ? 'running'
      : status === 'done'
        ? 'done'
        : status
          ? 'ended'
          : 'idle'
  // 标题栏右侧的状态胶囊：和浮条同一个口径（dockState），没有可显示的状态就不画。
  // 后面跟这一轮分析的实际用时（轮次的起止，见 analysisTiming）；拿不到准确起止时不显示，不拿创建时间凑
  const pill: { tone: StatusTone; text: string } | undefined = starting
    ? { tone: 'run', text: t('正在新建分析对话…') }
    : error && !taskId
      ? { tone: 'err', text: t('没有开始') }
      : dockState === 'running'
        ? { tone: 'run', text: t('分析中') }
        : dockState === 'done'
          ? { tone: 'ok', text: t('分析完成') }
          : dockState === 'gone'
            ? { tone: 'idle', text: t('对话已关闭') }
            : dockState === 'ended'
              ? status === 'failed'
                ? { tone: 'err', text: t('分析失败') }
                : { tone: 'idle', text: t('已结束') }
              : undefined
  const took =
    timing && taskId && !gone && (dockState === 'running' || dockState === 'done' || dockState === 'ended')
      ? fmtDuration(timingMs(timing, now))
      : ''
  // 来源标签：排查（报错交给 AI）用红色，和设计稿「测试失败」那种一致；别的分析用中性底色
  const fromIssue = entry?.analysis === 'fix'
  const from = [project?.name, parent?.title].filter(Boolean).join(' · ')
  const actions = (
    <>
      {taskId && !gone && (
        <IconButton
          icon={ExternalLink}
          size="sm"
          label={where}
          title={t('{where}（分析照常进行）', { where })}
          onClick={openInPlace}
        />
      )}
      <IconButton
        icon={Minimize2}
        size="sm"
        label={t('最小化')}
        title={t('最小化（分析照常进行）')}
        onClick={() => minimizeAiWindow(true)}
      />
      <IconButton
        icon={X}
        size="sm"
        label={t('关闭')}
        title={running ? t('关闭窗口（分析继续在后台进行）') : t('关闭窗口')}
        onClick={() => closeAiWindow()}
      />
    </>
  )
  return (
    <>
      {open && minimized && (
        <MinimizedChat
          id="ai-fix"
          label={heading}
          state={dockState}
          unseen={unseen}
          onExpand={() => {
            minimizeAiWindow(false)
            setUnseen(false)
          }}
          onClose={() => closeAiWindow()}
        />
      )}
      <Modal
        open={open && !minimized}
        title={heading}
        size="full"
        bare
        closeOnOutside
        // 嵌的是整个对话页，底色跟页面一样用 bg；高度到 960 为止，大屏上不显得空
        className="max-h-[min(960px,calc(100dvh-2rem))] bg-bg"
        // 按 Esc 或点窗口外面：分析中先收起来（浮条还在、状态还看得到）；没在分析就关窗口。
        // 两种都不停分析：关闭只是收窗口，分析继续在后台跑
        onOpenChange={(o) => {
          if (o) return
          if (running) minimizeAiWindow(true)
          else closeAiWindow()
        }}
      >
        {/* 窗口自己的标题栏（照设计稿 AiWindow）：哪种分析、分析的对象、来自哪里、现在的状态，
                最小化和关闭也放这里；下面嵌的对话只留它自己的对话操作 */}
        <header className="flex h-[3.25rem] shrink-0 items-center gap-2.5 border-b pr-3 pl-4">
          <span className="grid h-[1.625rem] w-[1.625rem] shrink-0 place-items-center rounded-lg bg-fg text-bg">
            <Sparkles className="h-3.5 w-3.5" />
          </span>
          <span className="shrink-0 text-[0.9375rem] font-semibold">{job.label}</span>
          <span
            title={job.title}
            className={cn(
              'inline-flex h-6 max-w-[45%] min-w-0 shrink items-center rounded-md px-2.5 text-[0.75rem] font-medium',
              fromIssue ? 'bg-danger/10 text-danger' : 'bg-sel text-muted',
            )}
          >
            <span className="truncate">{job.title}</span>
          </span>
          {from && (
            <span className="hidden min-w-0 truncate text-[0.75rem] text-subtle md:inline">
              {t('来自 {name}', { name: from })}
            </span>
          )}
          <span className="flex-1" />
          {pill && (
            <StatusPill tone={pill.tone} spin={pill.tone === 'run'} className="h-6 px-2.5">
              {pill.text}
              {took && <span className="tabular-nums">· {took}</span>}
            </StatusPill>
          )}
          {/* 嵌入对话的状态和操作（进程、轮次、功能面板开关…）挂在这里，见 TaskView 的 embed.slot */}
          <span ref={setSlot} className="flex shrink-0 items-center gap-0.5 empty:hidden" />
          <div className="flex shrink-0 items-center gap-0.5">{actions}</div>
        </header>
        {taskId && !gone ? (
          // 等标题栏的位置挂好再画对话：不然第一帧会先画出对话自己的页签行再收掉
          slot && (
            <TaskView
              key={taskId}
              taskId={taskId}
              project={project}
              embed={{ actions: null, onLeave: hideAiWindow, slot }}
            />
          )
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="grid flex-1 place-items-center p-6">
              {gone ? (
                <div className="max-w-md rounded-xl bg-field px-6 py-8 text-center">
                  <span className="mx-auto grid h-9 w-9 place-items-center rounded-full bg-sel text-subtle">
                    <MessageSquareOff className="h-4 w-4" />
                  </span>
                  <p className="mt-3 text-[0.875rem] font-medium">{t('这个对话已经关闭了')}</p>
                  <p className="mt-1.5 text-[0.8125rem] leading-relaxed text-muted">
                    {t('它已经从对话列表里删掉，窗口不会跟着关。点右上角关闭才会收起这个窗口。')}
                  </p>
                </div>
              ) : starting ? (
                <p className="flex items-center gap-2 text-[0.8125rem] text-muted">
                  <Spinner className="h-3.5 w-3.5 text-run" />
                  {t('正在新建分析对话…')}
                </p>
              ) : (
                error && (
                  <p className="flex max-w-lg items-start gap-2 text-[0.8125rem] leading-relaxed whitespace-pre-wrap text-danger">
                    <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                    {error}
                  </p>
                )
              )}
            </div>
          </div>
        )}
      </Modal>
    </>
  )
}
