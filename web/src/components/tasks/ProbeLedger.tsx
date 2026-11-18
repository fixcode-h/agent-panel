import { FileText, Loader2, Play, RotateCcw, ShieldCheck, Trash2, Undo2 } from 'lucide-react'
import type { Task } from '@shared/schema'
import type { BugRepro } from '@shared/bug/probe-schema'
import {
  ledgerRows,
  PROBE_KIND_TEXT,
  PROBE_STATE_TEXT,
  problemText,
  removable,
  type LedgerRow,
} from '@shared/bug/probe'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useFileOpen } from './FileDialog'
import { PROBE_ICON, PROBE_KIND_ICON, useProbeActions } from './ProbeForm'
import type { usePatch } from './DiagnosisEvidence'

/**
 * 临时排查改动清单（设计稿「Bug 模式子对话体验」效果图 2）：这个 Bug 里加过的全部临时代码，
 * 论证时的日志（L1…）和补排查加的（P1…）。每行编号、类型、位置、说明、行数、状态，补排查的能单条撤掉。
 * 编号联动（N4）：点位置打开文件跳到那一行；复现记录里点编号滚到这里对应的那一行
 */

type LedgerTask = Pick<Task, 'id' | 'bug'>

const rowAnchor = (id: string) => `probe-row-${id}`

/** 复现记录、调用栈上点了编号：滚到清单里那一行并闪一下 */
export function jumpToLedger(id: string) {
  const el = document.getElementById(rowAnchor(id))
  if (!el) return
  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  el.classList.add('bg-accent-soft')
  window.setTimeout(() => el.classList.remove('bg-accent-soft'), 1200)
}

function StateBadge({ row, onWorkspace }: { row: LedgerRow; onWorkspace: boolean }) {
  if (row.from === 'evidence') return row.hit === 'hit' ? <Badge tone="success">{t('打出来了')}</Badge> : null
  const s = row.state!
  if (s === 'added' && row.hit === 'hit') return <Badge tone="success">{t('打出来了')}</Badge>
  if (s === 'added' && row.hit === 'miss') return <Badge tone="danger">{t('该打没打')}</Badge>
  if (s === 'added' && onWorkspace) return <Badge tone="accent">{t('在你的工作区')}</Badge>
  const tone = s === 'added' ? 'accent' : s === 'bad' || s === 'stuck' ? 'danger' : 'neutral'
  return (
    <Badge tone={tone}>
      {(s === 'adding' || s === 'removing') && <Loader2 className="h-3 w-3 animate-spin" />}
      {PROBE_STATE_TEXT()[s]}
    </Badge>
  )
}

export function ProbeLedger({
  task,
  onDone,
  patch,
  onProbe,
}: {
  task: LedgerTask
  onDone?: (t: Task) => void
  patch?: ReturnType<typeof usePatch>
  /** 打开补排查表单（报告关了就不给） */
  onProbe?: () => void
}) {
  const open = useFileOpen()
  const acts = useProbeActions(task, onDone)
  const rows = ledgerRows(task.bug)
  if (!rows.length) return null
  const live = rows.filter((r) => r.state !== 'removed')
  const files = new Set(live.map((r) => r.file).filter(Boolean))
  const added = live.reduce((n, r) => n + r.lines, 0)
  const canRemove = rows.filter((r) => r.probe && removable(r.probe))
  const applied = new Set(patch?.status?.applied?.files ?? [])
  const kinds = PROBE_KIND_TEXT()
  const remind = rows.some((r) => r.state === 'added' && r.probe?.remind)
  return (
    <section
      data-probe-ledger
      className="mt-3 overflow-hidden rounded-lg border border-line bg-card text-body select-none"
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line px-3 py-2">
        <span className="flex min-w-0 items-center gap-2 font-medium text-fg">
          <PROBE_ICON className="h-4 w-4 shrink-0 text-accent-text" />
          {t('临时排查改动')}
        </span>
        <span className="text-caption text-subtle">
          {t('{n} 处 · {f} 个文件 · +{k} 行', { n: live.length, f: files.size, k: added })}
        </span>
        <span className="ml-auto flex flex-wrap items-center gap-1">
          {onProbe && (
            <Button size="sm" variant="ghost" onClick={onProbe}>
              <PROBE_ICON className="h-3.5 w-3.5" />
              {t('补排查')}
            </Button>
          )}
          {canRemove.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              disabled={!!acts.busy}
              onClick={() => void acts.remove([])}
              title={t('撤掉补排查加的全部临时代码；论证时的日志在修完收尾或不修了时一起删')}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t('全部撤掉')}
            </Button>
          )}
        </span>
      </header>
      <ul className="divide-y divide-line">
        {rows.map((r) => {
          const Icon = PROBE_KIND_ICON[r.kind]
          const gone = r.state === 'removed'
          const p = r.probe
          return (
            <li key={r.id} id={rowAnchor(r.id)} className={cn('px-3 py-1.5 transition-colors', gone && 'opacity-50')}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="w-6 shrink-0 font-mono text-caption text-subtle">{r.id}</span>
                <span className="flex w-20 shrink-0 items-center gap-1 text-caption text-muted">
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  {kinds[r.kind]}
                </span>
                {r.file ? (
                  <button
                    type="button"
                    disabled={!open || gone}
                    onClick={() => open?.(r.file, r.line)}
                    title={t('打开 {file}', { file: r.file })}
                    className="inline-flex max-w-56 items-center gap-1 rounded-md bg-hover px-1.5 py-0.5 font-mono text-caption text-fg hover:bg-active disabled:cursor-default"
                  >
                    <FileText className="h-3 w-3 shrink-0 text-subtle" />
                    <span className="truncate">{r.file.split('/').pop()}</span>
                    {r.line ? <span className="text-subtle">:{r.line}</span> : null}
                  </button>
                ) : null}
                <span
                  className={cn('min-w-0 flex-1 basis-40 truncate text-muted', gone && 'line-through')}
                  title={r.text}
                >
                  {r.from === 'evidence'
                    ? t('论证第 {v} 版 · {text}', { v: r.rev ?? '', text: r.text })
                    : t('补排查 · {text}', { text: r.text })}
                </span>
                {r.lines > 0 && r.from === 'probe' && (
                  <span className="font-mono text-caption text-success">+{r.lines}</span>
                )}
                <StateBadge row={r} onWorkspace={applied.has(r.file)} />
                {p && p.state === 'bad' && (
                  <Button size="sm" variant="ghost" disabled={!!acts.busy} onClick={() => void acts.retry(p.id)}>
                    <RotateCcw className="h-3.5 w-3.5" />
                    {t('让它改')}
                  </Button>
                )}
                {p && removable(p) && (
                  <Button size="sm" variant="ghost" disabled={!!acts.busy} onClick={() => void acts.remove([p.id])}>
                    <Undo2 className="h-3.5 w-3.5" />
                    {t('撤掉')}
                  </Button>
                )}
              </div>
              {p && (p.state === 'bad' || p.state === 'stuck') && p.problems.length > 0 && (
                <pre className="mt-1.5 max-h-32 overflow-y-auto rounded-md bg-panel px-2 py-1.5 font-mono text-caption whitespace-pre-wrap text-danger">
                  {p.problems.some((x) => x.why === 'empty')
                    ? t('这一轮没有加任何带标记的代码（或者没用改文件工具改，面板没拍到快照）')
                    : problemText(p.problems)}
                </pre>
              )}
            </li>
          )
        })}
      </ul>
      <footer className="flex items-start gap-2 border-t border-line px-3 py-2 text-caption text-subtle">
        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
        <span>
          {remind
            ? t('改了要编译的代码或脚本：重新编译 / 热重载后再复现。')
            : t(
                '加之前拍了快照：不修了、修完收尾或点「撤掉」时由 Agent 一处一处删，面板按快照逐行核对，删不干净不关报告。',
              )}
        </span>
      </footer>
    </section>
  )
}

