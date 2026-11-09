import { useState } from 'react'
import {
  Ban,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Languages,
  Lightbulb,
  MapPin,
  Pencil,
  RotateCcw,
  Sparkles,
  SquareTerminal,
  Trash2,
  TriangleAlert,
  Undo2,
  Workflow,
  type LucideIcon,
} from 'lucide-react'
import {
  kindLabel,
  type ExperienceKind,
  type LearnedEntry,
  type LearnedNote,
  type ProjectExperience,
} from '@shared/experience'
import { t } from '@shared/i18n'
import { experienceApi } from '@/lib/api-experience'
import { useNav } from '@/lib/data'
import { setProjectExperience, useProjectExperience } from '@/lib/experience-store'
import { timeAgo } from '@/lib/tasks'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/dialog'
import { IconButton } from '@/components/ui/icon-button'

/**
 * 对话里「学到经验」的卡片（设计稿 agent-panel/经验模块优化与按条展示设计-2026-11-09.md 第 2 节）：
 * 一条经验一行，看得出种类、位置、新加还是并入了已有的；悬停出编辑、停用、删除，点一行展开说明和关键词。
 * 显示的是经验库里现在的样子（在设置页改过、停用、删掉的跟着变），库里没有了就按消息里存的快照画、标「已删除」。
 * 自动学到的（TaskMessage.learned）和 /learn 让 Agent 记的（record_experience 那一行下面）共用这一份
 */

const KIND_ICON: Record<ExperienceKind, LucideIcon> = {
  locate: MapPin,
  vocab: Languages,
  command: SquareTerminal,
  verify: CircleCheck,
  flow: Workflow,
}

const lower = (xs: string[]) => new Set(xs.map((x) => x.trim().toLowerCase()))

/** 并入已有的那条：这次改了什么（标题、补了几个关键词和位置），给展开后的那一行说明用 */
function mergeSummary(before: ProjectExperience, now: ProjectExperience) {
  const kw = lower(before.keywords)
  const ps = lower(before.paths)
  const addKw = now.keywords.filter((k) => !kw.has(k.trim().toLowerCase())).length
  const addPath = now.paths.filter((p) => !ps.has(p.trim().toLowerCase())).length
  return [
    before.title !== now.title && t('标题改了'),
    before.body !== now.body && t('说明改了'),
    addKw > 0 && t('补了 {n} 个关键词', { n: addKw }),
    addPath > 0 && t('补了 {n} 个位置', { n: addPath }),
  ]
    .filter(Boolean)
    .join('，')
}

