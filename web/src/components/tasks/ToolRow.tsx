import { useMemo, useState } from 'react'
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
import { fmtDuration, toolVerb, toolView, type ToolView } from '@/lib/tasks'
import { useNow } from '@/lib/useNow'
import { useChildOpen, useRunOpen } from './child-open'
import { t } from '@shared/i18n'
import { useFileOpen } from './FileDialog'
import { DiffDialog } from './DiffDialog'
import { CommandDialog, OutputDialog } from './ToolDialog'
import { RunDialog } from './RunCard'
import { PeerLine } from './PeerMessage'

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
          {rows.map((r, i) =>
            r.kind === 'hunk' ? (
              <tr key={i} className="bg-field/60 text-subtle">
                <td colSpan={numbered ? 4 : 2} className="px-3 py-0.5 text-[0.6875rem]">
                  {r.text || '⋯'}
                </td>
              </tr>
            ) : (
              <tr key={i} className={cn(r.kind === 'add' && 'bg-success/12', r.kind === 'del' && 'bg-danger/12')}>
                {numbered && (
                  <>
                    <td className="w-10 px-2 text-right align-top text-subtle/70 select-none">{r.old ?? ''}</td>
                    <td className="w-10 px-2 text-right align-top text-subtle/70 select-none">{r.new ?? ''}</td>
                  </>
                )}
                <td
                  className={cn(
                    'w-5 pl-2 align-top select-none',
                    r.kind === 'add' ? 'text-success' : r.kind === 'del' ? 'text-danger' : 'text-subtle/60',
                  )}
                >
                  {r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : ' '}
                </td>
                <td className="pr-3 whitespace-pre-wrap text-fg/90 [overflow-wrap:anywhere]">{r.text || ' '}</td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  )
}

/**
 * 展开后的 IN / OUT 一段：小标签单独一行，正文和对话里的代码块同一套字号、行高，
 * 不再用左侧挤着的窄标签，长文本也不会被标签列压得换行
 */
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
    <div className="px-3.5 py-2.5">
      <div className="mb-1 flex items-center gap-2">
        <span className="font-mono text-[0.625rem] font-medium tracking-[0.14em] text-subtle/80">{label}</span>
        {aside}
      </div>
      <pre
        className={cn(
          'max-h-[320px] min-w-0 overflow-auto font-mono text-[0.75rem] leading-[1.65] whitespace-pre-wrap [overflow-wrap:anywhere]',
          tone === 'danger' ? 'text-danger' : 'text-fg/90',
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
      className="flex w-full cursor-pointer items-center gap-1.5 px-3.5 py-2 text-left font-sans text-xs text-muted transition-colors hover:bg-sel hover:text-fg"
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
  ms,
  open,
  onToggle,
  onOpen,
  openTip,
  failed,
  className,
  children,
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
  /** 跑了多久（毫秒）：显示在最右边，还在跑的每秒更新 */
  ms?: number
  open: boolean
  /** 不给就不能展开（没有可看的内容），点哪里都不动 */
  onToggle?: () => void
  onOpen?: () => void
  openTip?: string
  failed?: boolean
  className?: string
  children?: React.ReactNode
}) {
  const toggle = onToggle
  return (
    <div className={cn('min-w-0 overflow-hidden rounded-lg border bg-field', failed && 'border-danger/30', className)}>
      {/* 整行点了是展开收起；标题是单独的按钮，点它只开窗口，不会同时展开 */}
      <div
        onClick={toggle}
        className={cn(
          'group flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5 font-mono text-xs text-muted',
          toggle && 'cursor-pointer hover:text-fg',
        )}
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            toggle?.()
          }}
          disabled={!toggle}
          aria-expanded={toggle ? open : undefined}
          title={toggle ? (open ? t('收起') : t('展开')) : undefined}
          className="flex shrink-0 items-center gap-2 text-left enabled:cursor-pointer"
        >
          {glyph}
          {verb && <span className="font-sans font-medium text-fg/85">{verb}</span>}
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
        {/* 标题只占自己文字的宽度：点标题后面的空白也是展开收起 */}
        <span className="flex min-w-0 flex-1 items-center">
          {title ? (
            onOpen ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onOpen()
                }}
                title={openTip}
                className={cn(
                  'min-w-0 cursor-pointer truncate text-left text-fg/75 decoration-subtle underline-offset-2 hover:text-fg hover:underline',
                  titleClass,
                )}
              >
                {title}
              </button>
            ) : (
              <span className={cn('min-w-0 truncate', titleClass)}>{title}</span>
            )
          ) : null}
        </span>
        {detail}
        {ms !== undefined && <span className="shrink-0 text-subtle tabular-nums">{fmtDuration(ms)}</span>}
        {toggle && (
          <ChevronRight
            className={cn(
              'h-3.5 w-3.5 shrink-0 text-subtle opacity-0 transition group-hover:opacity-100',
              open && 'rotate-90 opacity-100',
            )}
          />
        )}
      </div>
      {open && children}
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
  // 给另一个对话发消息：和收件方的「接收消息」一样画成「发送消息 + 类型 + 内容标题」
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
      />
    )
  return <ToolLine view={view} task={task} />
}

