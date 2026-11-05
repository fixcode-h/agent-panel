import { useEffect, useRef, useState } from 'react'
import {
  CircleAlert,
  ClipboardCheck,
  GitMerge,
  Loader2,
  MessageCircleQuestion,
  Pause,
  Play,
  Send,
  Waypoints,
} from 'lucide-react'
import { t } from '@shared/i18n'
import type { Task, TaskRequest } from '@shared/schema'
import { RUN_ENDED, runEntry, type RunEntry } from '@shared/flow-run'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { toastError } from '@/lib/toast'
import { useEscape } from '@/lib/useEscape'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ComposerPopover } from '@/components/ui/composer-popover'
import { ReviewDialog } from './ReviewDialog'
import { plainRow } from './ChildrenBar'

/** 名下运行的刷新间隔：有运行在跑时按它轮询（只是一次过滤后的列表查询） */
const POLL_MS = 3000

/**
 * 父对话的工作流栏（design.md D3）：贴在输入框上方、子对话那一行的下面，只列名下还没结束的工作流运行。
 * 运行不是子对话：没有对话状态那一套，行上说的是它的阶段（在跑哪个节点、等你确认、收尾、待合回、失败、已暂停）。
 * 节点等确认时确认就在这里做（D5）：查看结果（确认或提出修改）、追问、交给父对话决定；在跑的能暂停，停着的能继续（D4）
 */