export function LearnedCard({
  projectId,
  note,
  manual,
}: {
  projectId?: string
  note: LearnedNote
  /** /learn 让 Agent 记的（不是对话完成后自动学的）：标「手动」，头部写「记下」 */
  manual?: boolean
}) {
  const { openProject } = useNav()
  const live = useProjectExperience(projectId)
  // 只学到一条时默认展开（用户 2026-11-09 定）；两条时收起，一条一行
  const [open, setOpen] = useState(note.items.length === 1 ? note.items[0].id : '')
  const [showDropped, setShowDropped] = useState(false)
  if (note.full !== undefined) return <FullCard projectId={projectId} count={note.full} />
  if (!note.items.length) return null
  const allLink = projectId && (
    <button
      type="button"
      onClick={() => openProject(projectId, 'experience')}
      className="flex shrink-0 cursor-pointer items-center gap-0.5 rounded-md px-1.5 py-0.5 text-xs text-muted transition-colors hover:bg-sel hover:text-fg"
    >
      {t('全部经验')}
      <ChevronRight className="h-3.5 w-3.5" />
    </button>
  )
  return (
    <div className="learned-card my-1 overflow-hidden rounded-xl border bg-card text-body">
      <div className="flex h-9 items-center gap-2 border-b px-3.5">
        <Lightbulb className="h-4 w-4 shrink-0 text-accent-text" />
        <span className="shrink-0 font-medium">
          {manual ? t('记下 {n} 条经验', { n: note.items.length }) : t('学到 {n} 条经验', { n: note.items.length })}
        </span>
        {note.reason && (
          <span className="hidden min-w-0 truncate text-xs text-subtle sm:inline" title={note.reason}>
            · {note.reason}
          </span>
        )}
        <span className="flex-1" />
        {allLink}
      </div>
      <div className="divide-y">
        {note.items.map((e) => (
          <LearnedRow
            key={e.id}
            entry={e}
            projectId={projectId}
            live={live.items?.find((x) => x.id === e.id)}
            loaded={!!live.items}
            manual={manual}
            open={open === e.id}
            onToggle={() => setOpen(open === e.id ? '' : e.id)}
          />
        ))}
      </div>
      {note.dropped.length > 0 && (
        <div className="border-t text-xs text-subtle">
          <button
            type="button"
            aria-expanded={showDropped}
            onClick={() => setShowDropped(!showDropped)}
            className="flex h-8 w-full cursor-pointer items-center gap-1.5 px-3.5 text-left hover:text-fg"
          >
            <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 transition-transform', showDropped && 'rotate-90')} />
            <span className="min-w-0 truncate">
              {t('另有 {n} 条没收下：{why}', { n: note.dropped.length, why: note.dropped[0].why })}
            </span>
          </button>
          {showDropped && (
            <ul className="flex flex-col gap-1 px-3.5 pb-2.5 pl-8 leading-relaxed">
              {note.dropped.map((d, i) => (
                <li key={i} className="[overflow-wrap:anywhere]">
                  <span className="text-muted">{d.title}</span>：{d.why}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function LearnedRow({
  entry,
  projectId,
  live,
  loaded,
  manual,
  open,
  onToggle,
}: {
  entry: LearnedEntry
  projectId?: string
  /** 经验库里现在的这条；没拉到或已删掉时是 undefined */
  live?: ProjectExperience
  loaded: boolean
  manual?: boolean
  open: boolean
  onToggle: () => void
}) {
  const { openProject } = useNav()
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState(false)
  // 删掉前的样子：撤销时按它写回（在卡片上改过又删的，比消息里的快照新）
  const [removed, setRemoved] = useState<ProjectExperience>()
  const gone = loaded && !live
  const cur = live ?? removed ?? entry.snapshot
  const off = !!live && !live.enabled
  const Icon = KIND_ICON[cur.kind] ?? MapPin
  const sub = cur.paths.length ? cur.paths.join('  ') : cur.keywords.join('、')
  // 撤回过合并：库里这条又是并入前的样子了，不再显示「并入已有」和这次加的内容
  const unmerged =
    !!entry.before && !!live && live.updatedAt === entry.before.updatedAt && live.title === entry.before.title
  const merged = entry.op === 'merge' && !!entry.before && !unmerged

  const act = async (fn: (id: string) => Promise<{ items: ProjectExperience[] }>) => {
    if (!projectId || busy) return false
    setBusy(true)
    try {
      setProjectExperience(projectId, (await fn(projectId)).items)
      return true
    } catch (e) {
      const err = e as Error & { status?: number }
      if (err.status === 409) setConflict(true)
      else toast.error(err.message)
      return false
    } finally {
      setBusy(false)
    }
  }
  const remove = async () => {
    const before = live
    if (await act((p) => experienceApi.apply(p, { remove: [entry.id] }))) setRemoved(before)
  }
  const restore = () => void act((p) => experienceApi.restore(p, cur))
  const toggleEnabled = () =>
    live && void act((p) => experienceApi.update(p, live.id, { ...live, enabled: !live.enabled }))
  const edit = () => projectId && openProject(projectId, 'experience', entry.id)
  // 撤回这次合并：并入后又被改过（updatedAt 对不上）时先问一句
  const unmerge = (force = false) =>
    entry.before && act((p) => experienceApi.restore(p, entry.before!, force ? undefined : entry.snapshot.updatedAt))

  const tag = manual ? (
    <Badge className="shrink-0 text-caption">{t('手动')}</Badge>
  ) : unmerged ? (
    <span className="text-xs text-subtle">{t('已撤回合并')}</span>
  ) : entry.op === 'merge' ? (
    <Badge className="shrink-0 bg-peer-soft text-caption text-peer">{t('并入已有')}</Badge>
  ) : (
    <Badge tone="success" className="shrink-0 text-caption">
      {t('新加')}
    </Badge>
  )
  const stateText = gone ? t('已删除') : off ? t('已停用') : ''
  const newKw = merged ? lower(entry.before!.keywords) : null
  const newPath = merged ? lower(entry.before!.paths) : null

  return (
    <div className={cn('group', open && 'pb-3')}>
      <div className="flex items-start gap-2.5 px-3.5 py-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className={cn(
            'flex min-w-0 flex-1 cursor-pointer items-start gap-2.5 text-left',
            (gone || off) && 'opacity-55',
          )}
        >
          <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md bg-sel text-muted">
            <Icon className="h-3.5 w-3.5" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-center gap-1">
              <span className={cn('min-w-0 truncate font-medium', gone && 'text-subtle line-through')}>
                {cur.title}
              </span>
              <ChevronDown
                className={cn('h-3.5 w-3.5 shrink-0 text-subtle transition-transform', !open && '-rotate-90')}
              />
            </span>
            <span className="flex min-w-0 items-center gap-1.5 text-xs text-subtle">
              <span className="hidden shrink-0 sm:inline">{kindLabel(cur.kind)}</span>
              {sub && <span className="hidden opacity-60 sm:inline">·</span>}
              <span className="min-w-0 truncate font-mono text-caption">{sub}</span>
            </span>
          </span>
        </button>
        <div className="flex h-6 shrink-0 items-center gap-1">
          {stateText ? (
            <>
              <span className="text-xs text-subtle">{stateText}</span>
              {projectId && (
                <Button
                  size="sm"
                  variant="link"
                  className="h-6 px-1 text-xs"
                  disabled={busy}
                  onClick={gone ? restore : toggleEnabled}
                >
                  {gone ? t('撤销') : t('恢复')}
                </Button>
              )}
            </>
          ) : (
            <>
              <span className={cn(projectId && live && !open && 'group-focus-within:hidden group-hover:hidden')}>
                {tag}
              </span>
              {projectId && live && !open && (
                <span className="hidden items-center gap-0.5 group-focus-within:flex group-hover:flex">
                  <IconButton icon={Pencil} size="xs" label={t('编辑')} onClick={edit} />
                  <IconButton icon={Ban} size="xs" label={t('停用')} disabled={busy} onClick={toggleEnabled} />
                  <IconButton
                    icon={Trash2}
                    size="xs"
                    tone="danger"
                    label={t('不对，删掉')}
                    disabled={busy}
                    onClick={() => void remove()}
                  />
                </span>
              )}
            </>
          )}
        </div>
      </div>
      {open && (
        <div className="flex flex-col gap-2 pr-3.5 pl-[3.25rem] text-xs">
          {merged && (
            <p className="rounded-lg bg-peer-soft px-2.5 py-1.5 leading-relaxed text-muted">
              {t('并入已有的一条：{title}', { title: entry.before!.title })}
              {mergeSummary(entry.before!, entry.snapshot) && `；${mergeSummary(entry.before!, entry.snapshot)}`}
              {t('（框出来的是这次加的）')}
            </p>
          )}
          {cur.body && (
            <p className="text-body leading-relaxed whitespace-pre-wrap text-muted [overflow-wrap:anywhere]">
              {cur.body}
            </p>
          )}
          <div className="grid grid-cols-[3.25rem_1fr] items-baseline gap-x-2.5 gap-y-1.5">
            {cur.keywords.length > 0 && (
              <>
                <span className="text-subtle">{t('关键词')}</span>
                <span className="flex flex-wrap gap-1">
                  {cur.keywords.map((k) => (
                    <span
                      key={k}
                      className={cn(
                        'rounded-md bg-sel px-1.5 leading-5 text-muted',
                        newKw && !newKw.has(k.trim().toLowerCase()) && 'bg-peer-soft text-peer ring-1 ring-peer/60',
                      )}
                    >
                      {k}
                    </span>
                  ))}
                </span>
              </>
            )}
            {cur.paths.length > 0 && (
              <>
                <span className="text-subtle">{cur.kind === 'command' ? t('命令') : t('位置')}</span>
                <span className="flex min-w-0 flex-wrap gap-1">
                  {cur.paths.map((p) => (
                    <span
                      key={p}
                      className={cn(
                        'max-w-full rounded-md border bg-panel px-1.5 font-mono text-caption leading-5 [overflow-wrap:anywhere] text-fg',
                        newPath && !newPath.has(p.trim().toLowerCase()) && 'border-peer/70',
                      )}
                    >
                      {p}
                    </span>
                  ))}
                </span>
              </>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className="text-subtle">
              {[
                cur.source === 'auto' ? t('自动学到') : t('手动添加'),
                cur.taskIds.length > 1 && t('来自 {n} 个对话', { n: cur.taskIds.length }),
                timeAgo(cur.updatedAt || cur.createdAt),
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
            {projectId && (
              <span className="ml-auto flex flex-wrap gap-1.5">
                {gone ? (
                  <Button size="sm" variant="secondary" className="h-7 px-2 text-xs" disabled={busy} onClick={restore}>
                    <Undo2 className="h-3.5 w-3.5" />
                    {t('撤销删除')}
                  </Button>
                ) : (
                  <>
                    {merged && live && (
                      <Button
                        size="sm"
                        variant="secondary"
                        className="h-7 px-2 text-xs"
                        disabled={busy}
                        onClick={() => void unmerge()}
                      >
                        <Undo2 className="h-3.5 w-3.5" />
                        {t('撤回这次合并')}
                      </Button>
                    )}
                    <Button size="sm" variant="secondary" className="h-7 px-2 text-xs" onClick={edit}>
                      <Pencil className="h-3.5 w-3.5" />
                      {t('编辑')}
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="h-7 px-2 text-xs"
                      disabled={busy}
                      onClick={toggleEnabled}
                    >
                      {off ? <RotateCcw className="h-3.5 w-3.5" /> : <Ban className="h-3.5 w-3.5" />}
                      {off ? t('恢复') : t('停用')}
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="h-7 px-2 text-xs text-danger"
                      disabled={busy}
                      onClick={() => void remove()}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      {t('删除')}
                    </Button>
                  </>
                )}
              </span>
            )}
          </div>
        </div>
      )}
      <ConfirmDialog
        open={conflict}
        onOpenChange={setConflict}
        title={t('还要撤回这次合并吗？')}
        description={t('这条经验在合并之后又改过，撤回会恢复成合并前的样子，之后的改动会丢掉。')}
        confirmText={t('撤回')}
        onConfirm={() => unmerge(true)}
      />
    </div>
  )
}

/** 经验满了、这次没学：一个项目一天只出一次（服务端控制），直接给 AI 评审的入口 */
function FullCard({ projectId, count }: { projectId?: string; count: number }) {
  const { openProject } = useNav()
  return (
    <div className="my-1 overflow-hidden rounded-xl border bg-card text-body">
      <div className="flex h-9 items-center gap-2 bg-warning/10 px-3.5 font-medium text-warning">
        <TriangleAlert className="h-4 w-4 shrink-0" />
        {t('这次没学经验')}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 py-2.5 text-muted">
        <span className="min-w-0 flex-1">
          {t('这个项目的经验已经有 {n} 条，先用 AI 评审清理一下再学。', { n: count })}
        </span>
        {projectId && (
          <Button
            size="sm"
            variant="secondary"
            className="h-7 px-2 text-xs"
            onClick={() => openProject(projectId, 'experience', 'review')}
          >
            <Sparkles className="h-3.5 w-3.5" />
            {t('AI 评审')}
          </Button>
        )}
      </div>
    </div>
  )
}
