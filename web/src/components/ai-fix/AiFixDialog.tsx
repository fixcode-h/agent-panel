import { useEffect, useState } from 'react'
import * as D from '@radix-ui/react-dialog'
import { CircleAlert, ExternalLink, Loader2, MessageSquareOff, Minus, Sparkles, X } from 'lucide-react'
import { t } from '@shared/i18n'
import { aiFixRunning, closeAiFix, hideAiFix, minimizeAiFix, useAiFix } from '@/lib/ai-fix'
import { useNav } from '@/lib/data'
import { Button } from '@/components/ui/button'
import { MinimizedChat, type ChatDockState } from '@/components/ui/minimized-chat'
import { TaskView } from '@/components/tasks/TaskView'

/**
 * 「AI 处理」的对话弹窗：和 MCP 工具的 AI 排查一样是一个大窗口，里面就是聊天里的那个对话（可以接着问）。
 * 最小化后收成右下角的浮条（和「AI 优化」共用同一个组件），排查照常进行；
 * 关闭是直接关掉并停止排查，不再先弹确认。
 * 窗口和对话是两回事：对话被关掉时窗口不自动消失，标成「对话已关闭」等用户自己关。
 */
export function AiFixDialog() {
  const { open, minimized, gone, issue, taskId, status, starting, error } = useAiFix()
  const { go } = useNav()
  // 最小化期间排查结束了：浮条上点一个红点，提醒去看结果
  const [unseen, setUnseen] = useState(false)
  const running = aiFixRunning()
  useEffect(() => {
    if (!minimized || running || gone || !status) return
    setUnseen(true)
  }, [minimized, running, gone, status])
  useEffect(() => {
    if (!open) setUnseen(false)
  }, [open])
  if (!issue) return null
  // 到聊天里看：弹窗收起，排查照常进行，结束时会提醒
  const openInChat = () => {
    if (!taskId) return
    hideAiFix()
    go({ page: 'chat', id: taskId })
  }
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
          aria-label={t('在聊天里打开')}
          title={t('在聊天里打开（排查照常进行）')}
          onClick={openInChat}
        >
          <ExternalLink className="h-4 w-4" />
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t('最小化')}
        title={t('最小化（排查照常进行）')}
        onClick={() => minimizeAiFix(true)}
      >
        <Minus className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t('关闭')}
        title={running ? t('关闭并停止排查') : t('关闭')}
        onClick={() => closeAiFix()}
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
          label={t('AI 排查：{title}', { title: issue.title })}
          state={dockState}
          unseen={unseen}
          onExpand={() => {
            minimizeAiFix(false)
            setUnseen(false)
          }}
          onClose={() => closeAiFix()}
        />
      )}
      <D.Root
        open={open && !minimized}
        // 按 Esc 或点窗口外面：排查中先收起来，免得误触停止；没在排查就直接关
        onOpenChange={(o) => {
          if (o) return
          if (running) minimizeAiFix(true)
          else closeAiFix()
        }}
      >
        <D.Portal>
          <D.Overlay className="fixed inset-0 z-40 bg-black/50 animate-[fade-in_150ms_ease-out]" />
          <D.Content
            aria-describedby={undefined}
            className="fixed inset-2 z-50 m-auto flex max-h-[960px] max-w-[1100px] flex-col overflow-hidden rounded-2xl border border-line-strong bg-bg shadow-2xl animate-[pop-in_160ms_ease-out] focus:outline-none md:inset-6"
          >
            <D.Title className="sr-only">{t('AI 排查：{title}', { title: issue.title })}</D.Title>
            {taskId && !gone ? (
              <TaskView key={taskId} taskId={taskId} embed={{ actions, onLeave: hideAiFix }} />
            ) : (
              <div className="flex min-h-0 flex-1 flex-col">
                <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3 md:px-5">
                  <Sparkles className="h-4 w-4 text-accent" />
                  <span className="min-w-0 flex-1 truncate text-[0.84375rem] font-medium">
                    {t('AI 排查：{title}', { title: issue.title })}
                  </span>
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
                        {t('它已经从聊天列表里删掉，窗口不会跟着关。点右上角关闭才会收起这个窗口。')}
                      </p>
                    </div>
                  ) : starting ? (
                    <p className="flex items-center gap-2 text-[0.8125rem] text-muted">
                      <Loader2 className="h-4 w-4 animate-spin text-accent" />
                      {t('正在新建排查对话…')}
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
