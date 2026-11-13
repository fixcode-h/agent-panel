import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ClipboardCheck, Highlighter, Loader2, PanelRight, PictureInPicture2, Trash2 } from 'lucide-react'
import type { Attachment, TaskRequest } from '@shared/schema'
import { useData } from '@/lib/data'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { MODAL_HEADER, MODAL_TITLE, Modal, ModalButton, ModalHeader } from '@/components/ui/modal'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Select, Textarea } from '@/components/ui/input'
import { IconButton } from '@/components/ui/icon-button'
import { AgentAvatar } from '@/components/agents/AgentAvatar'
import { FrostBarBg } from '@/components/ui/frost'
import { Markdown } from './Markdown'
import { DocOutline } from '@/components/ui/doc-outline'
import { reviewFeedback } from '@/lib/review-feedback'
import { Segmented } from '@/components/ui/segmented'
import { ResizeHandle, usePaneWidth } from '@/components/ui/resize'
import { t } from '@shared/i18n'
import { OverallComposer, useLogFiles, type OverallTools } from './LogAttach'
import { useChosenColumn } from './review-table'
import { CompareSwitch, RejectButton } from './review-extras'

/** range：标在正文哪段文字上；点「改用这个方案」这类预设加的标注没有选区 */
type Note = { id: number; quote: string; comment: string; range?: Range; kind?: string }

/** 不用选文字就能加的标注（诊断报告的「改用方案 B」）：点一下加一条，内容预先填好 */
export interface PresetNote {
  label: string
  quote: string
  comment: string
  kind: string
}

/** 标注的种类（诊断报告的「疑问 / 改方案 / 补充信息」）：不给就是普通的「要改的地方」 */
export interface NoteKind {
  id: string
  label: string
  /** 写意见那一栏的提示 */
  placeholder: string
}

/** 诊断报告这类有多版的文档：每一版的标题、正文和状态；不是最新那版时只读 */
export interface ReviewVersion {
  key: string
  label: string
  detail: string
  /** 状态文字（已作废、已确认…）：看旧版时写在正文上面 */
  status?: string
  /** 下拉里按组列（诊断报告按阶段分组）；group 有值时列表里显示 short，选中后框里仍显示完整的 label */
  group?: string
  short?: string
  /** 正文前后多画的（诊断报告的决策卡、收起的「依据和背景」）：在标注范围里，选中文字照样能标 */
  lead?: ReactNode
  after?: ReactNode
  /** 和上一份的对比（诊断报告「对比上一份」，用户 2026-11-13 定）：有它时顶栏多一个「报告 / 对比上一份」切换 */
  compare?: ReactNode
}

