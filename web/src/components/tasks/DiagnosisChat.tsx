import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { Task } from '@shared/schema'
import type { Diagnosis } from '@shared/bug/diagnosis-schema'
import { chatStale } from '@shared/bug/chat'
import { conclusionChanged } from '@shared/bug/diagnosis-compare'
import { labelOf } from '@shared/bug/phase'
import { t } from '@shared/i18n'
import { Button } from '@/components/ui/button'
import { ChatQuotes } from '@/components/ui/chat-quotes'
import { StatusPill } from '@/components/ui/status-pill'
import { toast } from '@/lib/toast'
import { ANCHOR_RETRY_MS, ANCHOR_TRIES, jumpToMessage } from '@/lib/message-anchor'
import { compareBase } from './DiagnosisCompare'

/**
 * 诊断报告跟上对话（用户 2026-11-13 定，设计稿「诊断报告-跟随子对话聊天更新」）：
 * - ChatBasis：按对话更新的一版，列出依据的原话；在对话里确认的标出来，看错了点「不是这个意思」撤回；
 * - ChatStale：最新一版之后你在对话里又说了话，提示报告可能没跟上，一键请它按对话更新。
 * 判定和交给它的话在 shared/bug/chat.ts，这里只拼界面
 */

/** 跳回对话里那条消息：先关掉弹窗（停靠在右栏时也一样），消息可能收在折叠段里，按锚点重试几次 */
function jumpLater(id: string) {
  let tries = 0
  const tick = () => {
    if (jumpToMessage(id) || ++tries >= ANCHOR_TRIES) return
    setTimeout(tick, ANCHOR_RETRY_MS)
  }
  setTimeout(tick, ANCHOR_RETRY_MS)
}

/** 点按钮后等服务端：转圈、不让连点 */
function useBusy() {
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return { busy, run }
}

export function ChatBasis({
  d,
  list,
  onRetract,
  onJump,
}: {
  d: Diagnosis
  list: Diagnosis[]
  /** 只有最新一版、按对话确认的才给：撤回确认 */
  onRetract?: () => Promise<void>
  /** 点一句原话：关掉弹窗再跳过去 */
  onJump?: () => void
}) {
  const { busy, run } = useBusy()
  if (!d.chat?.length) return null
  const base = compareBase(d, list)
  const changed = base ? conclusionChanged(base, d) : undefined
  const by = d.approvedBy?.kind === 'chat' ? d.chat.find((x) => x.id === d.approvedBy?.id) : undefined
  return (
    <ChatQuotes
      className="mb-3"
      title={t('依据你在对话里说的（{k} 句）', { k: d.chat.length })}
      items={d.chat}
      onJump={(id) => {
        onJump?.()
        jumpLater(id)
      }}
      aside={
        <>
          {base && changed !== undefined && (
            <StatusPill tone={changed ? 'wait' : 'ok'}>
              {changed
                ? t('比第 {v} 版：结论已改', { v: labelOf(base, list).ver })
                : t('比第 {v} 版：结论没变', { v: labelOf(base, list).ver })}
            </StatusPill>
          )}
          {d.approvedBy?.kind === 'chat' && (
            <StatusPill tone="ok" title={by?.text}>
              {t('你在对话里确认了')}
            </StatusPill>
          )}
        </>
      }
      footer={
        onRetract && (
          <>
            <span className="min-w-0 flex-1 text-caption text-subtle">
              {t('它把你最后一句当成了确认；理解错了就撤回，这一版回到等你确认')}
            </span>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run(onRetract)}>
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t('不是这个意思')}
            </Button>
          </>
        )
      }
    />
  )
}

export function ChatStale({
  task,
  onSync,
}: {
  task: Pick<Task, 'bug'> & Partial<Pick<Task, 'messages' | 'changes'>>
  onSync: () => Promise<void>
}) {
  const { busy, run } = useBusy()
  const s = chatStale({ ...task, messages: task.messages ?? [] })
  if (!s) return null
  const text = s.files.length
    ? t('这份报告之后你在对话里说了 {n} 句，它还改了 {k} 个报告没覆盖的文件，报告可能没跟上。', {
        n: s.said.length,
        k: s.files.length,
      })
    : t('这份报告之后你在对话里说了 {n} 句，报告可能没跟上。', { n: s.said.length })
  return (
    <div data-chat-stale className="mb-3 rounded-lg border border-line bg-card px-3 py-2 text-body select-none">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="min-w-0 flex-1 basis-64 text-warning">{text}</span>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run(onSync)}>
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {t('让它按对话更新报告')}
        </Button>
      </div>
      {s.files.length > 0 && (
        <ul className="mt-2 max-h-24 overflow-y-auto rounded-md bg-panel px-2 py-1.5 font-mono text-caption text-muted">
          {s.files.map((f) => (
            <li key={f} className="truncate" title={f}>
              {f}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
