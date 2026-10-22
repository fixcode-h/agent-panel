import { createContext, useContext, useMemo, useState } from 'react'
import {
  Bot,
  ChevronRight,
  FileText,
  FoldVertical,
  Globe,
  Loader2,
  PencilLine,
  Search,
  Sparkles,
  Terminal,
  Wrench,
} from 'lucide-react'
import type { Task, ToolUse } from '@shared/schema'
import { cn } from '@/lib/utils'
import { panelChildId, panelTool, toolVerb } from '@/lib/tasks'
import { t } from '@shared/i18n'
import { useFileOpen } from './FileDialog'
import { DiffDialog } from './DiffDialog'
import { CommandDialog, OutputDialog } from './ToolDialog'

/** 父对话页提供：在右栏打开某个子对话。子对话自己的页面（右栏里）不提供 */
export const ChildOpenCtx = createContext<((id: string) => void) | null>(null)

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
  // 面板自己的工具按做了什么显示（新建子对话 + 名字），派出子任务的调用不单独显示
  const view = panelTool(raw)
  const openChild = useContext(ChildOpenCtx)
  if (view === null) return null
  const child = view && openChild ? panelChildId(raw) : ''
  return <ToolLine tool={view ?? raw} task={task} onChild={child ? () => openChild?.(child) : undefined} />
}

function ToolLine({
  tool,
  task,
  onChild,
}: {
  tool: ToolUse
  task?: Pick<Task, 'id' | 'status' | 'changes'>
  /** 新建 / 交给子对话的行：点一下在右栏打开那个子对话 */
  onChild?: () => void
}) {
  const [open, setOpen] = useState(false)
  const [win, setWin] = useState<'' | 'run' | 'edit' | 'out'>('')
  const openFile = useFileOpen()
  const Icon = toolIcon[tool.kind] ?? Wrench
  const verb = toolVerb(tool)
  const diff = tool.kind === 'edit' ? tool.detail.match(/^(\+\d+)?\s*(-\d+)?$/) : null
  const input = tool.input?.trim() ?? ''
  const output = tool.output?.replace(/\s+$/, '') ?? ''
  const isDiff = tool.kind === 'edit' && /^[+\-@ ]/m.test(input)
  // 读取的文件：点名字直接打开，点「读取」只展开收起
  const file = tool.kind === 'read' && openFile && isFilePath(tool.label) ? tool.label.trim() : ''
  // 命令点命令本身、改动点文件名：直接开对应的窗口；其余工具点「展开」时在行内看，输出长的再开窗口
  const windowed = hasWindow(tool)

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
  const chevron = (
    <ChevronRight
      className={cn(
        'h-3.5 w-3.5 shrink-0 text-subtle opacity-0 transition group-hover:opacity-100',
        open && 'rotate-90 opacity-100',
      )}
    />
  )
  // 行内展开时的输出：长的只留前一段，后面提示去窗口里看
  const short = output.length > 400 ? `${output.slice(0, 400).trimEnd()}…` : output
  // 命令还在跑：展开时只显示最新的三行，像终端一样滚动；跑完再按现有高度显示完整输出
  const live = !!tool.running && tool.kind === 'run'
  const liveRows = live ? output.trimEnd().split('\n').slice(-3) : []

  return (
    <div className={cn('min-w-0 overflow-hidden rounded-lg border bg-field', tool.failed && 'border-danger/30')}>
      {file ? (
        // 读取的文件行：用鼠标指针时点「读取」只展开收起，点后面的文件名打开文件
        <div className="group flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5 font-mono text-xs text-muted">
          <button
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            title={open ? t('收起') : t('展开')}
            className="flex shrink-0 cursor-pointer items-center gap-2 text-left hover:text-fg"
          >
            {glyph}
            {verb && <span className="font-sans font-medium text-fg/80">{verb}</span>}
          </button>
          <button
            onClick={() => openFile?.(file)}
            title={t('查看文件')}
            className="min-w-0 flex-1 cursor-pointer truncate text-left hover:text-fg hover:underline"
          >
            {tool.label}
          </button>
          {detail}
          <button onClick={() => setOpen(!open)} aria-expanded={open} className="shrink-0 cursor-pointer">
            {chevron}
          </button>
        </div>
      ) : onChild ? (
        // 新建 / 交给子对话：整行点开右栏的子对话页，参数和结果不用在行内展开
        <button
          type="button"
          onClick={onChild}
          title={t('在右侧打开子对话')}
          className="group flex w-full min-w-0 cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left font-mono text-xs text-muted hover:text-fg"
        >
          {glyph}
          <span className="min-w-0 flex-1 truncate">
            {verb && <span className="mr-1.5 font-sans font-medium text-fg/80">{verb}</span>}
            {tool.label}
          </span>
          {detail}
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-subtle opacity-0 transition group-hover:opacity-100" />
        </button>
      ) : windowed ? (
        // 命令、改动、搜索等：点这一行打开独立窗口；「展开」仍在行内看，方便快速瞄一眼
        <div className="group flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5 font-mono text-xs text-muted">
          <button
            onClick={() => setWin(tool.kind === 'run' ? 'run' : tool.kind === 'edit' ? 'edit' : 'out')}
            title={tool.kind === 'run' ? t('打开命令行窗口') : tool.kind === 'edit' ? t('打开差异窗口') : t('打开窗口')}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left hover:text-fg"
          >
            {glyph}
            <span className="min-w-0 flex-1 truncate">
              {verb && <span className="mr-1.5 font-sans font-medium text-fg/80">{verb}</span>}
              {tool.label}
            </span>
            {detail}
          </button>
          <button
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            title={open ? t('收起') : t('展开')}
            className="shrink-0 cursor-pointer"
          >
            {chevron}
          </button>
        </div>
      ) : (
        // 命令还在跑：转圈代替图标，输出边跑边追加，点开能看到
        <button
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="group flex w-full min-w-0 cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left font-mono text-xs text-muted hover:text-fg"
        >
          {glyph}
          <span className="min-w-0 flex-1 truncate">
            {verb && <span className="mr-1.5 font-sans font-medium text-fg/80">{verb}</span>}
            {tool.label}
          </span>
          {detail}
          {chevron}
        </button>
      )}
      {open && (
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
      )}
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
    </div>
  )
}