/** 标注和整体意见的原始内容：诊断报告要按种类、按编号交回；files 是整体意见框里附的日志文件 */
export interface ReviewRaw {
  notes: { quote: string; comment: string; kind: string }[]
  overall: string
  files: Attachment[]
}

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
  kinds,
  versions,
  texts,
  readOnly,
  presets,
  cancel,
  top,
  supply,
  noApprove,
  feedbackFirst,
  attach,
  overallPlaceholder,
  initialVersion,
  overallTools,
  approveExtra,
  dock,
  reject,
}: {
  req: Pick<TaskRequest, 'id' | 'title' | 'detail'>
  agent?: { name: string; icon: string; cli: string }
  open: boolean
  onOpenChange: (open: boolean) => void
  /** notes / overall 是原始的标注和整体意见：诊断报告要按种类、按编号交回，不只是一段文字 */
  onAnswer: (allow: boolean, answer?: string, raw?: ReviewRaw) => Promise<void>
  kinds?: NoteKind[]
  /** 多版文档：最后一项是这次要审的（就是 req.detail），前面的只读 */
  versions?: ReviewVersion[]
  /** 按钮和提示的说法：诊断报告是「确认方案，开始修」「有疑问，再查」 */
  texts?: { approve: string; revise: string; hintApprove: string; hintRevise: string }
  /** 只看不审（已经确认过的报告） */
  readOnly?: boolean
  /** 右栏上方的快捷标注按钮（只在能审的时候出现） */
  presets?: PresetNote[]
  /**
   * 底部的「取消」（诊断报告：这次不修了）：先弹确认框，确认后调 onCancel（带上整体意见），成功就关掉弹窗。
   * 右上角的关闭只是收起弹窗、之后还能再审，和它不是一回事
   */
  cancel?: {
    label: string
    title: string
    /** 确认框正文：诊断报告列出面板查到的临时日志（要在打开时现查，见 onAsk） */
    description: ReactNode
    /** 正文下面的勾选项（要一起删的新文件、修复要不要撤掉） */
    extra?: ReactNode
    confirm: string
    /** 确认框打开时调用：现查要列出来的东西 */
    onAsk?: () => void
    onCancel: (overall: string) => Promise<void>
  }
  /**
   * 正文上方吸顶的一条（诊断报告的阶段条）：传函数时拿到正在看的那一版（版本的 key）和切版本的 show，
   * 阶段条点已完成的一步就切到那一步的报告
   */
  top?: ReactNode | ((key: string, show: (key: string) => void) => ReactNode)
  /**
   * 「交日志」这类按钮（诊断报告：贴日志让它接着分析）：整体意见的文字和附件交给 onSupply。
   * primary：它是主按钮（等你复现、验证）；否则是次按钮，写了整体意见或附了文件才能点
   */
  supply?: { label: string; primary?: boolean; hint: string; onSupply: (raw: ReviewRaw) => Promise<void> }
  /** 不放「确认」按钮（等你复现时只有交日志和提疑问） */
  noApprove?: boolean
  /** 有标注时「修改」变成主按钮、「确认」退成次要（诊断报告：标了疑问就是要接着探讨） */
  feedbackFirst?: boolean
  /** 整体意见框用对话的输入框：能引入日志文件、图片（粘贴、拖进来、点「+」），大文件引用路径、小文件拷一份 */
  attach?: boolean
  overallPlaceholder?: string
  /** 打开时先看哪一版（versions 的 key）：对话里点某一份报告的卡片打开的就是那一份；之后换了请求仍回到最新 */
  initialVersion?: string
  /** 整体意见框上面多放的（诊断报告「面板自己取日志」）：把日志文件引用和起始行填进整体意见框 */
  overallTools?: (tools: OverallTools) => ReactNode
  /** 「确认」按钮旁边多放的（诊断报告「后面几步没有要注意的就自动通过」）：能审、有确认按钮时才画 */
  approveExtra?: ReactNode
  /**
   * 能停靠到右栏（诊断报告，分析稿 U7）：docked 时不画弹窗外壳，整块放进任务页右栏的页签里，
   * 审方案时能同时翻对话、点开文件；toggle 在弹窗和右栏之间切换（宽屏才有右栏，canDock 为假时不给按钮）
   */
  dock?: { docked: boolean; canDock: boolean; toggle: () => void; slot: HTMLElement | null }
  /**
   * 「不认同」这类按钮（诊断报告根因页「不认同，推翻重查」，用户 2026-11-13 定）：和「修改」一样要有标注或意见，
   * 但交回去的意思是推翻，不是提问。次要按钮，放在「修改」前面
   */
  reject?: { label: string; hint: string; onReject: (raw: ReviewRaw) => Promise<void> }
}) {
  const { agents } = useData()
  // Markdown 按引用比较 teamNames，这里稳定下来，标注时父组件重画不会让文档重新解析（重新解析会让已有标注的位置失效）
  const teamNames = useMemo(() => new Set(agents.map((a) => a.name)), [agents])
  const scrollRef = useRef<HTMLDivElement>(null)
  const docRef = useRef<HTMLDivElement>(null)
  // 候选方案表撑满、选定那一列整列上色（分析稿 U7）
  useChosenColumn(docRef)
  const seq = useRef(0)
  const [notes, setNotes] = useState<Note[]>([])
  const [overall, setOverall] = useState('')
  const [active, setActive] = useState<number | null>(null)
  const [focusId, setFocusId] = useState<number | null>(null)
  // 选中文字后浮在选区上方的「标注」按钮，位置相对滚动区
  const [pick, setPick] = useState<{ range: Range; quote: string; top: number; left: number } | null>(null)
  const [busy, setBusy] = useState<'' | 'allow' | 'deny' | 'supply' | 'reject'>('')
  // 看报告还是看和上一份的对比：换版本时回到报告
  const [cmp, setCmp] = useState(false)
  // 换版本时文档重画，旧版本上画的标注位置对不上：切到旧版先不显示标注；回到看报告
  const showVer = (key: string) => (setVer(key), setPick(null), setCmp(false))
  const logs = useLogFiles()
  // 正文和标注栏之间能拖动调宽（用户 2026-11-05 要的）：记在本机，所有审阅弹窗共用一个宽度
  // 上限按弹窗里这一行的宽度算，正文至少留 360px
  const rowRef = useRef<HTMLDivElement>(null)
  const notePane = usePaneWidth(
    'review-notes',
    340,
    260,
    () => (rowRef.current?.clientWidth ?? window.innerWidth) - 360,
  )
  const resetLogs = logs.reset
  const [cancelAsk, setCancelAsk] = useState(false)
  // 标注栏默认展开（用户 2026-11-13 定：默认不收起）；没有要保留的内容时可以手动收成一条窄边（分析稿 U7），
  // 加了标注、写了意见、附了日志就不能收。在等日志的几步（supply.primary：等你复现、验证）整体意见框是主要输入，也不能收
  const [noteOpen, setNoteOpen] = useState(true)
  const docked = !!dock?.docked
  // 多版时看的是哪一版：默认最新那版（要审的）；旧版只读，不能标注
  const [ver, setVer] = useState(initialVersion ?? '')
  // 只在打开时用一次：之后来了新一版（换了请求）照旧回到最新那版
  const firstVer = useRef(initialVersion)
  const shown = versions?.find((v) => v.key === ver) ?? versions?.at(-1)
  const old = !!versions && !!shown && shown !== versions.at(-1)
  const locked = readOnly || old
  const detail = shown?.detail ?? req.detail
  const comparing = cmp && !!shown?.compare

  // 换了一个请求（退回后 Agent 改完又来确认）时标注从头开始
  useEffect(() => {
    setNotes([])
    setOverall('')
    setPick(null)
    setActive(null)
    setVer(firstVer.current ?? '')
    firstVer.current = undefined
    resetLogs()
  }, [req.id, resetLogs])

  useEffect(() => {
    if (!canHighlight() || !open || old) return
    const all = new Highlight(...notes.flatMap((n) => (n.range ? [n.range] : [])))
    const cur = notes.find((n) => n.id === active)
    CSS.highlights.set('review-note', all)
    if (cur?.range) CSS.highlights.set('review-note-active', new Highlight(cur.range))
    else CSS.highlights.delete('review-note-active')
    return () => {
      CSS.highlights.delete('review-note')
      CSS.highlights.delete('review-note-active')
    }
  }, [notes, active, open, old])

  const readSelection = () => {
    if (locked) return setPick(null)
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
    setNotes((ns) => [...ns, { id, quote: pick.quote, comment: '', range: pick.range, kind: kinds?.[0]?.id }])
    setActive(id)
    setFocusId(id)
    setPick(null)
    window.getSelection()?.removeAllRanges()
  }

  // 快捷标注：不用选文字，加一条预先填好的（例如「改用方案 B」），同一个按钮只加一次
  const addPreset = (p: PresetNote) => {
    if (notes.some((n) => n.quote === p.quote && n.kind === p.kind)) return
    const id = ++seq.current
    setNotes((ns) => [...ns, { id, quote: p.quote, comment: p.comment, kind: p.kind }])
    setActive(id)
    setFocusId(id)
  }

  // 点到已标注的文字：右栏对应那条亮起来
  const onDocClick = (e: React.MouseEvent) => {
    if (!notes.length || !window.getSelection()?.isCollapsed) return
    const pos = document.caretRangeFromPoint?.(e.clientX, e.clientY)
    if (!pos) return
    const hit = [...notes].reverse().find((n) => {
      try {
        return !!n.range?.isPointInRange(pos.startContainer, pos.startOffset)
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
    if (!box || !n.range) return
    const r = n.range.getBoundingClientRect()
    const b = box.getBoundingClientRect()
    if (r.top < b.top || r.bottom > b.bottom)
      box.scrollTo({ top: box.scrollTop + r.top - b.top - b.height / 3, behavior: 'smooth' })
  }

  // 整体意见框是对话输入框时，文件、图片卡片在文字里是标记：交出去前换成「@路径」
  const said = attach ? logs.plain(overall) : overall
  const hasFeedback = notes.length > 0 || !!said.trim()
  const hasLogs = !!said.trim() || logs.list.length > 0
  const noteKeep = notes.length > 0 || hasLogs || !!supply?.primary
  const notesShown = noteOpen || noteKeep
  // 收起时快捷标注（「改用方案 B」）挪到底栏左边，点了加一条标注、标注栏跟着展开
  const quick = presets && presets.length > 0 && !locked ? presets : []
  const raw = (): ReviewRaw => ({
    notes: notes.map((n) => ({ quote: n.quote, comment: n.comment, kind: n.kind ?? '' })),
    overall: said,
    files: attach ? logs.list : [],
  })
  // 有标注（feedbackFirst）或在等日志（supply.primary）时，主按钮换人。补充信息也算（用户 2026-11-13 定：
  // 补充了信息就是要它据此重出一版再评估，不是附带一句就确认）
  const revisePrimary = !!feedbackFirst && notes.length > 0 && !supply?.primary
  const submit = async (allow: boolean | 'supply' | 'reject') => {
    if (busy || logs.busy) return
    setBusy(allow === 'supply' ? 'supply' : allow === 'reject' ? 'reject' : allow ? 'allow' : 'deny')
    try {
      if (allow === 'supply') await supply?.onSupply(raw())
      else if (allow === 'reject') await reject?.onReject(raw())
      else await onAnswer(allow, allow ? undefined : reviewFeedback(notes, said), raw())
      onOpenChange(false)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  // 多版时用下拉选看哪一版（用户 2026-11-05：不要把所有版本都排在正文上面）。
  // 有分组时只列正在看的那一组（诊断报告就是正在看的那一步，用户 2026-11-07 要求不把所有步骤都列出来）：
  // 换步骤靠阶段条，下拉只管这一步交了几版；这一步只有一版就不出下拉。组里新的在上
  const same = (versions ?? []).filter((v) => (v.group ?? '') === (shown?.group ?? ''))
  const picker = same.length > 1 && (
    <Select
      size="xs"
      aria-label={t('版本')}
      value={shown?.key ?? ''}
      onChange={(e) => showVer(e.target.value)}
      options={[...same].reverse().map((v) => {
        const latest = v === versions?.at(-1)
        const mark = (x: string) => (latest ? t('{label}（最新）', { label: x }) : x)
        return { value: v.key, label: mark(v.label), short: v.short && mark(v.short), group: v.group }
      })}
      className="w-48 shrink-0"
    />
  )

  // 「报告 / 对比上一份」：这一份有上一份可比时才出
  const tools = (shown?.compare || picker) && (
    <>
      {shown?.compare && <CompareSwitch on={comparing} onChange={(v) => (setCmp(v), setPick(null))} />}
      {picker}
    </>
  )

  const who = agent && (
    <span className="hidden min-w-0 items-center gap-1.5 text-footnote text-subtle sm:flex">
      <AgentAvatar icon={agent.icon} cli={agent.cli} size="xs" />
      <span className="truncate">{agent.name}</span>
    </span>
  )
  // 弹窗和右栏之间切换：和对话的「转成弹窗」同一个图标；停靠用右栏的图标（和标题栏的右栏开关一样）
  const dockBtn = dock && (dock.docked || dock.canDock) && (
    <ModalButton
      icon={dock.docked ? PictureInPicture2 : PanelRight}
      label={dock.docked ? t('转成弹窗') : t('停靠到右栏')}
      onClick={dock.toggle}
    />
  )
  const body = (
    <>
      {docked ? (
        // 停靠在右栏时不在 Dialog 里，不能用 ModalHeader（它的标题是 Dialog.Title）；样子和弹窗标题栏一样
        <header className={MODAL_HEADER}>
          <ClipboardCheck className="h-3.5 w-3.5 shrink-0 text-warning" />
          <h2 className={MODAL_TITLE} title={req.title}>
            {req.title}
          </h2>
          <span className="flex-1" />
          {!top && tools}
          {dockBtn}
        </header>
      ) : (
        <ModalHeader
          icon={ClipboardCheck}
          iconClass="text-warning"
          title={req.title}
          aside={!top && tools}
          actions={dockBtn || undefined}
        >
          {who}
        </ModalHeader>
      )}
      <div ref={rowRef} className={cn('flex min-h-0 flex-1 flex-col', !docked && 'md:flex-row')}>
        {/* 套一层 relative：标题目录浮在滚动区右边、不跟着滚 */}
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <div
            ref={scrollRef}
            // overflow-x 隐藏：吸顶条的毛玻璃底左右伸出去，靠这里裁到正好铺满滚动区（FrostBarBg）
            className={cn(
              'relative min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-5 py-4',
              !docked && 'md:px-8 md:py-6',
            )}
            onMouseUp={readSelection}
            onKeyUp={readSelection}
            onScroll={(e) => {
              // overflow-x 隐藏的滚动区照样能被聚焦、scrollIntoView 横向滚开（展开「依据和背景」时整块正文往左错一截），拉回来
              if (e.currentTarget.scrollLeft) e.currentTarget.scrollLeft = 0
              if (pick) setPick(null)
            }}
          >
            {top && (
              // 吸在滚动区顶上（top 取负的上内边距：吸顶按滚动区的内容框算，不抵掉内边距会离顶边留一截），样式和对话的回复头一样是毛玻璃通栏（用户 2026-11-06 要求）；
              // 放在 docRef 外面，选中文字标注时不会把阶段名选进去
              // 版本下拉放在这条的最右边（用户 2026-11-06 要求）
              <div
                className={cn(
                  'frost-bar sticky -top-4 z-20 [--frost-bg:var(--c-modal-bg)] -mt-4 mb-3 flex items-center gap-3 py-2.5 select-none',
                  // 停靠在右栏时窄：阶段条和版本下拉放不下一行就折行
                  docked ? 'flex-wrap' : 'md:-top-6 md:-mt-6',
                )}
              >
                <FrostBarBg />
                <div className="min-w-0 flex-1">{typeof top === 'function' ? top(shown?.key ?? '', showVer) : top}</div>
                {tools}
              </div>
            )}
            {/* 正文随弹窗宽度铺满（用户 2026-11-06 要求自适应，不再限 820px 窄栏） */}
            {/* 对比放在 docRef 外面：选中对比里的文字不加标注（标注要对着报告原文）。
                报告只藏起来不卸载：卸载了已有标注的选区就对不上了 */}
            {comparing && shown?.compare}
            <div ref={docRef} onClick={onDocClick} data-review-doc className={cn(comparing && 'hidden')}>
              {shown?.status && old && <p className="mb-3 text-xs text-subtle">{shown.status}</p>}
              {shown?.lead}
              {detail ? (
                <Markdown key={shown?.key} text={detail} teamNames={teamNames} />
              ) : (
                !shown?.lead && <p className="text-body text-subtle">{t('这一步没有输出内容')}</p>
              )}
              {shown?.after}
            </div>
            {pick && (
              <button
                type="button"
                // 按下时不让选区丢掉，松开再加标注
                onMouseDown={(e) => e.preventDefault()}
                onClick={addNote}
                style={{ top: pick.top, left: pick.left }}
                className="absolute z-30 flex -translate-x-1/2 cursor-pointer items-center gap-1 rounded-lg border border-line-strong bg-card px-2.5 py-1 text-xs font-medium shadow-pop hover:bg-sel animate-[pop-in_120ms_ease-out]"
              >
                <Highlighter className="h-3.5 w-3.5 text-warning" />
                {t('标注')}
              </button>
            )}
          </div>
          <DocOutline scrollEl={scrollRef} className="right-2" />
        </div>
        {!notesShown ? (
          // 收成一条：宽屏是右边一道窄边（竖着写「标注」），窄屏和停靠在右栏时是底下一行
          <button
            type="button"
            data-notes-folded
            aria-label={t('展开标注栏')}
            title={t('展开标注栏：选中左边的文字可以标注，也可以写整体意见')}
            onClick={() => setNoteOpen(true)}
            className={cn(
              'flex shrink-0 cursor-pointer items-center gap-2 border-t bg-panel px-4 py-2 text-xs font-medium text-muted hover:bg-hover hover:text-fg',
              !docked && 'md:w-9 md:flex-col md:border-t-0 md:border-l md:px-0 md:py-3',
            )}
          >
            <Highlighter className="h-3.5 w-3.5 shrink-0" />
            <span className={cn(!docked && 'md:[writing-mode:vertical-rl]')}>{t('标注')}</span>
            <span className={cn('ml-auto truncate text-subtle', !docked && 'md:hidden')}>
              {t('选中文字标注，或写整体意见')}
            </span>
          </button>
        ) : (
          <aside
            aria-label={t('标注')}
            style={{ '--note-w': `${notePane.width}px` } as React.CSSProperties}
            className={cn(
              'relative flex max-h-[45%] min-h-0 shrink-0 flex-col border-t bg-panel',
              !docked && 'md:max-h-none md:w-(--note-w) md:max-w-[calc(100%-320px)] md:border-t-0 md:border-l',
            )}
          >
            {!docked && <ResizeHandle pane={notePane} label={t('拖动调整标注栏宽度')} className="hidden md:block" />}
            <div className="flex items-center gap-2 px-4 pt-3 pb-2 text-xs font-medium text-muted">
              <Highlighter className="h-3.5 w-3.5" />
              {t('标注')}
              {notes.length > 0 && <span className="text-subtle">{notes.length}</span>}
              {/* 没有要保留的内容时能收回成一条 */}
              {!noteKeep && (
                <IconButton
                  icon={ChevronLeft}
                  label={t('收起标注栏')}
                  size="2xs"
                  tone="bare"
                  onClick={() => setNoteOpen(false)}
                  className={cn('ml-auto', !docked && 'md:rotate-180')}
                />
              )}
            </div>
            {presets && presets.length > 0 && !locked && (
              <div className="flex flex-wrap gap-1.5 px-3 pb-2" data-review-presets>
                {presets.map((p) => (
                  <Button key={p.label} size="sm" variant="secondary" onClick={() => addPreset(p)}>
                    {p.label}
                  </Button>
                ))}
              </div>
            )}
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
                  {kinds && (
                    <Segmented
                      size="sm"
                      value={n.kind ?? kinds[0].id}
                      onChange={(v) => setNotes((ns) => ns.map((x) => (x.id === n.id ? { ...x, kind: v } : x)))}
                      label={t('标注 {n} 的种类', { n: i + 1 })}
                      options={kinds.map((k) => ({ id: k.id, label: k.label }))}
                      className="self-start"
                    />
                  )}
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
                    placeholder={kinds?.find((k) => k.id === n.kind)?.placeholder ?? t('这里要怎么改')}
                    aria-label={t('标注 {n} 的意见', { n: i + 1 })}
                    className="min-w-0 resize-none py-1.5 text-body"
                  />
                </div>
              ))}
            </div>
            <div className="border-t px-3 py-3">
              {!locked && overallTools?.({ fill: setOverall, refer: logs.refer })}
              {attach ? (
                <OverallComposer
                  value={overall}
                  onChange={setOverall}
                  logs={logs}
                  placeholder={overallPlaceholder ?? t('整体意见（可选）')}
                  disabled={locked}
                />
              ) : (
                <Textarea
                  value={overall}
                  onChange={(e) => setOverall(e.target.value)}
                  rows={2}
                  placeholder={overallPlaceholder ?? t('整体意见（可选）')}
                  aria-label={t('整体意见')}
                  disabled={locked}
                  className="min-w-0 resize-none py-1.5 text-body"
                />
              )}
            </div>
          </aside>
        )}
      </div>
      {/* 窄（停靠在右栏、手机宽度）时提示单独一行、按钮换到下一行：一行放不下时主按钮会被挤出窗口（分析稿 U9） */}
      <div
        className={cn(
          'flex items-center gap-2 border-t px-5 py-3',
          docked ? 'flex-wrap px-4' : 'max-md:flex-wrap max-md:px-4',
        )}
      >
        {!notesShown &&
          quick.map((p) => (
            <Button key={p.label} size="sm" variant="secondary" className="shrink-0" onClick={() => addPreset(p)}>
              {p.label}
            </Button>
          ))}
        <span
          className={cn(
            'min-w-0 truncate text-xs text-subtle',
            docked ? 'basis-full whitespace-normal' : 'max-md:basis-full max-md:whitespace-normal',
          )}
        >
          {locked
            ? readOnly
              ? t('这一版已经处理过了，只能查看')
              : t('这是旧的一版，只能查看；切回最新一版再标注')
            : supply?.primary
              ? supply.hint
              : hasFeedback
                ? (texts?.hintRevise ?? t('「修改」会把标注和意见交给 Agent 按意见调整'))
                : (texts?.hintApprove ?? t('没有要改的地方就点「确认」继续'))}
        </span>
        {/* 窄时按钮组也能折行，「自动通过」勾选框独占一行：不然多出的勾选框会把主按钮挤出屏幕 */}
        <div
          className={cn(
            'ml-auto flex shrink-0 gap-2',
            docked ? 'basis-full flex-wrap justify-end' : 'max-md:basis-full max-md:flex-wrap max-md:justify-end',
            locked && 'hidden',
          )}
        >
          {cancel && (
            <Button
              size="sm"
              variant="ghost"
              disabled={!!busy}
              onClick={() => {
                cancel.onAsk?.()
                setCancelAsk(true)
              }}
            >
              {cancel.label}
            </Button>
          )}
          {reject && (
            <RejectButton
              {...reject}
              ready={hasFeedback}
              busy={busy === 'reject'}
              disabled={!!busy}
              onClick={() => void submit('reject')}
            />
          )}
          {supply && !supply.primary && (
            <Button
              size="sm"
              variant="secondary"
              disabled={!!busy || logs.busy || !hasLogs}
              title={hasLogs ? supply.hint : t('先在整体意见里贴日志，或引入日志文件')}
              onClick={() => void submit('supply')}
            >
              {busy === 'supply' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {supply.label}
            </Button>
          )}
          <Button
            size="sm"
            variant={revisePrimary ? 'primary' : 'secondary'}
            disabled={!!busy || !hasFeedback}
            title={hasFeedback ? undefined : t('先标注要改的地方')}
            onClick={() => void submit(false)}
            className={cn(revisePrimary && 'order-last')}
          >
            {busy === 'deny' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {texts?.revise ?? t('修改')}
          </Button>
          {!noApprove && approveExtra && (
            <div
              className={cn(
                'flex items-center',
                docked ? 'basis-full justify-end' : 'max-md:basis-full max-md:justify-end',
              )}
            >
              {approveExtra}
            </div>
          )}
          {!noApprove && (
            <Button
              size="sm"
              variant={revisePrimary || supply?.primary ? 'secondary' : 'primary'}
              disabled={!!busy || logs.busy}
              title={revisePrimary ? t('还有没交回的标注：确认后它就不再回应这些标注') : undefined}
              onClick={() => void submit(true)}
            >
              {busy === 'allow' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {texts?.approve ?? t('确认')}
            </Button>
          )}
          {supply?.primary && (
            <Button
              size="sm"
              disabled={!!busy || logs.busy || !hasLogs}
              title={hasLogs ? undefined : t('先在整体意见里贴日志，或引入日志文件')}
              onClick={() => void submit('supply')}
            >
              {busy === 'supply' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {supply.label}
            </Button>
          )}
        </div>
      </div>
      {cancel && (
        <ConfirmDialog
          open={cancelAsk}
          onOpenChange={setCancelAsk}
          title={cancel.title}
          description={cancel.description}
          extra={cancel.extra}
          confirmText={cancel.confirm}
          onConfirm={async () => {
            try {
              await cancel.onCancel(said)
              setCancelAsk(false)
              onOpenChange(false)
            } catch (e) {
              toast.error((e as Error).message)
            }
          }}
        />
      )}
    </>
  )
  // 停靠时画进任务页右栏的页签（Portal）：组件本身还挂在任务页顶层，切换弹窗 / 右栏不丢标注和意见
  if (docked)
    return dock.slot
      ? createPortal(
          <section aria-label={req.title} data-review-docked className="flex min-h-0 flex-1 flex-col bg-(--c-modal-bg)">
            {body}
          </section>,
          dock.slot,
        )
      : null
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={null} bare size="xl">
      {body}
    </Modal>
  )
}
