import { useState } from 'react'
import { CircleCheck, CircleX, ListChecks, TerminalSquare, TriangleAlert } from 'lucide-react'
import type { Task } from '@shared/schema'
import type { EvidenceCommand } from '@shared/done-evidence'
import { turnEndSince } from '@shared/end-turn'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { fileIcon } from '@/lib/file-icon'

/** 先列几个文件、几条命令，其余的点「查看全部」展开 */
const FIRST = 4

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1)
const dirName = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')

/** 一条命令的结果：退出码 0 是通过，非 0 或 CLI 标了失败是没通过，CLI 没报退出码的照实写「未报退出码」 */
function CommandResult({ c }: { c: EvidenceCommand }) {
  if (c.exitCode === 0 && !c.failed)
    return (
      <span className="flex shrink-0 items-center gap-1 text-xs text-success">
        <CircleCheck className="h-3.5 w-3.5" />
        {t('退出码 0')}
      </span>
    )
  if (c.exitCode !== undefined || c.failed)
    return (
      <span className="flex shrink-0 items-center gap-1 text-xs text-danger">
        <CircleX className="h-3.5 w-3.5" />
        {c.exitCode !== undefined ? t('退出码 {code}', { code: c.exitCode }) : t('失败')}
      </span>
    )
  return <span className="shrink-0 text-xs text-subtle">{t('未报退出码')}</span>
}

/**
 * 完成依据（分析稿 A3，数据见 shared/done-evidence.ts）：Agent 用 end_turn 说做完了时，面板按这一轮的工具调用列出
 * 改了哪些文件、跑过哪些验证命令和退出码。改了代码却一条验证命令都没跑的标出来（只标不拦，项目设置里能改成拦）。
 * 只在对话停下后、挂在最后一轮下面，和「这个对话改了 N 个文件」放在一起
 */
export function DoneEvidenceCard({ task }: { task: Pick<Task, 'messages' | 'turnEnds'> }) {
  const [all, setAll] = useState(false)
  const end = turnEndSince(task)
  const ev = end?.outcome === 'done' ? end.evidence : undefined
  if (!ev || (!ev.files.length && !ev.commands.length)) return null
  const files = all ? ev.files : ev.files.slice(0, FIRST)
  const cmds = all ? ev.commands : ev.commands.slice(0, FIRST)
  const more = ev.files.length > FIRST || ev.commands.length > FIRST
  const fileCount = ev.files.length + (ev.moreFiles ?? 0)
  return (
    <div className="done-evidence my-1 overflow-hidden rounded-xl border bg-card text-body" data-done-evidence>
      <div className="flex h-9 items-center gap-2 border-b px-3.5">
        <ListChecks className="h-4 w-4 shrink-0 text-subtle" />
        <span className="min-w-0 truncate font-medium text-fg">{t('完成依据')}</span>
        <span className="min-w-0 truncate text-xs text-subtle">
          {t('改了 {f} 个文件 · 跑了 {c} 条验证命令', { f: fileCount, c: ev.commands.length })}
        </span>
      </div>
      {ev.unverified && (
        <div
          className="flex items-start gap-2 border-b border-warning/30 bg-warning/10 px-3.5 py-1.5 text-xs text-warning"
          data-unverified
        >
          <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>{t('改了代码，但这一轮没跑过任何测试、类型检查或编译命令；它说做完了，面板没看到验证过')}</span>
        </div>
      )}
      <div className="flex flex-col py-1">
        {files.map((f) => {
          const Icon = fileIcon(f)
          return (
            <div key={f} title={f} className="flex h-7 w-full items-center gap-2 px-3.5">
              <Icon className="h-3.5 w-3.5 shrink-0 text-subtle" />
              <span className="shrink-0 truncate">{baseName(f)}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-subtle">{dirName(f)}</span>
            </div>
          )
        })}
        {cmds.map((c) => (
          <div key={c.command} title={c.command} className="flex h-7 w-full items-center gap-2 px-3.5">
            <TerminalSquare className="h-3.5 w-3.5 shrink-0 text-subtle" />
            <span className={cn('min-w-0 flex-1 truncate font-mono text-xs', c.step ? 'text-fg' : 'text-muted')}>
              {c.command}
            </span>
            {c.step && <span className="shrink-0 text-xs text-subtle">{c.step}</span>}
            <CommandResult c={c} />
          </div>
        ))}
        {all && !!ev.moreFiles && (
          <span className="px-3.5 py-1 text-xs text-subtle">{t('另有 {n} 个文件没列出', { n: ev.moreFiles })}</span>
        )}
      </div>
      {more && (
        <div className="flex h-8 items-center border-t px-3.5">
          <button
            type="button"
            onClick={() => setAll(!all)}
            className="min-w-0 cursor-pointer truncate text-left text-muted hover:text-fg"
          >
            {all ? t('收起') : t('查看全部')}
          </button>
        </div>
      )}
    </div>
  )
}