function ToolLine({ view, task }: { view: ToolView; task?: Pick<Task, 'id' | 'status' | 'changes' | 'jobs'> }) {
  const { tool } = view
  const [open, setOpen] = useState(false)
  const [win, setWin] = useState<'' | 'run' | 'edit' | 'out' | 'plan'>('')
  const openFile = useFileOpen()
  const openChild = useChildOpen()
  const openRunPane = useRunOpen()
  const Icon = view.server ? Plug : (toolIcon[tool.kind] ?? Wrench)
  const verb = toolVerb(tool)
  // 还在等结果（任务还在跑、没有耗时）：每秒刷新已经用了多久，等子任务、长命令不再看着像卡住
  const pending = tool.ms === undefined && !!tool.startedAt && task?.status === 'running'
  // 放到后台的命令：调用本身马上就返回了，命令还在后台跑时照样转圈、走表，跑完面板把这一行换成真实的用时和结果
  const ids = view.job ? [view.job] : (view.jobs ?? [])
  const mine = ids.length ? (task?.jobs ?? []).filter((j) => ids.includes(j.id)) : []
  const bg = mine.length > 0
  // 申请的编译有几条：从最早开始跑的那条算；都还在排队就写「排队中」
  const starts = mine.map((j) => (j.startedAt ? Date.parse(j.startedAt) : 0)).filter(Boolean)
  const jobStart = starts.length ? Math.min(...starts) : 0
  const queued = bg && mine.every((j) => j.state === 'queued')
  const now = useNow(pending || bg)
  const diff = tool.kind === 'edit' ? tool.detail.match(/^(\+\d+)?\s*(-\d+)?$/) : null
  const input = tool.input?.trim() ?? ''
  const output = tool.output?.replace(/\s+$/, '') ?? ''
  const isDiff = tool.kind === 'edit' && /^[+\-@ ]/m.test(input)
  // 读取的文件：点文件名打开文件
  const file = tool.kind === 'read' && openFile && isFilePath(tool.label) ? tool.label.trim() : ''

  const glyph =
    tool.running || bg ? (
      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" />
    ) : (
      <Icon className={cn('h-3.5 w-3.5 shrink-0', tool.failed ? 'text-danger' : 'text-subtle')} />
    )
  const detail = diff ? (
    <span className="shrink-0">
      {diff[1] && <span className="text-success">{diff[1]}</span>}{' '}
      {diff[2] && <span className="text-danger">{diff[2]}</span>}
    </span>
  ) : queued ? (
    <span className="shrink-0 text-subtle">{t('排队中')}</span>
  ) : (
    tool.detail && <span className={cn('shrink-0', tool.failed ? 'text-danger' : 'text-subtle')}>{tool.detail}</span>
  )
  // 「启动工作流」这一行点开什么：子对话面板里就地换成这次运行的视图（能返回），别的位置还是弹运行窗口
  const openRunView = openRunPane ? () => openRunPane(tool) : () => setWin('plan')
  // 点标题打开什么：子对话、这次运行、文件、命令行、差异，或者看完整输出的窗口
  const target: { open: () => void; tip: string } | undefined = file
    ? { open: () => openFile?.(file), tip: t('查看文件') }
    : view.child && openChild
      ? { open: () => openChild(view.child!), tip: t('在右侧打开子对话') }
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
        failed={tool.failed}
      >
        {
          <div className="divide-y border-t bg-card/60">
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
              <Block label="IN" text={input || tool.label} />
            )}
            {output ? (
              <>
                {live ? (
                  // 命令还在跑：只跟最新的几行，高度固定，不会把对话越撑越长；
                  // 完整输出点命令打开命令行窗口看
                  <div className="px-3.5 py-2.5">
                    <div className="mb-1 flex items-center gap-2">
                      <span className="font-mono text-[0.625rem] font-medium tracking-[0.14em] text-subtle/80">
                        OUT
                      </span>
                      <span className="flex items-center gap-1.5 font-sans text-[0.6875rem] text-accent">
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
                        {t('正在输出')}
                      </span>
                    </div>
                    <div>
                      {/* 只跟最新的几行，更早的不显示：上面用一行提示说还有多少行，
                          不靠裁高度，任何字号下都不会切出半行 */}
                      {liveCut && (
                        <div className="mb-0.5 font-sans text-[0.6875rem] text-subtle/70">
                          {t('前面还有 {n} 行', { n: liveRows.length - LIVE_ROWS })}
                        </div>
                      )}
                      <pre className="font-mono text-[0.75rem] leading-[1.65] whitespace-pre-wrap text-fg/90 [overflow-wrap:anywhere]">
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
                      <span className="font-mono text-[0.625rem] text-subtle/70 tabular-nums">
                        {t('{n} 行', { n: output.split('\n').length })}
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
                <div className="px-3.5 py-2.5 font-sans text-xs text-subtle">
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
          output={output}
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
          output={output}
          failed={tool.failed}
          running={tool.running}
          open
          onOpenChange={(o) => !o && setWin('')}
        />
      )}
    </>
  )
}
