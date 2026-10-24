import { useState } from 'react'
import { ChevronRight, CircleAlert, CircleCheck, TriangleAlert } from 'lucide-react'
import type { Alert } from '@shared/schema'
import { alertInfo } from '@shared/alerts'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { AiFixButton } from '@/components/ui/ai-fix'
import { CopyButton } from '@/components/chat/ChatMessage'

/**
 * 对话里的报错和警告：和工具行一样是一行，带底色一眼认得出（警告黄、错误红、已恢复灰）。
 * 一行里是这一类的名字和面板写的那句话；点开看这是什么、怎么办和原始信息，可以复制或交给 AI 处理
 */
export function AlertRow({
  alert,
  text,
  conversation,
  cwd,
  className,
}: {
  alert: Alert
  /** 面板写的那句话：一行里显示第一行，点开显示全文 */
  text: string
  /** 报错前后的对话：交给 AI 时一起带上 */
  conversation?: string
  cwd?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const info = alertInfo(alert.kind)
  const done = !!alert.resolved
  const error = !done && alert.level === 'error'
  const Icon = done ? CircleCheck : error ? CircleAlert : TriangleAlert
  const detail = alert.detail.trim()
  const body = text.trim()
  const report = [body, detail && detail !== body ? `${t('原始信息：')}\n${detail}` : ''].filter(Boolean).join('\n\n')
  return (
    <div
      role={done ? undefined : 'alert'}
      className={cn(
        'min-w-0 overflow-hidden rounded-lg border text-left text-xs',
        done ? 'border-line bg-field' : error ? 'border-danger/35 bg-danger/8' : 'border-warning/40 bg-warning/10',
        className,
      )}
    >
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        title={open ? t('收起') : t('点开看原因和怎么办')}
        className="group flex w-full min-w-0 cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left"
      >
        <Icon className={cn('h-3.5 w-3.5 shrink-0', done ? 'text-subtle' : error ? 'text-danger' : 'text-warning')} />
        <span className={cn('shrink-0 font-medium', done ? 'text-muted' : error ? 'text-danger' : 'text-warning')}>
          {info.title}
        </span>
        <span className={cn('min-w-0 flex-1 truncate', done ? 'text-subtle' : 'text-fg/80')}>
          {body.split('\n')[0]}
        </span>
        {done && (
          <span className="shrink-0 rounded bg-sel px-1.5 py-px text-[0.6875rem] text-subtle">{t('已恢复')}</span>
        )}
        <ChevronRight
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-subtle transition',
            open ? 'rotate-90' : 'opacity-60 group-hover:opacity-100',
          )}
        />
      </button>
      {open && (
        <div className="flex flex-col gap-2 border-t border-line/60 px-3 py-2.5 leading-relaxed">
          {body.includes('\n') && <p className="whitespace-pre-wrap text-fg/85 [overflow-wrap:anywhere]">{body}</p>}
          {done && <p className="text-success">{alert.resolved}</p>}
          <Section label={t('这是什么')} text={info.what} />
          <Section label={t('怎么办')} text={info.fix} />
          {detail && detail !== body && (
            <div className="flex flex-col gap-1">
              <span className="font-medium text-muted">{t('原始信息')}</span>
              <pre className="max-h-60 overflow-auto rounded-md bg-field px-2.5 py-2 font-mono text-[0.6875rem] whitespace-pre-wrap text-fg/80 [overflow-wrap:anywhere]">
                {detail}
              </pre>
            </div>
          )}
          <div className="flex gap-1">
            <CopyButton text={`${info.title}\n${report}`} label={t('复制报错')} className="h-6 w-6 bg-card/60" />
            {!done && (
              <AiFixButton
                size="icon-sm"
                variant="ghost"
                className="h-6 w-6 bg-card/60"
                issue={{
                  title: t('对话里的报错：{line}', { line: `${info.title} · ${body.split('\n')[0]}`.slice(0, 80) }),
                  error: report,
                  context: `这条报错出现在 Agent 面板的对话里，分类是「${info.title}」：${info.what}`,
                  conversation: conversation ?? '',
                  cwd: cwd ?? '',
                }}
              />
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function Section({ label, text }: { label: string; text: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-medium text-muted">{label}</span>
      <span className="text-fg/80">{text}</span>
    </div>
  )
}
