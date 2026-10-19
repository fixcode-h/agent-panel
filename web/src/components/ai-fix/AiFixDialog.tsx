import { createPortal } from 'react-dom'
import * as D from '@radix-ui/react-dialog'
import { CircleAlert, ExternalLink, Loader2, Minus, Sparkles, X } from 'lucide-react'
import { t } from '@shared/i18n'
import { aiFixRunning, closeAiFix, hideAiFix, minimizeAiFix, useAiFix } from '@/lib/ai-fix'
import { useNav } from '@/lib/data'
import { Button } from '@/components/ui/button'
import { useStopConfirm } from '@/components/ui/stop-confirm'
import { TaskView } from '@/components/tasks/TaskView'

/**
 * 「AI 处理」的对话弹窗：和 MCP 工具的 AI 排查一样是一个大窗口，里面就是聊天里的那个对话（可以接着问）。
 * 最小化成右下角的按钮，排查照常进行；关闭会停止排查，先提醒一下（可以勾选以后不再提醒）
 */
export function AiFixDialog() {
  const { open, minimized, issue, taskId, status, starting, error } = useAiFix()
  const { go } = useNav()
  const stop = useStopConfirm(closeAiFix)
  if (!issue) return null
  const running = aiFixRunning()
  const close = () => stop.ask(running) && closeAiFix()
  // 到聊天里看：弹窗收起，排查照常进行，结束时会提醒
  const openInChat = () => {
    if (!taskId) return
    hideAiFix()
    go({ page: 'chat', id: taskId })
  }
  const actions = (
    <>
      {taskId && (
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
        onClick={close}
      >
        <X className="h-4 w-4" />
      </Button>
    </>
  )
  return (
    <>
      {open &&
        minimized &&
        // 放到 body 上、层级比设置弹窗高：在设置里最小化时也能看到、点到
        createPortal(
          // 放在底部中间：右下角是提示消息的位置，会被盖住
          <div className="pointer-events-none fixed inset-x-0 bottom-5 z-[60] flex justify-center">
            <button
              style={{ pointerEvents: 'auto' }}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => minimizeAiFix(false)}
              title={t('展开')}
              className="flex h-11 cursor-pointer items-center gap-2 rounded-full border border-line-strong bg-panel pr-4 pl-3 text-[13px] shadow-xl transition-colors hover:bg-sel animate-[pop-in_160ms_ease-out]"
            >
              <span className="grid h-7 w-7 place-items-center rounded-full bg-accent-soft text-accent">
                {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              </span>
              <span className="max-w-[260px] truncate">{t('AI 排查：{title}', { title: issue.title })}</span>
              <span className="text-xs text-subtle">
                {running ? t('排查中…') : status === 'done' ? t('已完成') : status ? t('已结束') : ''}
              </span>
            </button>
          </div>,
          document.body,
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
            {taskId ? (
              <TaskView key={taskId} taskId={taskId} embed={{ actions, onLeave: hideAiFix }} />
            ) : (
              <div className="flex min-h-0 flex-1 flex-col">
                <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3 md:px-5">
                  <Sparkles className="h-4 w-4 text-accent" />
                  <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">
                    {t('AI 排查：{title}', { title: issue.title })}
                  </span>
                  {actions}
                </header>
                <div className="grid flex-1 place-items-center p-6">
                  {starting ? (
                    <p className="flex items-center gap-2 text-[13px] text-muted">
                      <Loader2 className="h-4 w-4 animate-spin text-accent" />
                      {t('正在新建排查对话…')}
                    </p>
                  ) : (
                    error && (
                      <p className="flex max-w-lg items-start gap-2 text-[13px] leading-relaxed whitespace-pre-wrap text-danger">
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
      {stop.dialog}
    </>
  )
}
