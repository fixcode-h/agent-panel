import { useMemo, useState } from 'react'
import {
  Bot,
  ChevronRight,
  FileText,
  FoldVertical,
  Globe,
  Loader2,
  PencilLine,
  Plug,
  Search,
  Sparkles,
  Terminal,
  Wrench,
} from 'lucide-react'
import type { Task, ToolUse } from '@shared/schema'
import { cn } from '@/lib/utils'
import { fmtSecs, toolVerb, toolView, type ToolView } from '@/lib/tasks'
import { useNow } from '@/lib/useNow'
import { useChildOpen } from './child-open'
import { t } from '@shared/i18n'
import { useFileOpen } from './FileDialog'
import { DiffDialog } from './DiffDialog'
import { CommandDialog, OutputDialog } from './ToolDialog'

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

function Block({ label, text, tone }: { label: string; text: string; tone?: 'danger' }) {
  return (
    <div className="flex gap-3 px-3 py-2">
      <span className="w-8 shrink-0 pt-px font-sans text-[0.65625rem] font-medium tracking-wider text-subtle">
        {label}
      </span>
      <pre
        className={cn(
          'max-h-[320px] min-w-0 flex-1 overflow-auto font-mono text-[0.75rem] leading-[1.6] whitespace-pre-wrap [overflow-wrap:anywhere]',
          tone === 'danger' ? 'text-danger' : 'text-fg/90',
        )}
      >
        {text}
      </pre>
    </div>
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
            <span className="rounded bg-sel px-1.5 py-px font-sans text-[0.6875rem] leading-4 text-subtle">
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
        {ms !== undefined && <span className="shrink-0 text-subtle tabular-nums">{fmtSecs(ms)}</span>}
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
  task?: Pick<Task, 'id' | 'status' | 'changes'>
}) {
  // 面板自己的工具按做了什么显示（新建子对话 + 名字），派出子任务的调用不单独显示；别的 MCP 工具名当动作
  const view = toolView(raw)
  if (view === null) return null
  return <ToolLine view={view} task={task} />
}

function ToolLine({ view, task }: { view: ToolView; task?: Pick<Task, 'id' | 'status' | 'changes'> }) {
  const { tool } = view
  const [open, setOpen] = useState(false)
  const [win, setWin] = useState<'' | 'run' | 'edit' | 'out'>('')
  const openFile = useFileOpen()
  const openChild = useChildOpen()
  const Icon = view.server ? Plug : (toolIcon[tool.kind] ?? Wrench)
  const verb = toolVerb(tool)
  // 还在等结果（任务还在跑、没有耗时）：每秒刷新已经用了多久，等子任务、长命令不再看着像卡住
  const pending = tool.ms === undefined && !!tool.startedAt && task?.status === 'running'
  const now = useNow(pending)
  const diff = tool.kind === 'edit' ? tool.detail.match(/^(\+\d+)?\s*(-\d+)?$/) : null
  const input = tool.input?.trim() ?? ''
  const output = tool.output?.replace(/\s+$/, '') ?? ''
  const isDiff = tool.kind === 'edit' && /^[+\-@ ]/m.test(input)
  // 读取的文件：点文件名打开文件
  const file = tool.kind === 'read' && openFile && isFilePath(tool.label) ? tool.label.trim() : ''

  const glyph = tool.running ? (
    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" />
  ) : (
    <Icon className={cn('h-3.5 w-3.5 shrink-0', tool.failed ? 'text-danger' : 'text-subtle')} />
  )
  const detail = diff ? (
    <span className="shrink-0">
      {diff[1] && <span className="text-success">{diff[1]}</span>}{' '}
      {diff[2] && <span className="text-danger">{diff[2]}</span>}
    </span>
  ) : (
    tool.detail && <span className={cn('shrink-0', tool.failed ? 'text-danger' : 'text-subtle')}>{tool.detail}</span>
  )
  // 点标题打开什么：文件、子对话、命令行、差异，或者看完整输出的窗口
  const target: { open: () => void; tip: string } | undefined = file
    ? { open: () => openFile?.(file), tip: t('查看文件') }
    : view.child && openChild
      ? { open: () => openChild(view.child!), tip: t('在右侧打开子对话') }
      : tool.kind === 'run'
        ? { open: () => setWin('run'), tip: t('打开命令行窗口') }
        : tool.kind === 'edit'
          ? { open: () => setWin('edit'), tip: t('打开差异窗口') }
          : hasWindow(tool)
            ? { open: () => setWin('out'), tip: t('打开窗口') }
            : undefined
  // 行内展开时的输出：长的只留前一段，后面提示去窗口里看
  const short = output.length > 400 ? `${output.slice(0, 400).trimEnd()}…` : output
  // 命令还在跑：展开时只显示最新的三行，像终端一样滚动；跑完再按现有高度显示完整输出
  const live = !!tool.running && tool.kind === 'run'
  const liveRows = live ? output.trimEnd().split('\n').slice(-3) : []

  return (
    <>
      <RowShell
        glyph={glyph}
        verb={verb}
        badge={view.server}
        title={tool.label}
        detail={detail}
        ms={pending ? now - tool.startedAt! : tool.ms}
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
                  // 命令还在跑：只跟显示最新三行，高度固定，不会把对话越撑越长；
                  // 完整输出点命令打开命令行窗口看
                  <div className="flex gap-3 px-3 py-2">
                    <span className="w-8 shrink-0 pt-px font-sans text-[0.65625rem] font-medium tracking-wider text-subtle">
                      OUT
                    </span>
                    {/* 最多三行：高度按这个字号的行高算（3 × 1.3em），字号跟着设置变也不会错位 */}
                    <pre
                      style={{ maxHeight: '3.9em' }}
                      className="min-w-0 flex-1 overflow-hidden font-mono text-[0.75rem] leading-[1.3] whitespace-pre-wrap text-fg/90 [overflow-wrap:anywhere]"
                    >
                      {liveRows.join('\n')}
                    </pre>
                  </div>
                ) : (
                  <Block label="OUT" text={short} tone={tool.failed ? 'danger' : undefined} />
                )}
                {!live && short !== output && (
                  <button
                    onClick={() => setWin('out')}
                    className="w-full cursor-pointer px-3 py-2 text-left font-sans text-xs text-muted hover:bg-sel hover:text-fg"
                  >
                    {t('输出较长，在窗口里查看全部')}
                  </button>
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
          output={output}
          failed={tool.failed}
          running={tool.running}
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
