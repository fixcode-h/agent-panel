import { useState } from 'react'
import {
  CircleX,
  ClipboardCheck,
  GitMerge,
  Hand,
  Loader2,
  MessageCircleQuestion,
  Pause,
  Play,
  Send,
  Workflow as WorkflowIcon,
} from 'lucide-react'
import { t } from '@shared/i18n'
import type { Task, TaskRequest } from '@shared/schema'
import { topSteps } from '@shared/flow'
import { stepMs } from '@shared/task'
import { RUN_ENDED, RUN_NO, runEntry, type RunEntry } from '@shared/flow-run'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { reloadOwnedRuns } from '@/lib/owned-runs'
import { fmtDuration } from '@/lib/tasks'
import { toastError } from '@/lib/toast'
import { useEscape } from '@/lib/useEscape'
import { useNow } from '@/lib/useNow'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ComposerPopover } from '@/components/ui/composer-popover'
import { FlowStrip, type FlowNode } from '@/components/ui/flow-strip'
import { ReviewDialog } from './ReviewDialog'

/** 名下还没结束的运行，按开始先后排 */
export const liveRuns = (list: Task[]) =>
  list
    .filter((x) => x.flowRun && !RUN_ENDED.includes(x.flowRun.phase))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))

/**
 * 父对话名下的工作流运行（design.md D3 / D5）：在运行区里、子对话那几行下面，一次运行一张卡片，
 * 和对话里的工作流卡片同一个样子（头一行工作流和进度、下面一排节点胶囊），再加一行它这会儿的状态和能做的事：
 * 节点等确认时查看结果（确认或提出修改）、追问、交给父对话；在跑的能暂停，停着或失败的能重启。点卡片在右栏打开它
 */
export function OwnedRunCards({
  ownerId,
  runs,
  onOpen,
}: {
  ownerId: string
  runs: Task[]
  onOpen?: (id: string) => void
}) {
  return (
    <div className="flex flex-col gap-2" role="group" aria-label={t('工作流运行')}>
      {runs.map((r) => (
        <OwnedRunCard key={r.id} ownerId={ownerId} task={r} onOpen={onOpen} />
      ))}
    </div>
  )
}

/** 运行这会儿的一句话：界面上的说法，和给父对话 AI 看的 runLine 同一个结论 */
function phaseText(e: RunEntry): string {
  if (e.paused) return t('已暂停 · {node}', { node: e.node })
  switch (e.phase) {
    case 'confirm':
      return t('「{node}」等你确认', { node: e.node })
    case 'failed':
      return t('「{node}」失败，等父对话决定', { node: e.node })
    case 'wrapup':
      return e.wrap?.stage === 'review'
        ? t('收尾 · 评审（第 {n} 轮）', { n: e.wrap.round })
        : e.wrap?.stage === 'test'
          ? t('收尾 · 测试（第 {n} 轮）', { n: e.wrap.round })
          : t('收尾 · 修复（第 {n} 轮）', { n: e.wrap?.round ?? 1 })
    case 'ready':
      return t('做完了，等父对话合回')
    default:
      return e.node ? t('在跑「{node}」', { node: e.node }) : t('准备中')
  }
}

const small = 'h-6 shrink-0 px-2 text-xs'

