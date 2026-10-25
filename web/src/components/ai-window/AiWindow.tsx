import { useEffect, useState } from 'react'
import * as D from '@radix-ui/react-dialog'
import { CircleAlert, ExternalLink, Loader2, MessageSquareOff, Minus, Sparkles, X } from 'lucide-react'
import { t } from '@shared/i18n'
import {
  aiWindowRunning,
  analysisRoute,
  closeAiWindow,
  hideAiWindow,
  minimizeAiWindow,
  useAiWindow,
} from '@/lib/ai-window'
import { useData, useNav } from '@/lib/data'
import { Button } from '@/components/ui/button'
import { MinimizedChat, type ChatDockState } from '@/components/ui/minimized-chat'
import { TaskView } from '@/components/tasks/TaskView'

/**
 * 统一的 AI 分析窗口：「AI 处理」报错、「AI 分析执行结果」、子任务分析、内存分析都在这里看，
 * 里面就是那个分析对话（可以接着问）。对话本身按归属规则开在父对话下、项目里或 Chat 里（见 shared/analysis-home.ts），
 * 「去对话里看」跳到它所在的地方。
 * 最小化后收成右下角的浮条（和「AI 优化」共用同一个组件），分析照常进行；关闭是直接关掉并停止，不再先弹确认。
 * 窗口和对话是两回事：对话被删掉时窗口不自动消失，标成「对话已关闭」等用户自己关。
 */
export function AiWindow() {
  const s = useAiWindow()
  const { open, minimized, gone, job, taskId, status, starting, error } = s
  const { go } = useNav()
  const { projects } = useData()
  // 项目里的分析对话要带上项目：分析结果里「开子对话去修」这类操作要知道项目
  const project = projects.find((p) => p.id === s.projectId)
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
  const actions = (
    <>
      {taskId && !gone && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={where}
          title={t('{where}（分析照常进行）', { where })}
          onClick={openInPlace}
        >
          <ExternalLink className="h-4 w-4" />
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t('最小化')}
        title={t('最小化（分析照常进行）')}
        onClick={() => minimizeAiWindow(true)}
      >
        <Minus className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t('关闭')}
        title={running ? t('关闭并停止分析') : t('关闭')}
        onClick={() => closeAiWindow()}
      >
        <X className="h-4 w-4" />
      </Button>
    </>
  )
  return (
    <>
      {open && minimized && (
        <MinimizedChat
          id="ai-fix"
          slot={0}
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
      <D.Root
        open={open && !minimized}
        // 按 Esc 或点窗口外面：分析中先收起来，免得误触停止；没在分析就直接关
        onOpenChange={(o) => {
          if (o) return
          if (running) minimizeAiWindow(true)
          else closeAiWindow()
        }}
      >
        <D.Portal>
          <D.Overlay className="fixed inset-0 z-40 bg-black/50 animate-[fade-in_150ms_ease-out]" />
          <D.Content
            aria-describedby={undefined}
            className="fixed inset-2 z-50 m-auto flex max-h-[960px] max-w-[1100px] flex-col overflow-hidden rounded-2xl border border-line-strong bg-bg shadow-2xl animate-[pop-in_160ms_ease-out] focus:outline-none md:inset-6"
          >
            <D.Title className="sr-only">{heading}</D.Title>
            {taskId && !gone ? (
              <TaskView key={taskId} taskId={taskId} project={project} embed={{ actions, onLeave: hideAiWindow }} />
            ) : (
              <div className="flex min-h-0 flex-1 flex-col">
                <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3 md:px-5">
                  <Sparkles className="h-4 w-4 text-accent" />
                  <span className="min-w-0 flex-1 truncate text-[0.84375rem] font-medium">{heading}</span>
                  {actions}
                </header>
                <div className="grid flex-1 place-items-center p-6">
                  {gone ? (
                    <div className="max-w-md rounded-xl border border-dashed px-6 py-8 text-center">
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
                      <Loader2 className="h-4 w-4 animate-spin text-accent" />
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
          </D.Content>
        </D.Portal>
      </D.Root>
    </>
  )
}
