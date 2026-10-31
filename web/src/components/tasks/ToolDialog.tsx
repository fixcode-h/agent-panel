import { Copy, Loader2, Terminal, TerminalSquare, Wrench } from 'lucide-react'
import { Modal, ModalButton, ModalHeader } from '@/components/ui/modal'
import { StatusPill, type StatusTone } from '@/components/ui/status-pill'
import { copyText } from '@/lib/copy-text'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { fmtDuration } from '@/lib/tasks'
import { useNow } from '@/lib/useNow'
import { useStickToBottom } from '@/lib/useStickToBottom'
import { jobLive } from '@/lib/job-poll'

/**
 * 命令行窗口的高度跟着输出走：命令短、输出只有几行时不用撑满一屏白片，
 * 输出多了才长到上限、在窗口里滚动。外壳用 Modal 的 full 档，只把固定高度换成按内容长
 */
const termHeight = 'h-auto min-h-[min(360px,calc(100dvh-3.75rem))]'

/** 复制成功都说一句复制了什么：命令和输出共用一个按钮时，光说「已复制」分不清 */
const copy = (text: string, done: string) => void copyText(text, { done })

/** 还在跑时光标一直闪：比只有一个转圈更能看出输出还在往下走 */
function Caret() {
  return (
    <span
      aria-hidden
      className="ml-0.5 inline-block h-[0.95em] w-[0.45em] translate-y-[0.12em] animate-pulse bg-accent/75 align-baseline"
    />
  )
}

/**
 * 工具调用的输出（搜索、网页、MCP 等）：窗口里看完整内容，太长的不会把对话挤满。
 * 命令有自己的窗口（CommandDialog），这里只看说明和输出
 */
export function OutputDialog({
  title,
  detail,
  input,
  output,
  failed,
  running,
  open,
  onOpenChange,
}: {
  title: string
  /** 命令或搜索词这一类短说明 */
  detail?: string
  input?: string
  output?: string
  failed?: boolean
  running?: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const text = output ?? ''
  return (
    // 只看不填：点到外面就关（和原来手写外壳的默认行为一致）
    <Modal open={open} onOpenChange={onOpenChange} title={null} size="full" bare closeOnOutside>
      <ModalHeader
        icon={Wrench}
        title={title}
        titleClass="font-mono"
        titleAttr={title}
        actions={<ModalButton icon={Copy} label={t('复制')} disabled={!text} onClick={() => copy(text, t('已复制'))} />}
      >
        {detail && (
          <span className="max-w-[40%] min-w-0 truncate font-mono text-footnote text-subtle" title={detail}>
            {detail}
          </span>
        )}
      </ModalHeader>
      <div className="min-h-0 flex-1 overflow-auto bg-(--code-bg)">
        {input && input.trim() && input.trim() !== detail?.trim() && (
          <div className="border-b px-4 py-3">
            <div className="mb-1 font-sans text-caption font-medium tracking-wider text-subtle">IN</div>
            <pre className="font-mono text-footnote leading-[1.6] whitespace-pre-wrap text-fg/90 [overflow-wrap:anywhere]">
              {input}
            </pre>
          </div>
        )}
        <div className="px-4 py-3">
          <div className="mb-1 font-sans text-caption font-medium tracking-wider text-subtle">OUT</div>
          {text.trim() ? (
            <pre
              className={cn(
                'font-mono text-footnote leading-[1.6] whitespace-pre-wrap [overflow-wrap:anywhere]',
                failed ? 'text-danger' : 'text-fg/90',
              )}
            >
              {text}
            </pre>
          ) : running ? (
            <p className="flex items-center gap-2 text-body text-subtle">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('还在执行…')}
            </p>
          ) : (
            <p className="text-body text-subtle">{t('没有输出')}</p>
          )}
        </div>
      </div>
    </Modal>
  )
}

/**
 * 命令行窗口里这条命令的当前阶段。工具行的命令只有执行中、完成、失败；
 * 后台命令多出「排队中」（还没排到）和「已停止」两种，它们不能显示成「完成」
 */
export type CommandPhase = 'queued' | 'running' | 'done' | 'failed' | 'stopped'

/**
 * 阶段对应的徽标：颜色和文字只写这一处，不传 status 的调用按 running / failed 推出来。
 * text 写成取值函数：t() 读的是可变当前语言，模块级常量在 import 时就把文字算死了
 * （和 AnalysisPanel 的 title、Messages 的 verb 同一个写法）
 */
