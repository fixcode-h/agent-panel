import { useEffect, useMemo, useRef, useState } from 'react'
import { ClipboardCheck, Highlighter, Loader2, Trash2 } from 'lucide-react'
import type { TaskRequest } from '@shared/schema'
import { useData } from '@/lib/data'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { Modal, ModalHeader } from '@/components/ui/modal'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/input'
import { IconButton } from '@/components/ui/icon-button'
import { AgentAvatar } from '@/components/agents/AgentAvatar'
import { Markdown } from './Markdown'
import { reviewFeedback } from '@/lib/review-feedback'
import { t } from '@shared/i18n'

type Note = { id: number; quote: string; comment: string; range: Range }

/** 浏览器支持 CSS Custom Highlight 时用它画标注：不改渲染出来的 DOM，Markdown 重画也不会冲掉 */
const canHighlight = () => typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined'

/**
 * 阶段确认的审阅弹窗：左边按统一的 Markdown 样式渲染这一步的结果，选中文字可以标注，标注列在右栏。
 * 「修改」把标注整理成意见退回给 Agent 返工，「确认」表示没有要改的，工作流往下走
 */
export function ReviewDialog({
  req,
  agent,
  open,
  onOpenChange,
  onAnswer,
}: {
  req: TaskRequest
  agent?: { name: string; icon: string; cli: string }
  open: boolean
  onOpenChange: (open: boolean) => void
  onAnswer: (allow: boolean, answer?: string) => Promise<void>
}) {
  const { agents } = useData()
  // Markdown 按引用比较 teamNames，这里稳定下来，标注时父组件重画不会让文档重新解析（重新解析会让已有标注的位置失效）
  const teamNames = useMemo(() => new Set(agents.map((a) => a.name)), [agents])
  const scrollRef = useRef<HTMLDivElement>(null)
  const docRef = useRef<HTMLDivElement>(null)
  const seq = useRef(0)
  const [notes, setNotes] = useState<Note[]>([])
  const [overall, setOverall] = useState('')
  const [active, setActive] = useState<number | null>(null)
  const [focusId, setFocusId] = useState<number | null>(null)
  // 选中文字后浮在选区上方的「标注」按钮，位置相对滚动区
  const [pick, setPick] = useState<{ range: Range; quote: string; top: number; left: number } | null>(null)
  const [busy, setBusy] = useState<'' | 'allow' | 'deny'>('')

  // 换了一个请求（退回后 Agent 改完又来确认）时标注从头开始
  useEffect(() => {
    setNotes([])
    setOverall('')
    setPick(null)
    setActive(null)
  }, [req.id])

  useEffect(() => {
    if (!canHighlight() || !open) return
    const all = new Highlight(...notes.map((n) => n.range))
    const cur = notes.find((n) => n.id === active)
    CSS.highlights.set('review-note', all)
    if (cur) CSS.highlights.set('review-note-active', new Highlight(cur.range))
    else CSS.highlights.delete('review-note-active')
    return () => {
      CSS.highlights.delete('review-note')
      CSS.highlights.delete('review-note-active')
    }
  }, [notes, active, open])

  const readSelection = () => {
    const sel = window.getSelection()
    const doc = docRef.current
    const box = scrollRef.current
    if (!sel || sel.isCollapsed || !sel.rangeCount || !doc || !box) return setPick(null)
    const range = sel.getRangeAt(0)
    if (!doc.contains(range.commonAncestorContainer)) return setPick(null)
    const quote = sel.toString().trim()
    if (!quote) return setPick(null)
    const r = range.getBoundingClientRect()
    const b = box.getBoundingClientRect()
    setPick({
      range: range.cloneRange(),
      quote,
      top: r.top - b.top + box.scrollTop - 34,
      left: Math.min(Math.max(r.left - b.left + r.width / 2, 40), b.width - 40),
    })
  }

  const addNote = () => {
    if (!pick) return
    const id = ++seq.current
    setNotes((ns) => [...ns, { id, quote: pick.quote, comment: '', range: pick.range }])
    setActive(id)
    setFocusId(id)
    setPick(null)
    window.getSelection()?.removeAllRanges()
  }

  // 点到已标注的文字：右栏对应那条亮起来
  const onDocClick = (e: React.MouseEvent) => {
    if (!notes.length || !window.getSelection()?.isCollapsed) return
    const pos = document.caretRangeFromPoint?.(e.clientX, e.clientY)
    if (!pos) return
    const hit = [...notes].reverse().find((n) => {
      try {
        return n.range.isPointInRange(pos.startContainer, pos.startOffset)
      } catch {
        return false
      }
    })
    if (!hit) return
    setActive(hit.id)
    document.getElementById(`review-note-${hit.id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }

  // 右栏点一条：文档滚到它标注的位置
  const reveal = (n: Note) => {
    setActive(n.id)
    const box = scrollRef.current
    if (!box) return
    const r = n.range.getBoundingClientRect()
    const b = box.getBoundingClientRect()
    if (r.top < b.top || r.bottom > b.bottom)
      box.scrollTo({ top: box.scrollTop + r.top - b.top - b.height / 3, behavior: 'smooth' })
  }

  const hasFeedback = notes.length > 0 || !!overall.trim()
  const submit = async (allow: boolean) => {
    if (busy) return
    setBusy(allow ? 'allow' : 'deny')
    try {
      await onAnswer(allow, allow ? undefined : reviewFeedback(notes, overall))
      onOpenChange(false)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} title={null} bare size="full">
      <ModalHeader icon={ClipboardCheck} iconClass="text-warning" title={req.title}>
        {agent && (
          <span className="hidden min-w-0 items-center gap-1.5 text-footnote text-subtle sm:flex">
            <AgentAvatar icon={agent.icon} cli={agent.cli} size="xs" />
            <span className="truncate">{agent.name}</span>
          </span>
        )}
      </ModalHeader>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <div
          ref={scrollRef}
          className="relative min-h-0 flex-1 overflow-y-auto px-5 py-4 md:px-8 md:py-6"
          onMouseUp={readSelection}
          onKeyUp={readSelection}
          onScroll={() => pick && setPick(null)}
        >
          <div ref={docRef} className="mx-auto max-w-[820px]" onClick={onDocClick}>
            {req.detail ? (
              <Markdown text={req.detail} teamNames={teamNames} />
            ) : (
              <p className="text-body text-subtle">{t('这一步没有输出内容')}</p>
            )}
          </div>
          {pick && (
            <button
              type="button"
              // 按下时不让选区丢掉，松开再加标注
              onMouseDown={(e) => e.preventDefault()}
              onClick={addNote}
              style={{ top: pick.top, left: pick.left }}
              className="absolute z-10 flex -translate-x-1/2 cursor-pointer items-center gap-1 rounded-lg border border-line-strong bg-card px-2.5 py-1 text-xs font-medium shadow-pop hover:bg-sel animate-[pop-in_120ms_ease-out]"
            >
              <Highlighter className="h-3.5 w-3.5 text-warning" />
              {t('标注')}
            </button>
          )}
        </div>
        <aside
          aria-label={t('标注')}
          className="flex max-h-[45%] min-h-0 shrink-0 flex-col border-t bg-panel md:max-h-none md:w-[340px] md:border-t-0 md:border-l"
        >
          <div className="flex items-center gap-2 px-4 pt-3 pb-2 text-xs font-medium text-muted">
            <Highlighter className="h-3.5 w-3.5" />
            {t('标注')}
            {notes.length > 0 && <span className="text-subtle">{notes.length}</span>}
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 pb-3">
            {notes.length === 0 && (
              <p className="px-1 py-6 text-center text-xs leading-relaxed text-subtle">
                {t('选中左边的文字，点「标注」写下要改的地方')}
              </p>
            )}
            {notes.map((n, i) => (
              <div
                key={n.id}
                id={`review-note-${n.id}`}
                onClick={() => reveal(n)}
                className={cn(
                  'group flex flex-col gap-2 rounded-xl border bg-card p-2.5 transition-colors',
                  active === n.id ? 'border-warning/60' : 'border-line hover:border-line-strong',
                )}
              >
                <div className="flex items-start gap-2">
                  <span className="mt-px grid h-4.5 w-4.5 shrink-0 place-items-center rounded-full bg-warning/15 text-caption font-semibold text-warning">
                    {i + 1}
                  </span>
                  <span className="line-clamp-3 min-w-0 flex-1 border-l-2 border-warning/40 pl-2 text-xs leading-relaxed text-muted [overflow-wrap:anywhere]">
                    {n.quote}
                  </span>
                  <IconButton
                    icon={Trash2}
                    label={t('删除标注')}
                    tone="danger"
                    size="2xs"
                    onClick={(e) => {
                      e.stopPropagation()
                      setNotes((ns) => ns.filter((x) => x.id !== n.id))
                    }}
                  />
                </div>
                <Textarea
                  ref={(el) => {
                    if (el && focusId === n.id) {
                      el.focus()
                      setFocusId(null)
                    }
                  }}
                  value={n.comment}
                  onFocus={() => setActive(n.id)}
                  onChange={(e) => {
                    const v = e.target.value
                    setNotes((ns) => ns.map((x) => (x.id === n.id ? { ...x, comment: v } : x)))
                  }}
                  rows={2}
                  placeholder={t('这里要怎么改')}
                  aria-label={t('标注 {n} 的意见', { n: i + 1 })}
                  className="min-w-0 resize-none py-1.5 text-body"
                />
              </div>
            ))}
          </div>
          <div className="border-t px-3 py-3">
            <Textarea
              value={overall}
              onChange={(e) => setOverall(e.target.value)}
              rows={2}
              placeholder={t('整体意见（可选）')}
              aria-label={t('整体意见')}
              className="min-w-0 resize-none py-1.5 text-body"
            />
          </div>
        </aside>
      </div>
      <div className="flex items-center gap-2 border-t px-5 py-3">
        <span className="min-w-0 truncate text-xs text-subtle">
          {hasFeedback ? t('「修改」会把标注和意见交给 Agent 按意见调整') : t('没有要改的地方就点「确认」继续')}
        </span>
        <div className="ml-auto flex shrink-0 gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={!!busy || !hasFeedback}
            title={hasFeedback ? undefined : t('先标注要改的地方')}
            onClick={() => void submit(false)}
          >
            {busy === 'deny' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t('修改')}
          </Button>
          <Button size="sm" disabled={!!busy} onClick={() => void submit(true)}>
            {busy === 'allow' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t('确认')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
