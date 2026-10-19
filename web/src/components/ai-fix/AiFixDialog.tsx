import { useState } from 'react'
import { ChevronRight, CircleAlert, CircleCheck, Loader2, RotateCw, Sparkles, Square } from 'lucide-react'
import { getCli } from '@shared/clis'
import { t } from '@shared/i18n'
import { retryAiFix, setAiFixOpen, stopAiFix, useAiFix } from '@/lib/ai-fix'
import { useNow } from '@/lib/useNow'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'
import { Markdown } from '@/components/tasks/Markdown'
import { ScopeRequests } from '@/components/chat/AskToggle'

const NO_TEAM = new Set<string>()

/**
 * 「AI 处理」的弹窗：上面是交给 AI 的报错（可以展开看命令和输出），下面是 AI 的进展和结论，
 * 要确认的命令、要回答的问题在中间显示成卡片。挂在最外层，所有报错的地方共用
 */
export function AiFixDialog() {
  const { open, issue, job, error } = useAiFix()
  const [details, setDetails] = useState(false)
  const running = job?.status === 'running' || (!job && !error)
  const now = useNow(running)
  if (!issue) return null
  const cli = job ? (getCli(job.cli)?.name ?? job.cli) : ''
  const secs = job ? Math.max(0, Math.round((now - job.startedAt) / 1000)) : 0
  const last = job?.thinking?.trim().split('\n').filter(Boolean).at(-1)
  const failed = error || (job?.status === 'failed' ? job.error || t('没有更多信息') : '')
  const more = !!(issue.command || issue.output || issue.context)
  return (
    <Modal
      open={open}
      onOpenChange={setAiFixOpen}
      wide
      title={
        <span className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-accent" />
          {t('AI 处理')}
        </span>
      }
      footer={
        <>
          <span className="min-w-0 flex-1 truncate text-[12px] text-subtle">
            {running
              ? t('关掉这个窗口也会接着处理，处理完会提醒你')
              : cli && t('由 {cli} 处理（设置里「AI 创建」用的 CLI）', { cli })}
          </span>
          {running && job ? (
            <Button variant="secondary" size="sm" onClick={stopAiFix}>
              <Square className="h-3 w-3" />
              {t('停止')}
            </Button>
          ) : (
            failed && (
              <Button variant="secondary" size="sm" onClick={retryAiFix}>
                <RotateCw className="h-3.5 w-3.5" />
                {t('重试')}
              </Button>
            )
          )}
          <Button size="sm" onClick={() => setAiFixOpen(false)}>
            {running ? t('后台处理') : t('关闭')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2 rounded-xl border border-danger/35 bg-danger/5 px-3.5 py-3">
        <div className="flex items-start gap-2 text-[13px]">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
          <span className="min-w-0 flex-1 font-medium">{issue.title}</span>
          {more && (
            <button
              onClick={() => setDetails(!details)}
              aria-expanded={details}
              className="flex shrink-0 cursor-pointer items-center gap-0.5 rounded-md px-1.5 py-0.5 text-xs text-muted hover:bg-sel hover:text-fg"
            >
              <ChevronRight className={cn('h-3 w-3 transition-transform', details && 'rotate-90')} />
              {t('交给 AI 的内容')}
            </button>
          )}
        </div>
        {issue.error && (
          <p className="line-clamp-4 pl-6 text-[12.5px] leading-relaxed whitespace-pre-wrap text-danger [overflow-wrap:anywhere]">
            {issue.error}
          </p>
        )}
        {details && (
          <pre className="max-h-56 overflow-auto rounded-lg bg-field/70 px-3 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-muted">
            {[
              issue.command && `$ ${issue.command}`,
              issue.output?.trim().slice(-6000),
              issue.context && `\n${issue.context}`,
            ]
              .filter(Boolean)
              .join('\n')}
          </pre>
        )}
      </div>

      {job && <ScopeRequests scope={`fix:${job.id}`} active={running} className="mb-0 max-w-none" />}

      {running && (
        <div className="flex items-center gap-2 text-[12.5px] text-muted">
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" />
          <span className="min-w-0 flex-1 truncate">
            {!job
              ? t('正在交给 AI…')
              : last
                ? t('正在思考：{text}', { text: last })
                : job.tools?.length
                  ? t('正在执行：{tool}', { tool: job.tools.at(-1)! })
                  : t('{cli} 正在分析…', { cli })}
          </span>
          {job && <span className="shrink-0 font-mono text-[11.5px] text-subtle">{secs}s</span>}
        </div>
      )}

      {!!job?.tools?.length && (
        <ul className="flex flex-col gap-0.5 font-mono text-[11.5px] text-subtle">
          {job.tools.map((x, i) => (
            <li key={i} className="truncate">
              ▸ {x}
            </li>
          ))}
        </ul>
      )}

      {job?.text && (
        <div className="text-[13.5px]">
          <Markdown text={job.text} teamNames={NO_TEAM} live={running} />
        </div>
      )}

      {job?.status === 'done' && (
        <p className="flex items-center gap-1.5 text-[12.5px] text-success">
          <CircleCheck className="h-4 w-4" />
          {t('AI 处理完了，按上面的说明确认一下结果')}
        </p>
      )}
      {failed && (
        <p className="flex items-start gap-1.5 text-[12.5px] leading-relaxed whitespace-pre-wrap text-danger">
          <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {failed}
        </p>
      )}
    </Modal>
  )
}