const PHASE: Record<CommandPhase, { text: () => string; tone: StatusTone; dot: string }> = {
  queued: { text: () => t('排队中'), tone: 'idle', dot: 'bg-subtle' },
  running: { text: () => t('执行中'), tone: 'run', dot: 'animate-pulse bg-run' },
  done: { text: () => t('完成'), tone: 'ok', dot: 'bg-success' },
  failed: { text: () => t('失败'), tone: 'err', dot: 'bg-danger' },
  stopped: { text: () => t('已停止'), tone: 'idle', dot: 'bg-subtle' },
}

/**
 * 跑命令的工具行点开：像终端一样看这条命令和它的输出。
 * 输出在跑的时候跟着更新，滚动条停在底部时自动跟随
 */
export function CommandDialog({
  command,
  output,
  failed,
  running,
  status,
  ms,
  startedAt,
  /** 退出码（后台命令结束后有）：和阶段徽标放在一起，失败时能分清是测试挂了还是进程被杀 */
  code,
  /** 拉输出失败的原因（后台命令的窗口轮询接口）：失败也要看到，不能只当没输出 */
  error,
  open,
  onOpenChange,
}: {
  command: string
  output?: string
  failed?: boolean
  running?: boolean
  /** 明确告诉窗口现在是什么阶段（后台命令要区分排队中和已停止）；不传时按 running / failed 推 */
  status?: CommandPhase
  /** 跑完用了多久（毫秒） */
  ms?: number
  /** 开始的时间：还在跑时每秒往上加，不用等结果回来才看得到用了多久 */
  startedAt?: number
  /** 退出码（后台命令结束后有）：失败、被停止时要看得到是退出码几还是被信号杀掉 */
  code?: number | null
  error?: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const text = output?.replace(/\s+$/, '') ?? ''
  const hasOutput = !!text.trim()
  const phase: CommandPhase = status ?? (failed ? 'failed' : running ? 'running' : 'done')
  const now = useNow(phase === 'running' && startedAt !== undefined)
  const elapsed = phase === 'running' ? (startedAt === undefined ? undefined : now - startedAt) : ms
  const lines = hasOutput ? text.split('\n').length : 0
  // 贴底：输出变高时跟着走，用户往上翻看就不拽回来。弹窗的滚动容器比父组件晚一帧才挂上，
  // 所以用 useStickToBottom 的回调 ref（见 web/src/lib/useStickToBottom.ts），不在父组件的布局副作用里拿节点
  const stick = useStickToBottom(command)

  return (
    <Modal open={open} onOpenChange={onOpenChange} title={null} size="full" bare closeOnOutside className={termHeight}>
      {/* 标题就是命令本身（悬停看全文），右边是状态和用时，不再是空的「命令」两个字 */}
      <ModalHeader
        icon={Terminal}
        title={
          <>
            <span aria-hidden className="mr-1.5 select-none text-subtle">
              $
            </span>
            {command}
          </>
        }
        titleClass="font-mono"
        titleAttr={command}
        aside={
          <StatusPill tone={PHASE[phase].tone} className="h-5 shrink-0 px-2 font-sans">
            <span className={cn('h-1.5 w-1.5 rounded-full', PHASE[phase].dot)} />
            {PHASE[phase].text()}
            {elapsed !== undefined && <span className="tabular-nums opacity-80">{fmtDuration(elapsed)}</span>}
            {/* 退出码：只在结束时说，跑着时没有 */}
            {!jobLive(phase) && code !== undefined && code !== null && (
              <span className="tabular-nums opacity-80">{t('退出码 {code}', { code })}</span>
            )}
          </StatusPill>
        }
        actions={
          <>
            <ModalButton icon={Copy} label={t('复制命令')} onClick={() => copy(command, t('已复制命令'))} />
            <ModalButton
              icon={Copy}
              label={t('复制全部输出')}
              disabled={!hasOutput}
              onClick={() => copy(text, t('已复制输出'))}
            />
          </>
        }
      />
      <div
        ref={stick.ref}
        onScroll={stick.onScroll}
        className="min-h-0 flex-1 overflow-auto overscroll-contain bg-(--code-bg)"
      >
        <div className="px-5 py-4 font-mono text-footnote leading-[1.7]">
          <div className="flex items-start gap-2.5">
            <span aria-hidden className="shrink-0 select-none text-accent-text">
              $
            </span>
            <span className="min-w-0 flex-1 whitespace-pre-wrap text-fg [overflow-wrap:anywhere]">{command}</span>
          </div>
          {hasOutput && (
            <div className="mt-2.5 flex gap-2.5">
              {/* 占住 $ 那一列的宽度，左侧竖线把命令和输出分成两层 */}
              <span aria-hidden className="w-2.5 shrink-0" />
              <pre
                className={cn(
                  'min-w-0 flex-1 border-l pl-3 whitespace-pre-wrap [overflow-wrap:anywhere]',
                  phase === 'failed' ? 'border-danger/40 text-danger/90' : 'border-line text-muted',
                )}
              >
                {text}
                {phase === 'running' && <Caret />}
              </pre>
            </div>
          )}
          {/* 拉取失败：写在输出上方而不是只占空状态位——已经有输出时也要看得到（否则窗口停在旧输出上，
                  徒标还写着「执行中」，用户以为命令还在跑）。拉失败会按 JOB_RETRY_MS 重试，这里说清楚 */}
          {error && (
            <div className="mt-2.5 flex items-start gap-2.5 rounded-lg bg-danger/8 px-3 py-2 font-sans">
              <TerminalSquare className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" />
              <div className="min-w-0">
                <p className="text-body font-medium text-danger">{t('读不到这条命令的输出')}</p>
                <p className="mt-0.5 text-xs leading-relaxed break-words text-subtle [overflow-wrap:anywhere]">
                  {error}
                </p>
                <p className="mt-0.5 text-xs text-subtle">{t('会自动重试，显示的是上一次读到的输出。')}</p>
              </div>
            </div>
          )}
          {!hasOutput &&
            (!error && phase === 'running' ? (
              <div className="mt-2.5 flex gap-2.5">
                <span aria-hidden className="w-2.5 shrink-0" />
                <p className="flex min-w-0 flex-1 items-center gap-2 border-l border-line pl-3 text-subtle">
                  <Caret />
                  {t('正在执行，等待输出…')}
                </p>
              </div>
            ) : phase === 'queued' ? (
              /* 排队中还没有输出：说清它在等什么，不然窗口里一片空白像是坏了 */
              <div className="mt-5 flex items-start gap-3 rounded-xl border border-dashed border-line-strong/70 bg-card/40 px-4 py-4 font-sans">
                <TerminalSquare className="mt-0.5 h-4 w-4 shrink-0 text-subtle" />
                <div className="min-w-0">
                  <p className="text-body font-medium text-muted">{t('排队中，还没有输出')}</p>
                  <p className="mt-0.5 text-xs leading-relaxed text-subtle">
                    {t('前面还有命令在跑，排到它时这里会跟着输出。')}
                  </p>
                </div>
              </div>
            ) : (
              /* 空状态也说清楚为什么空、下一步看什么，不留一行灰字 */
              <div className="mt-5 flex items-start gap-3 rounded-xl border border-dashed border-line-strong/70 bg-card/40 px-4 py-4 font-sans">
                <TerminalSquare
                  className={cn('mt-0.5 h-4 w-4 shrink-0', phase === 'failed' ? 'text-danger' : 'text-subtle')}
                />
                <div className="min-w-0">
                  <p className={cn('text-body font-medium', phase === 'failed' ? 'text-danger' : 'text-muted')}>
                    {phase === 'failed'
                      ? t('执行失败，没有输出')
                      : phase === 'stopped'
                        ? t('已停止，没有输出')
                        : t('这条命令没有输出')}
                  </p>
                  <p className="mt-0.5 text-xs leading-relaxed text-subtle">
                    {phase === 'failed'
                      ? t('这次调用没有标准输出或错误输出，关掉窗口展开这次调用可以看到返回的错误。')
                      : phase === 'stopped'
                        ? t('这条命令被停止之前没有输出。')
                        : t('命令正常结束，没有标准输出或错误输出。')}
                  </p>
                </div>
              </div>
            ))}
        </div>
      </div>
      {/* 底部常驻一条状态：长输出滚到哪都看得出还在跑 */}
      {phase === 'running' && (
        <div className="flex h-9 shrink-0 items-center gap-2 border-t bg-card/70 px-4 font-sans text-xs text-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-accent-text" />
          {t('正在执行…')}
          {lines > 0 && (
            <span className="ml-auto font-mono text-caption text-subtle tabular-nums">
              {t('输出 {n} 行', { n: lines })}
            </span>
          )}
        </div>
      )}
    </Modal>
  )
}