function OwnedRunCard({ ownerId, task, onOpen }: { ownerId: string; task: Task; onOpen?: (id: string) => void }) {
  const { agents } = useData()
  const run = runEntry(task)!
  const [busy, setBusy] = useState('')
  const [review, setReview] = useState<{ req: TaskRequest } | null>(null)
  const [asking, setAsking] = useState(false)
  const [question, setQuestion] = useState('')
  useEscape(asking, () => setAsking(false))
  const spinning = !run.paused && (run.phase === 'running' || run.phase === 'wrapup')
  const confirm = run.phase === 'confirm' && !run.paused
  const now = useNow(spinning)
  const steps = topSteps(task, RUN_NO)
  const ms = steps.reduce((n, s) => n + stepMs(s, now), 0)
  const nodes: FlowNode[] = steps.map((s) => ({
    id: s.id,
    label: s.title || t('未命名'),
    state: s.awaitConfirm
      ? 'wait'
      : s.status === 'done' || s.status === 'skipped'
        ? 'done'
        : s.status === 'running' && !run.paused
          ? 'running'
          : s.status === 'failed'
            ? 'failed'
            : 'idle',
  }))
  const over = run.reviseLimit > 0 && (run.rounds ?? 0) > run.reviseLimit
  const act = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what)
    try {
      await fn()
      await reloadOwnedRuns(ownerId)
    } catch (e) {
      toastError(e)
    } finally {
      setBusy('')
    }
  }
  /** 取运行的完整记录里那张确认卡：运行区拿到的是摘要，没有请求的原文 */
  const confirmReq = async () => {
    const req = (await api.task(run.id)).requests?.find((r) => r.kind === 'confirm')
    if (!req) throw new Error(t('这一步已经确认过了'))
    return req
  }
  const button = (
    what: string,
    label: string,
    Icon: typeof Play,
    fn: () => Promise<unknown>,
    primary = false,
    title = '',
  ) => (
    <Button
      size="sm"
      variant={primary ? 'primary' : 'ghost'}
      className={small}
      disabled={!!busy}
      title={title || undefined}
      onClick={(e) => {
        e.stopPropagation()
        void act(what, fn)
      }}
    >
      {busy === what ? <Loader2 className="h-3 w-3 animate-spin" /> : <Icon className="h-3 w-3" />}
      {label}
    </Button>
  )
  const Icon =
    run.phase === 'failed'
      ? CircleX
      : run.phase === 'ready'
        ? GitMerge
        : confirm
          ? Hand
          : run.paused
            ? Pause
            : WorkflowIcon
  const a = review && agents.find((x) => x.id === review.req.agentId)
  return (
    <div
      role="button"
      tabIndex={0}
      data-run-card
      onClick={() => onOpen?.(run.id)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
        e.preventDefault()
        onOpen?.(run.id)
      }}
      title={`${run.title} · ${t('在右栏查看')}`}
      className="group relative flex w-full cursor-pointer flex-col gap-2 rounded-xl bg-sel/45 px-3 py-2.5 text-left transition-colors hover:bg-sel/70"
    >
      {/* 头一行：和对话里的工作流卡片一样；名字是这次运行的标题，工作流名跟在后面 */}
      <span className="flex w-full min-w-0 items-center gap-2 text-body">
        <span className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded-lg bg-card shadow-[0_0_0_1px_var(--line)]">
          {spinning ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-accent-text" />
          ) : (
            <Icon
              className={cn(
                'h-3.5 w-3.5',
                run.phase === 'failed' ? 'text-danger' : confirm ? 'text-warning' : 'text-muted',
              )}
            />
          )}
        </span>
        <span className="shrink-0 font-semibold">{t('工作流')}</span>
        <span className="min-w-0 truncate">{run.title}</span>
        <span className="shrink-0 truncate text-muted max-sm:hidden">{run.workflowName}</span>
        <span className="flex-1" />
        {ms >= 1000 && <span className="shrink-0 font-mono text-xs text-subtle tabular-nums">{fmtDuration(ms)}</span>}
        <span className="shrink-0 text-xs whitespace-nowrap text-subtle underline decoration-transparent underline-offset-[3px] transition-colors group-hover:text-fg group-hover:decoration-current">
          {t('查看流程图')}
          {run.total > 0 && ` · ${run.done}/${run.total}`} ›
        </span>
      </span>
      {nodes.length > 0 && <FlowStrip nodes={nodes} />}
      {/* 状态和操作：等确认时就在这里确认（D5），不另起一行 */}
      <span className="flex min-h-6 w-full min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
        <span
          className={cn(
            'min-w-0 truncate text-xs',
            confirm ? 'text-warning' : run.phase === 'failed' ? 'text-danger' : 'text-subtle',
          )}
        >
          {phaseText(run)}
        </span>
        {over && <span className="shrink-0 text-xs text-warning">· {t('已改 {n} 轮', { n: run.rounds ?? 0 })}</span>}
        <span className="flex-1" />
        {confirm && (
          <>
            {button('review', t('查看结果'), ClipboardCheck, async () => setReview({ req: await confirmReq() }), true)}
            <Button
              size="sm"
              variant="ghost"
              className={small}
              disabled={!!busy}
              onClick={(e) => {
                e.stopPropagation()
                setAsking((v) => !v)
              }}
            >
              <MessageCircleQuestion className="h-3 w-3" />
              {t('追问')}
            </Button>
            {button(
              'delegate',
              t('交给父对话'),
              Send,
              () => api.delegateRun(run.id),
              false,
              t('确认卡片留着，请父对话替你决定'),
            )}
          </>
        )}
        {spinning && button('pause', t('暂停'), Pause, () => api.stopTask(run.id))}
        {(run.paused || run.phase === 'failed') &&
          button(
            'resume',
            t('重启'),
            Play,
            () => api.resumeTask(run.id),
            false,
            run.phase === 'failed' ? t('从失败的节点重新跑') : t('从停下的地方接着跑'),
          )}
      </span>
      {asking && (
        <ComposerPopover width="min(420px, calc(100vw - 2rem))" className="p-2" onClick={(e) => e.stopPropagation()}>
          <form
            className="flex items-center gap-2"
            onSubmit={(ev) => {
              ev.preventDefault()
              const q = question.trim()
              if (!q) return
              void act('ask', async () => {
                const req = await confirmReq()
                // 追问只回答问题、不改结果，不算一轮修改；回答完回到确认
                await api.answerRequest(run.id, req.id, { allow: false, ask: true, answer: q })
                setQuestion('')
                setAsking(false)
              })
            }}
          >
            <input
              autoFocus
              value={question}
              onChange={(ev) => setQuestion(ev.target.value)}
              placeholder={t('想先问清楚什么？（只回答，不改结果）')}
              className="h-8 min-w-0 flex-1 rounded-md bg-hover px-2.5 text-body text-fg outline-none placeholder:text-subtle"
            />
            <Button size="sm" type="submit" disabled={!question.trim() || busy === 'ask'}>
              {busy === 'ask' && <Loader2 className="h-3 w-3 animate-spin" />}
              {t('发送')}
            </Button>
          </form>
        </ComposerPopover>
      )}
      {review && (
        <span onClick={(e) => e.stopPropagation()}>
          <ReviewDialog
            req={review.req}
            agent={a ? { name: a.name, icon: a.icon, cli: a.cli } : undefined}
            open
            onOpenChange={(o) => !o && setReview(null)}
            // 出错时抛出：弹窗留着并提示错误，标注不会白写（见 ReviewDialog）
            onAnswer={async (allow, answer) => {
              await api.answerRequest(run.id, review.req.id, { allow, answer })
              await reloadOwnedRuns(ownerId)
            }}
          />
        </span>
      )}
    </div>
  )
}
