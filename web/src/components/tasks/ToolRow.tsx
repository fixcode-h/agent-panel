import { useEffect, useMemo, useState } from 'react'
import {
  ArrowUpRight,
  Bot,
  ChevronRight,
  FileText,
  FoldVertical,
  Globe,
  Loader2,
  Maximize2,
  PencilLine,
  Plug,
  Search,
  Sparkles,
  Terminal,
  Wrench,
} from 'lucide-react'
import type { Task, ToolUse } from '@shared/schema'
import { cn } from '@/lib/utils'
import { fmtDuration, groupTools, toolVerb, toolView, type SendTarget, type ToolView } from '@/lib/tasks'
import { useNow } from '@/lib/useNow'
import { useChildOpen, useJobOpen, useRunToolOpen } from './child-open'
import { api } from '@/lib/api'
import { t } from '@shared/i18n'
import { useFileOpen } from './FileDialog'
import { DiffDialog } from './DiffDialog'
import { DIFF_GUTTER, DIFF_HUNK, DIFF_TONE } from '@/components/ui/diff-tone'
import { CommandDialog, OutputDialog } from './ToolDialog'
import { RunDialog } from './RunCard'
import { PeerLine } from './PeerMessage'
import { AlertRow } from './AlertRow'
import { makeAlert } from '@shared/alerts'

/** 命令还在跑时行内只跟这么多行：再长就把对话撑长了，完整输出去命令行窗口看 */
const LIVE_ROWS = 8

/** 读取的工具行里 label 是不是一个能打开的文件：像路径，而不是「读取 3 个文件」这类说明 */
function isFilePath(label: string) {
  const s = label.trim()
  if (!s || /\s/.test(s)) return false
  return /[\\/]/.test(s) || /\.[A-Za-z0-9]{1,10}$/.test(s)
}

/** 哪些工具的输出值得在独立窗口里看：命令、改动、读取的文件已经有自己的窗口 */
function hasWindow(tool: ToolUse) {
  if (tool.kind === 'run' || tool.kind === 'edit') return true
  // 搜索、网页、MCP（other）的输出经常很长，展开会把对话挤满
  return tool.kind === 'search' || tool.kind === 'web' || tool.kind === 'other'
}

export const toolIcon = {
  read: FileText,
  edit: PencilLine,
  run: Terminal,
  search: Search,
  web: Globe,
  skill: Sparkles,
  agent: Bot,
  compact: FoldVertical,
  other: Wrench,
}

/**
 * 工具图标按种类上色（组件库「过程行」）：一眼分得出读、搜、改、派人；
 * 读文件、命令这类最常见的保持灰色，不然一屏全是彩色。搜索、网页借代码高亮里的函数蓝，不另造颜色
 */
export const toolTone: Record<keyof typeof toolIcon, string> = {
  read: 'text-subtle',
  edit: 'text-success',
  run: 'text-subtle',
  search: 'text-(--hl-func)',
  web: 'text-(--hl-func)',
  skill: 'text-peer',
  agent: 'text-peer',
  compact: 'text-subtle',
  other: 'text-subtle',
}

interface DiffLine {
  kind: 'add' | 'del' | 'ctx' | 'hunk'
  text: string
  old?: number
  new?: number
}

/** 解析 unified diff（也接受没有行号的 @@ @@ 段头）：每行带上改前、改后的行号 */
export function parseDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = []
  let o = 0
  let n = 0
  let numbered = false
  for (const raw of diff.replace(/\n$/, '').split('\n')) {
    if (raw.startsWith('+++') || raw.startsWith('---') || raw.startsWith('diff ') || raw.startsWith('index ')) continue
    const h = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/)
    if (h) {
      o = Number(h[1])
      n = Number(h[2])
      numbered = true
      out.push({ kind: 'hunk', text: h[3].trim() })
      continue
    }
    if (raw.startsWith('@@')) {
      numbered = false
      if (out.length) out.push({ kind: 'hunk', text: '' })
      continue
    }
    const c = raw[0]
    const text = raw.slice(1)
    if (c === '+') out.push({ kind: 'add', text, new: numbered ? n++ : undefined })
    else if (c === '-') out.push({ kind: 'del', text, old: numbered ? o++ : undefined })
    else
      out.push({
        kind: 'ctx',
        text: c === ' ' ? text : raw,
        old: numbered ? o++ : undefined,
        new: numbered ? n++ : undefined,
      })
  }
  return out
}