export function WorkflowBar({
  ownerId,
  openId,
  onOpen,
  onList,
}: {
  ownerId: string
  /** 名下全部运行的 id（含已结束的）：右栏按它认得出打开的是运行、不是被删掉的子对话 */
  onList?: (ids: string[]) => void
  /** 右栏正在看的运行：那一块深一档 */
  openId: string
  /** 点运行的名字：在右栏打开它（看流程图和节点输出） */
  onOpen: (id: string) => void
}) {
  const [runs, setRuns] = useState<RunEntry[]>([])
  const reload = useRef<() => Promise<void>>(async () => {})
  useEffect(() => {
    let alive = true
    const load = async () => {
      const list = await api.flowRuns(ownerId).catch(() => null)
      if (!alive || !list) return
      onList?.(list.map((x) => x.id))
      setRuns(
        list
          .map((x) => runEntry(x))
          .filter((e): e is RunEntry => !!e && !RUN_ENDED.includes(e.phase))
          .sort((a, b) => (a.updatedAt ?? '').localeCompare(b.updatedAt ?? '')),
      )
    }
    reload.current = load
    void load()
    const timer = setInterval(() => void load(), POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
    // onList 是父组件每次渲染新建的回调：只按父对话换了没有重新订阅，不然每次渲染都重开轮询
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerId])
  if (!runs.length) return null
  return (
    <div className="shrink-0 px-3 md:px-6">
      <div className="mx-auto max-w-(--content-w)">
        <div data-status-row="workflows" className={cn(plainRow, 'mb-1 flex-wrap gap-y-1')}>
          {runs.map((e) => (
            <RunCard key={e.id} run={e} open={e.id === openId} onOpen={onOpen} onChanged={() => reload.current()} />
          ))}
        </div>
      </div>
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

function RunCard({
  run,
  open,
  onOpen,
  onChanged,
}: {
  run: RunEntry
  open: boolean
  onOpen: (id: string) => void
  onChanged: () => Promise<void>
}) {
  const { agents } = useData()
  const [busy, setBusy] = useState('')
  const [review, setReview] = useState<{ task: Task; req: TaskRequest } | null>(null)
  const [asking, setAsking] = useState(false)
  const [question, setQuestion] = useState('')
  useEscape(asking, () => setAsking(false))
  const act = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what)
    try {
      await fn()
      await onChanged()
    } catch (e) {
      toastError(e)
    } finally {
      setBusy('')
    }
  }
  /** 取运行的完整记录里那张确认卡：栏上的列表是摘要，没有请求的原文 */
  const confirmReq = async () => {
    const task = await api.task(run.id)
    const req = task.requests?.find((r) => r.kind === 'confirm')
    if (!req) throw new Error(t('这一步已经确认过了'))
    return { task, req }
  }
  const confirm = run.phase === 'confirm' && !run.paused
  const spinning = !run.paused && (run.phase === 'running' || run.phase === 'wrapup')
  const Icon = run.phase === 'failed' ? CircleAlert : run.phase === 'ready' ? GitMerge : Waypoints
  const over = run.reviseLimit > 0 && (run.rounds ?? 0) > run.reviseLimit
  const a = review && agents.find((x) => x.id === review.req.agentId)
  return (
    <div className="relative flex min-w-0 items-center gap-1.5">
      <button
        type="button"
        data-run-card
        onClick={() => onOpen(run.id)}
        title={`${run.title} · ${run.workflowName} · ${phaseText(run)}`}
        className={cn(
          'flex h-7 max-w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg px-2.5 text-xs transition-colors hover:bg-sel',
          open ? 'bg-sel' : 'bg-sel/45',
        )}
      >
        {spinning ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-accent-text" />
        ) : (
          <Icon
            className={cn(
              'h-3 w-3 shrink-0',
              run.phase === 'failed' ? 'text-danger' : confirm ? 'text-warning' : 'text-muted',
            )}
          />
        )}
        <span className="max-w-48 min-w-0 shrink-0 truncate font-medium text-fg">{run.title}</span>
        <span className="shrink-0 text-subtle">{`${run.workflowName} ${run.done}/${run.total}`}</span>
        <span className={cn('min-w-0 truncate', confirm ? 'text-warning' : 'text-subtle')}>{phaseText(run)}</span>
        {over && <span className="shrink-0 text-warning">{t('已改 {n} 轮', { n: run.rounds ?? 0 })}</span>}
      </button>
      {confirm && (
        <>
          <Button
            size="sm"
            variant="primary"
            className="h-6 shrink-0 px-2 text-xs"
            disabled={!!busy}
            onClick={() => void act('review', async () => setReview(await confirmReq()))}
          >
            {busy === 'review' ? <Loader2 className="h-3 w-3 animate-spin" /> : <ClipboardCheck className="h-3 w-3" />}
            {t('查看结果')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 shrink-0 px-2 text-xs"
            disabled={!!busy}
            onClick={() => setAsking((v) => !v)}
          >
            <MessageCircleQuestion className="h-3 w-3" />
            {t('追问')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 shrink-0 px-2 text-xs"
            disabled={!!busy}
            title={t('确认卡片留着，请父对话替你决定')}
            onClick={() => void act('delegate', () => api.delegateRun(run.id))}
          >
            {busy === 'delegate' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
            {t('交给父对话')}
          </Button>
        </>
      )}
      {spinning && (
        <Button
          size="sm"
          variant="ghost"
          className="h-6 shrink-0 px-2 text-xs"
          disabled={!!busy}
          onClick={() => void act('pause', () => api.stopTask(run.id))}
        >
          {busy === 'pause' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Pause className="h-3 w-3" />}
          {t('暂停')}
        </Button>
      )}
      {(run.paused || run.phase === 'failed') && (
        <Button
          size="sm"
          variant="ghost"
          className="h-6 shrink-0 px-2 text-xs"
          disabled={!!busy}
          title={run.phase === 'failed' ? t('从失败的节点重新跑') : t('从停下的地方接着跑')}
          onClick={() => void act('resume', () => api.resumeTask(run.id))}
        >
          {busy === 'resume' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
          {t('重启')}
        </Button>
      )}
      {asking && (
        <ComposerPopover width="min(420px, calc(100vw - 2rem))" className="p-2">
          <form
            className="flex items-center gap-2"
            onSubmit={(ev) => {
              ev.preventDefault()
              const q = question.trim()
              if (!q) return
              void act('ask', async () => {
                const { req } = await confirmReq()
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
        <ReviewDialog
          req={review.req}
          agent={a ? { name: a.name, icon: a.icon, cli: a.cli } : undefined}
          open
          onOpenChange={(o) => !o && setReview(null)}
          // 出错时抛出：弹窗留着并提示错误，标注不会白写（见 ReviewDialog）
          onAnswer={async (allow, answer) => {
            await api.answerRequest(run.id, review.req.id, { allow, answer })
            await onChanged()
          }}
        />
      )}
    </div>
  )
}