/**
 * 补排查记录（报告右栏标注区上面，停靠到右栏时和对话同屏，设计稿 N5）：每次补排查说了什么、什么时候、现在什么状态，
 * 每次复现取到的日志打出来了哪几处（N3），最后一行提示下一步
 */
export function ProbeRecords({ task }: { task: LedgerTask }) {
  const probes = task.bug?.probes ?? []
  const repros: BugRepro[] = task.bug?.repros ?? []
  if (!probes.length && !repros.length) return null
  const states = PROBE_STATE_TEXT()
  const time = (at: string) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const waiting = probes.some((p) => p.state === 'added')
  return (
    <div data-probe-records className="flex flex-col gap-1.5 border-b border-line pb-3">
      <span className="text-caption font-medium text-subtle">{t('补排查记录')}</span>
      {probes
        .slice(-5)
        .reverse()
        .map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => jumpToLedger(p.id)}
            className="flex flex-col gap-0.5 rounded-md bg-hover/60 px-2 py-1.5 text-left hover:bg-hover"
          >
            <span className="flex items-center gap-2 text-caption">
              <span className="font-mono text-subtle">
                {p.id} {time(p.at)}
              </span>
              <span
                className={cn('ml-auto', p.state === 'bad' || p.state === 'stuck' ? 'text-danger' : 'text-accent-text')}
              >
                {states[p.state]}
              </span>
            </span>
            <span className="line-clamp-2 text-body text-fg">{p.ask}</span>
          </button>
        ))}
      {repros
        .slice(-3)
        .reverse()
        .map((r) => (
          <div key={r.id} className="flex flex-wrap items-center gap-1.5 px-1 text-caption text-muted">
            <span className="font-mono text-subtle">
              {r.id} {time(r.at)}
            </span>
            <span>{t('复现：第 {a}–{b} 行', { a: r.startLine, b: r.endLine })}</span>
            {r.hits.length ? (
              r.hits.slice(0, 8).map((h) => (
                <button
                  key={h}
                  type="button"
                  onClick={() => jumpToLedger(h)}
                  className="rounded bg-success/12 px-1 font-mono text-success hover:underline"
                >
                  {h}
                </button>
              ))
            ) : (
              <span className="text-danger">{t('一处都没打出来')}</span>
            )}
          </div>
        ))}
      {waiting && (
        <span className="flex items-center gap-1.5 rounded-md bg-accent-soft px-2 py-1 text-caption text-accent-text">
          <Play className="h-3 w-3 shrink-0" />
          {t('复现一次，把日志交给它：报告上有「复现完了，取日志」就点它，没有就把日志贴进来')}
        </span>
      )}
    </div>
  )
}

/**
 * 不修了的确认框里（效果图 3）：补排查加的也在要删的范围里，单独写一句列出编号；
 * 删的步骤（Agent 一处一处删 → 面板按快照核对 → 还原工作区副本）照现有的清理流程
 */
export function ProbeCancelNote({ task }: { task: LedgerTask }) {
  const live = (task.bug?.probes ?? []).filter((p) => p.state !== 'removed')
  if (!live.length) return null
  return (
    <p data-probe-cancel className="flex items-start gap-2 text-caption text-muted">
      <PROBE_ICON className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-text" />
      {t('补排查加的 {ids} 一起删：Agent 一处一处删，面板按加之前的快照逐行核对，有残留、多删、多出空行都退回给它。', {
        ids: live.map((p) => p.id).join('、'),
      })}
    </p>
  )
}