/** 文件改动：和 Claude Code 一样按行显示，左边改前 / 改后的行号，新增绿色、删除红色 */
export function DiffView({ diff }: { diff: string }) {
  const rows = useMemo(() => parseDiff(diff), [diff])
  const numbered = rows.some((r) => r.old !== undefined || r.new !== undefined)
  return (
    <div className="max-h-[420px] overflow-auto font-mono text-[0.75rem] leading-[1.6]">
      <table className="w-full border-collapse">
        <tbody>
          {rows.map((r, i) => {
            if (r.kind === 'hunk')
              return (
                <tr key={i}>
                  <td colSpan={numbered ? 4 : 2} className={DIFF_HUNK}>
                    {r.text || '⋯'}
                  </td>
                </tr>
              )
            const tone = DIFF_TONE[r.kind]
            return (
              <tr key={i} className={tone.row}>
                {numbered && (
                  <>
                    <td className={cn(DIFF_GUTTER, 'align-top', tone.gutter)}>{r.old ?? ''}</td>
                    <td className={cn(DIFF_GUTTER, 'align-top', tone.gutter)}>{r.new ?? ''}</td>
                  </>
                )}
                <td className={cn('w-5 pl-2 align-top select-none', tone.sign)}>
                  {r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : ' '}
                </td>
                <td className="pr-3 whitespace-pre-wrap text-fg/90 [overflow-wrap:anywhere]">{r.text || ' '}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/**
 * 展开后的 IN / OUT 一段（照 Claude Code）：左边一列窄标签（OUT 下面跟行数），右边是正文；
 * 正文用次一级的文字色，不和上面的工具名、对话正文抢眼。标签列定宽，正文列长文本自己换行
 */
/** 一段 IN / OUT 的版式：标签列 3rem（放得下「正在输出」）+ 正文列 */
const BLOCK = 'grid grid-cols-[3rem_minmax(0,1fr)] gap-x-2.5 px-3 py-2'

function BlockLabel({ label, aside }: { label: string; aside?: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 pt-[0.1875rem]">
      <span className="font-mono text-[0.625rem] leading-none font-medium tracking-[0.08em] text-subtle">{label}</span>
      {aside}
    </div>
  )
}

function Block({
  label,
  text,
  tone,
  aside,
}: {
  label: string
  text: string
  tone?: 'danger'
  /** 标签右边的状态，例如输出行数 */
  aside?: React.ReactNode
}) {
  return (
    <div className={BLOCK}>
      <BlockLabel label={label} aside={aside} />
      <pre
        className={cn(
          'max-h-[320px] min-w-0 overflow-auto font-mono text-[0.75rem] leading-[1.6] whitespace-pre-wrap [overflow-wrap:anywhere]',
          tone === 'danger' ? 'text-danger' : 'text-muted',
        )}
      >
        {text}
      </pre>
    </div>
  )
}

/** 行内放不下、要去窗口里看的那条：和展开区其它行的字号、悬停一致，不像一条普通文字链 */
function MoreLink({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full cursor-pointer items-center gap-1.5 px-3 py-2 text-left font-sans text-xs text-muted transition-colors hover:bg-hover hover:text-fg"
    >
      <Maximize2 className="h-3.5 w-3.5 shrink-0 text-subtle" />
      <span className="min-w-0 truncate">{label}</span>
      <ArrowUpRight className="ml-auto h-3.5 w-3.5 shrink-0 text-subtle" />
    </button>
  )
}

/**
 * 工具条目统一的一行（工具调用、子任务、面板推回的结果、子对话的提问都用它）：
 * 前面的图标和动作名、后面的结果和箭头点了是展开收起；中间的标题能打开窗口时（命令行、差异、文件、子任务、子对话）
 * 只有点标题文字才打开，没有窗口时标题也是展开收起
 */
export function RowShell({
  glyph,
  verb,
  badge,
  badgeClass,
  title,
  titleClass,
  detail,
  /**
   * 详情紧跟标题左对齐（占剩余宽度），而不是被标题挤到行尾；耗时仍在行的最右边。
   * 只给「详情只是说明文字、整行没有展开收起」的行用：详情区会挡掉点击（stopPropagation），
   * 用到有 onToggle 的行上就会让点详情不展开，违反「没有窗口的条目点哪里都展开收起」。
   * 传了 rowOpen 时详情区也算入口，不再挡点击
   */
  detailStart,
  ms,
  open,
  onToggle,
  onOpen,
  openTip,
  titleTip,
  failed,
  action,
  className,
  children,
  /**
   * 整行都是打开入口（子对话行、子任务行）：动作名、标题、详情和耗时点了都打开，有 hover 和手型。
   * 不传时行为完全不变——工具行、后台命令仍然点哪里都展开收起；行尾的 action 按钮
   * （终止）始终 stopPropagation，点它不会连带打开窗口
   */
  rowOpen,
  /** 行最左边的额外控件（子对话切换下拉），在图标和动作名之前 */
  leading,
  /**
   * 行自己的宽度当容器查询的基准：子对话行按这一行的实际宽度决定显示哪些补充信息，
   * 不能只看视口（右栏开着时 1280 的行只有 300 左右，1024 收着右栏时还有 700 多）
   */
  container,
  boxed,
}: {
  glyph: React.ReactNode
  verb?: React.ReactNode
  /** 动作名后面淡色的小标签（MCP 的服务名） */
  badge?: string
  /** 小标签换颜色（对话之间的消息按类型、报错标色） */
  badgeClass?: string
  title?: React.ReactNode
  titleClass?: string
  detail?: React.ReactNode
  detailStart?: boolean
  /** 跑了多久（毫秒）：显示在最右边，还在跑的每秒更新 */
  ms?: number
  open: boolean
  /** 不给就不能展开（没有可看的内容），点哪里都不动 */
  onToggle?: () => void
  onOpen?: () => void
  openTip?: string
  rowOpen?: () => void
  leading?: React.ReactNode
  container?: boolean
  /**
   * 保留卡片外框：要人处理的条目（等你选择的子对话提问）还是一块带框的卡片；
   * 其余过程行不画框，每行默认一层浅底的圆角块，相邻几行之间留一点间距（见 index.css 的 proc-list）
   */
  boxed?: boolean
  /** 标题被截断时悬停看全文：后台命令行用完整命令，优先于 openTip */
  titleTip?: string
  failed?: boolean
  /** 耗时后面的操作按钮（子任务的终止）：自己处理点击，不触发展开收起 */
  action?: React.ReactNode
  className?: string
  children?: React.ReactNode
}) {
  const toggle = onToggle
  // 整行打开优先（子对话行、子任务行没有展开收起）；其余行仍是整行点了展开
  const activate = rowOpen ?? toggle
  return (
    // 组件库「过程行」：不画框，默认一层浅底（用户要求底色常显，不只在悬停时出现），悬停再深一点；
    // 相邻的过程行之间不画分隔线，靠间距分开。失败靠图标和结果的红字表达，不再描红边
    <div
      className={cn(
        'min-w-0',
        !boxed && 'rounded-(--c-row-radius)',
        !boxed && 'bg-(--c-row-bg)',
        boxed && 'overflow-hidden rounded-(--c-row-radius) border',
        boxed && failed && 'border-danger/30',
        className,
      )}
    >
      {/* 整行点了是展开收起；标题是单独的按钮，点它只开窗口，不会同时展开。
          子对话行、子任务行把整行都变成打开入口（rowOpen）：动作名、详情和耗时也一起打开 */}
      <div
        onClick={activate}
        className={cn(
          'group flex w-full min-w-0 items-center py-1 pr-1 pl-2 text-[0.75rem] text-muted min-h-8',
          !boxed && 'rounded-(--c-row-radius)',
          boxed && 'px-2.5',
          container && '@container',
          // 整行打开的行左边多一个下拉：间距收一点，窄行里状态标签才不会被挤出容器
          rowOpen ? 'gap-1.5' : 'gap-2',
          activate && 'cursor-pointer transition-colors hover:bg-fg/[0.04] hover:text-fg',
        )}
      >
        {leading}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            activate?.()
          }}
          disabled={!activate}
          aria-expanded={toggle ? open : undefined}
          // 整行打开时动作名也是入口：读屏名用「打开子对话…」，title 留给标题按钮，
          // 界面检查靠 title 找标题，两个按钮都写会让它量错位置
          aria-label={rowOpen ? openTip : undefined}
          title={rowOpen ? undefined : toggle ? (open ? t('收起') : t('展开')) : undefined}
          className="flex shrink-0 items-center gap-2 text-left enabled:cursor-pointer"
        >
          {glyph}
          {verb && <span className="text-[0.8125rem] font-semibold whitespace-nowrap text-fg">{verb}</span>}
          {badge && (
            <span
              className={cn(
                'rounded px-1.5 py-px font-sans text-[0.6875rem] leading-4',
                badgeClass ?? 'bg-sel text-subtle',
              )}
            >
              {badge}
            </span>
          )}
        </button>
        {/* 标题只占自己文字的宽度：点标题后面的空白也是展开收起。
            详情左对齐时标题按内容宽度、上限 25%：1280 开着右栏再缩窗时一行只有 300 多像素，
            上限大了标题就会把状态标签挤出容器；代价是长标题在 1440 下也会被截短（悬停看全文） */}
        <span className={cn('flex min-w-0 items-center', detailStart ? 'max-w-[25%]' : 'flex-1')}>
          {title ? (
            onOpen ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onOpen()
                }}
                title={titleTip || openTip}
                // 只有整行打开的子对话行才用 openTip 当读屏名：别的行（接收消息、工具）标题本身就是名字，
                // 盖掉会让「已完成：合回原分支、标记完成」这类按名字找的入口定位不到
                aria-label={rowOpen ? openTip : undefined}
                className={cn(
                  'min-w-0 cursor-pointer truncate text-left font-mono text-[0.75rem] text-muted decoration-subtle underline-offset-2 hover:text-fg hover:underline',
                  titleClass,
                )}
              >
                {title}
              </button>
            ) : (
              <span className={cn('min-w-0 truncate font-mono text-[0.75rem]', titleClass)} title={titleTip}>
                {title}
              </span>
            )
          ) : null}
        </span>
        {/* 详情左对齐：从标题后面开始排，和标题之间隔一道竖线。普通行里这段只是说明文字，
            点它不触发任何动作（哪怕整行带展开）；整行打开的行（rowOpen）里它和标题一样属于入口 */}
        {detail && detailStart ? (
          <span
            className="flex min-w-0 flex-1 items-center border-l border-line-strong pl-2"
            // 整行打开时详情也属于入口（子对话行、子任务行）：不拦点击，点了直接冒泡到行上
            onClick={rowOpen ? undefined : (e) => e.stopPropagation()}
          >
            {detail}
          </span>
        ) : (
          detail
        )}
        {ms !== undefined && (
          <span className="shrink-0 text-[0.6875rem] text-subtle tabular-nums">{fmtDuration(ms)}</span>
        )}
        {action && (
          <span className="-my-1 flex shrink-0 items-center" onClick={(e) => e.stopPropagation()}>
            {action}
          </span>
        )}
        {toggle && (
          <ChevronRight
            className={cn(
              'h-3.5 w-3.5 shrink-0 text-subtle opacity-0 transition group-hover:opacity-100',
              open && 'rotate-90 opacity-100',
            )}
          />
        )}
      </div>
      {open &&
        (boxed ? (
          children
        ) : (
          // 展开的内容缩进到动作名下面，是嵌在过程行浅底里的一块代码底色（不再是框里套框）；
          // 内容自带的顶线去掉，外圈一道很淡的细线
          <div className="mt-0.5 mr-2 mb-2 ml-[1.8125rem] min-w-0 overflow-hidden rounded-md bg-(--code-bg) shadow-[inset_0_0_0_1px_var(--pop-edge)] [&>*:first-child]:border-t-0">
            {children}
          </div>
        ))}
    </div>
  )
}

/**
 * 一次工具调用：收起时一行（图标、命令或文件、结果摘要），点开参照 Claude Code：
 * 命令显示 IN / OUT，改文件显示 diff，读文件和其他工具显示参数和输出
 */
export function ToolRow({
  tool: raw,
  task,
}: {
  tool: ToolUse
  /** 差异窗口只用到这几样，不用把整个任务传进来 */
  task?: Pick<Task, 'id' | 'status' | 'changes' | 'jobs'>
}) {
  // 面板自己的工具按做了什么显示（新建子对话 + 名字），派出子任务的调用不单独显示；别的 MCP 工具名当动作
  const view = toolView(raw)
  if (view === null) return null
  // CLI 报的重试、失败：画成带底色的警告行，点开看是哪一类、怎么办（旧数据只有 failed 的提示行按正文归类）
  const alert =
    raw.alert ?? (raw.kind === 'other' && raw.failed && raw.name === t('提示') ? makeAlert('error', raw.label) : null)
  if (alert) return <AlertRow alert={alert} text={raw.label} />
  // 给另一个对话发消息：和收件方一样画成「→ 对方 + 类型 + 内容标题」
  if (view.send)
    return (
      <PeerLine
        dir="out"
        kind={view.send.kind}
        name={view.send.to}
        subject=""
        body={view.send.body}
        failed={raw.failed}
        running={raw.running || (raw.ms === undefined && !!raw.startedAt && task?.status === 'running')}
        childId={view.child}
        receipt={raw.output?.trim()}
        ms={raw.ms}
        at={raw.startedAt ? new Date(raw.startedAt).toISOString() : undefined}
      />
    )
  return <ToolLine view={view} task={task} />
}

/**
 * 一条消息里的一串工具调用：相邻几次把同一段话交给不同子对话的合成一行「发送消息」（见 groupTools），
 * 展开列出每个收件人
 */
export function ToolRows({
  tools,
  task,
}: {
  tools: ToolUse[]
  task?: Pick<Task, 'id' | 'status' | 'changes' | 'jobs'>
}) {
  return (
    <>
      {groupTools(tools).map((g, i) =>
        g.length === 1 ? <ToolRow key={i} tool={g[0]} task={task} /> : <SendGroupRow key={i} tools={g} task={task} />,
      )}
    </>
  )
}

function SendGroupRow({ tools, task }: { tools: ToolUse[]; task?: Pick<Task, 'status'> }) {
  const views = tools.map((x) => ({ tool: x, view: toolView(x) }))
  const send = views[0].view!.send!
  const targets: SendTarget[] = views.map(({ tool, view }) => ({
    name: view?.send?.to ?? '',
    ...(view?.child && { child: view.child }),
    ...(tool.output?.trim() && { receipt: tool.output.trim() }),
    ...(tool.failed && { failed: true }),
  }))
  const pending = (x: ToolUse) => x.running || (x.ms === undefined && !!x.startedAt && task?.status === 'running')
  const done = tools.filter((x) => x.ms !== undefined)
  return (
    <PeerLine
      dir="out"
      kind={send.kind}
      name={send.to}
      subject=""
      body={send.body}
      failed={tools.every((x) => x.failed)}
      running={tools.some(pending)}
      ms={done.length === tools.length ? Math.max(...done.map((x) => x.ms!)) : undefined}
      targets={targets}
    />
  )
}

/**
 * 推送时省掉了后半段的输出（outputCut）：打开窗口看全部时才去取全文，取到之前先显示已有的开头。
 * 没省的直接用原来的输出
 */
function useFullOutput(tool: ToolUse, taskId: string | undefined, want: boolean) {
  const cut = tool.outputCut
  const [full, setFull] = useState<{ key: string; text: string } | null>(null)
  const key = cut && taskId ? `${taskId}/${cut.msg}/${cut.i}` : ''
  useEffect(() => {
    if (!want || !key || !cut || !taskId || full?.key === key) return
    let live = true
    api
      .toolOutput(taskId, cut.msg, cut.i)
      .then((r) => live && setFull({ key, text: r.output }))
      .catch(() => {})
    return () => {
      live = false
    }
    // 只在要看、换了调用时取一次
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [want, key])
  return full?.key === key ? full.text : (tool.output ?? '')
}

function ToolLine({ view, task }: { view: ToolView; task?: Pick<Task, 'id' | 'status' | 'changes' | 'jobs'> }) {
  const { tool } = view
  const [open, setOpen] = useState(false)
  const [win, setWin] = useState<'' | 'run' | 'edit' | 'out' | 'plan'>('')
  const openFile = useFileOpen()
  const openJob = useJobOpen()
  const openChild = useChildOpen()
  const openRunPane = useRunToolOpen()
  const Icon = view.server ? Plug : (toolIcon[tool.kind] ?? Wrench)
  const verb = toolVerb(tool)
  // 还在等结果（任务还在跑、没有耗时）：每秒刷新已经用了多久，等子任务、长命令不再看着像卡住
  const pending = tool.ms === undefined && !!tool.startedAt && task?.status === 'running'
  // 放到后台的命令：调用本身马上就返回了，命令还在后台跑时照样转圈、走表，跑完面板把这一行换成真实的用时和结果
  const ids = view.job ? [view.job] : (view.jobs ?? [])
  const mine = ids.length ? (task?.jobs ?? []).filter((j) => ids.includes(j.id)) : []
  // 有结果之前一直转圈：任务上的后台命令列表还没推到（刚交出去、页面刚打开）也一样，不能先显示成完成
  const bg = mine.length > 0 || !!view.waiting
  // 申请的编译有几条：从最早开始跑的那条算；都还在排队就写「排队中」
  const starts = mine.map((j) => (j.startedAt ? Date.parse(j.startedAt) : 0)).filter(Boolean)
  const jobStart = starts.length ? Math.min(...starts) : 0
  const queued = bg && mine.every((j) => j.state === 'queued')
  const now = useNow(pending || bg)
  const diff = tool.kind === 'edit' ? tool.detail.match(/^(\+\d+)?\s*(-\d+)?$/) : null
  const input = tool.input?.trim() ?? ''
  const output = tool.output?.replace(/\s+$/, '') ?? ''
  // 后台命令行的标题是命令：被截断时悬停看完整命令，而不是「打开窗口」这类提示
  const titleTip = tool.name === t('后台命令') ? input || tool.label : undefined
  // 窗口里的完整输出：推送时省掉的后半段在打开窗口时取回来
  const fullOutput = useFullOutput(tool, task?.id, win === 'run' || win === 'out').replace(/\s+$/, '')
  const isDiff = tool.kind === 'edit' && /^[+\-@ ]/m.test(input)
  // 读取的文件：点文件名打开文件
  const file = tool.kind === 'read' && openFile && isFilePath(tool.label) ? tool.label.trim() : ''

  const glyph =
    tool.running || bg ? (
      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent-text" />
    ) : (
      <Icon
        className={cn(
          'h-3.5 w-3.5 shrink-0',
          tool.failed ? 'text-danger' : view.server ? 'text-subtle' : toolTone[tool.kind],
        )}
      />
    )
  const detail = diff ? (
    <span className="shrink-0 font-mono text-[0.75rem]">
      {diff[1] && <span className="text-success">{diff[1]}</span>}{' '}
      {diff[2] && <span className="text-danger">{diff[2]}</span>}
    </span>
  ) : queued ? (
    <span className="shrink-0 text-subtle">{t('排队中')}</span>
  ) : bg && !mine.length ? (
    <span className="shrink-0 text-subtle">{t('等结果')}</span>
  ) : (
    tool.detail && <span className={cn('shrink-0', tool.failed ? 'text-danger' : 'text-subtle')}>{tool.detail}</span>
  )
  // 「启动工作流」这一行点开什么：子对话面板里就地换成这次运行的视图（能返回），别的位置还是弹运行窗口
  const openRunView = openRunPane ? () => openRunPane(tool) : () => setWin('plan')
  // 点标题打开什么：子对话、这次运行、文件、命令行、差异，或者看完整输出的窗口
  // 后台命令窗口（run_background / request_build 那一行）：和运行区那一行打开的是同一个窗口，
  // 命令跑完、运行区那行消失以后，这里仍然能点到——事后回看最终输出和退出码靠它
  const bgJob = view.job && openJob && task?.id ? view.job : ''
  const target: { open: () => void; tip: string } | undefined = bgJob
    ? {
        open: () =>
          openJob?.({
            id: bgJob,
            command: input,
            // 先按还在跑画（窗口打开后立刻拉真实状态，拉到 done 就换成完成 + 退出码）
            state: 'running',
            startedAt: '',
          }),
        tip: t('打开命令行窗口'),
      }
    : file
      ? { open: () => openFile?.(file), tip: t('查看文件') }
      : view.child && openChild
        ? { open: () => openChild(view.child!), tip: t('在右栏打开子对话') }
        : view.startsRun && task?.id
          ? // 工作流也是一次对话：按节点铺开 Agent 的说明、思考和工具行，不是一段原始文本。
            // 子对话面板里点它就地把面板换成这次运行的视图（带返回），别的页面照旧弹运行窗口
            { open: openRunView, tip: t('打开这次运行的对话') }
          : tool.kind === 'run'
            ? { open: () => setWin('run'), tip: t('打开命令行窗口') }
            : tool.kind === 'edit'
              ? { open: () => setWin('edit'), tip: t('打开差异窗口') }
              : hasWindow(tool)
                ? { open: () => setWin('out'), tip: t('打开窗口') }
                : undefined
  // 行内展开时的输出：长的只留前一段，后面提示去窗口里看
  const short = output.length > 400 ? `${output.slice(0, 400).trimEnd()}…` : output
  // 命令还在跑：展开时只跟最新的几行，像终端一样往下走；跑完再按现有高度显示完整输出
  const live = !!tool.running && tool.kind === 'run'
  const liveRows = live ? output.trimEnd().split('\n') : []
  // 按行数截，不按 em 算高度：字号跟着设置变、某一行刚好折行时都不会切出半行，
  // 截掉的几行在上面用一行提示说明
  const liveTail = liveRows.slice(-LIVE_ROWS)
  const liveCut = liveRows.length > LIVE_ROWS

  return (
    <>
      <RowShell
        glyph={glyph}
        verb={verb}
        badge={view.server}
        title={tool.label}
        detail={detail}
        ms={bg ? (jobStart ? now - jobStart : undefined) : pending ? now - tool.startedAt! : tool.ms}
        open={open}
        onToggle={() => setOpen(!open)}
        onOpen={target?.open}
        openTip={target?.tip}
        titleTip={titleTip}
        failed={tool.failed}
      >
        {
          <div className="divide-y divide-pop-edge">
            {isDiff ? (
              <div className="relative">
                <DiffView diff={input} />
                <button
                  onClick={() => setWin('edit')}
                  className="absolute top-1.5 right-2 cursor-pointer rounded-md bg-card/90 px-2 py-1 font-sans text-[0.6875rem] text-muted hover:text-fg"
                >
                  {t('窗口里查看')}
                </button>
              </div>
            ) : tool.kind === 'read' ? (
              input && input !== tool.label && <Block label="IN" text={input} />
            ) : (
              // 输入和标题一样（压缩上下文这类）就不再重复一遍；命令行没有单独输入时照样把命令写在 IN 里
              (tool.kind === 'run' || (input && input !== tool.label)) && (
                <Block label="IN" text={input || tool.label} />
              )
            )}
            {output ? (
              <>
                {live ? (
                  // 命令还在跑：只跟最新的几行，高度固定，不会把对话越撑越长；
                  // 完整输出点命令打开命令行窗口看
                  <div className={BLOCK}>
                    <BlockLabel
                      label="OUT"
                      aside={
                        <span className="mt-0.5 flex items-center gap-1 font-sans text-[0.625rem] text-accent-text">
                          <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
                          {t('正在输出')}
                        </span>
                      }
                    />
                    <div className="min-w-0">
                      {/* 只跟最新的几行，更早的不显示：上面用一行提示说还有多少行，
                          不靠裁高度，任何字号下都不会切出半行 */}
                      {liveCut && (
                        <div className="mb-0.5 font-sans text-[0.6875rem] text-subtle/70">
                          {t('前面还有 {n} 行', { n: liveRows.length - LIVE_ROWS })}
                        </div>
                      )}
                      <pre className="font-mono text-[0.75rem] leading-[1.6] whitespace-pre-wrap text-muted [overflow-wrap:anywhere]">
                        {liveTail.join('\n')}
                      </pre>
                    </div>
                  </div>
                ) : (
                  <Block
                    label="OUT"
                    text={short}
                    tone={tool.failed ? 'danger' : undefined}
                    aside={
                      <span className="mt-0.5 font-sans text-[0.625rem] text-subtle/70 tabular-nums">
                        {t('{n} 行', { n: tool.outputCut?.lines ?? output.split('\n').length })}
                      </span>
                    }
                  />
                )}
                {!live && short !== output && (
                  // 启动工作流这一行的输出就是那次运行的结论：跟着打开运行窗口，不再是另一个文本窗口
                  <MoreLink
                    onClick={() => (view.startsRun && task?.id ? openRunView() : setWin('out'))}
                    label={t('输出较长，在窗口里查看全部')}
                  />
                )}
              </>
            ) : (
              !isDiff && (
                <div className="px-3 py-2 font-sans text-xs text-subtle">
                  {tool.kind === 'read' && !input ? tool.label : live ? t('正在执行…') : t('没有输出')}
                </div>
              )
            )}
          </div>
        }
      </RowShell>
      {win === 'run' && (
        <CommandDialog
          command={input || tool.label}
          output={fullOutput}
          failed={tool.failed}
          running={tool.running}
          ms={tool.ms}
          startedAt={tool.startedAt}
          open
          onOpenChange={(o) => !o && setWin('')}
        />
      )}
      {win === 'edit' && task && (
        <DiffDialog
          task={task}
          diff={input}
          title={tool.label}
          onOpenChange={(o) => !o && setWin('')}
          onReverted={() => {}}
        />
      )}
      {win === 'plan' && task?.id && (
        <RunDialog taskId={task.id} tool={tool} open onOpenChange={(o) => !o && setWin('')} />
      )}
      {win === 'out' && (
        <OutputDialog
          title={tool.kind === 'search' ? t('搜索结果') : tool.kind === 'web' ? t('网页') : tool.name || tool.label}
          detail={tool.label}
          input={tool.kind === 'search' || tool.kind === 'web' ? '' : input}
          output={fullOutput}
          failed={tool.failed}
          running={tool.running}
          open
          onOpenChange={(o) => !o && setWin('')}
        />
      )}
    </>
  )
}
