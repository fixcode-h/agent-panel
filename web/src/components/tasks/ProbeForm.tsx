import { useState } from 'react'
import { Check, Crosshair, FileCode, Loader2, PenTool, Plus, ScrollText, Zap, type LucideIcon } from 'lucide-react'
import type { Task } from '@shared/schema'
import type { ProbeKind } from '@shared/bug/probe-schema'
import type { BugHop } from '@shared/bug/diagnosis-schema'
import { PROBE_KIND_TEXT } from '@shared/bug/probe'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { Modal } from '@/components/ui/modal'
import { Button } from '@/components/ui/button'
import { Segmented } from '@/components/ui/segmented'
import { Textarea } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'

/**
 * 补排查的表单（设计稿「Bug 模式子对话体验」效果图 1）：类型、想看什么、加在调用栈的哪几跳、两个勾选。
 * 点「马上加」报告不重出、阶段不变：服务端记下一条、返回交给 Agent 的话，这里作为用户消息发过去。
 * 诊断报告底栏、Bug 子对话输入框上方的动作条、临时排查改动清单都从这里开
 */

export const PROBE_KIND_ICON: Record<ProbeKind, LucideIcon> = { log: ScrollText, draw: PenTool, code: FileCode }
export const PROBE_ICON = Crosshair

type ProbeTask = Pick<Task, 'id' | 'bug'>

/** 记下来以后交给子对话：和诊断报告的决定一样走普通的发消息（在跑、在等下一句、停着都由那条路处理） */
export function useProbeActions(task: ProbeTask, onDone?: (t: Task) => void) {
  const [busy, setBusy] = useState('')
  const run = async (key: string, call: () => Promise<{ task: Task; message: string }>) => {
    setBusy(key)
    try {
      const r = await call()
      const next = r.message
        ? await api.sendMessage(task.id, r.message, []).catch((e: Error) => {
            toast.error(t('已经记下，但没能交给子对话：{error}', { error: e.message }))
            return r.task
          })
        : r.task
      onDone?.(next)
      return true
    } catch (e) {
      toast.error((e as Error).message)
      return false
    } finally {
      setBusy('')
    }
  }
  return {
    busy,
    remove: (ids: string[]) =>
      run(`remove:${ids.join(',')}`, () => api.probeAction(task.id, { action: 'remove', ids })),
    retry: (id: string) => run(`retry:${id}`, () => api.probeAction(task.id, { action: 'retry', ids: [id] })),
    start: (body: Parameters<typeof api.startProbe>[1]) => run('start', () => api.startProbe(task.id, body)),
  }
}

/** 调用栈的一跳写成给 Agent 看的位置：「S1 CartPage.onDelete（src/CartPage.tsx:90）」 */
const hopText = (h: BugHop) =>
  `${h.id} ${h.fn || h.file}${h.file ? `（${h.file}${h.line ? `:${h.line}` : ''}）` : ''}`.trim()

export function ProbeForm({
  task,
  open,
  onOpenChange,
  onDone,
  canPatch,
}: {
  task: ProbeTask
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone?: (t: Task) => void
  /** 对话在 Git 独立分支里：才有「加好后放到我的工作区」 */
  canPatch?: boolean
}) {
  const [kind, setKind] = useState<ProbeKind>('log')
  const [ask, setAsk] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [workspace, setWorkspace] = useState(true)
  const [remind, setRemind] = useState(true)
  const acts = useProbeActions(task, onDone)
  const d = task.bug?.diagnoses?.at(-1)
  // 只列真正走过的那几跳：没走到的旁支加了也打不出来
  const hops = (d?.stack ?? []).filter((h) => h.id && h.role !== 'missed').slice(0, 12)
  const kinds = PROBE_KIND_TEXT()
  const submit = async () => {
    const ok = await acts.start({
      kind,
      ask,
      targets: hops.filter((h) => picked.includes(h.id)).map(hopText),
      workspace: !!canPatch && workspace,
      remind,
    })
    if (!ok) return
    setAsk('')
    setPicked([])
    onOpenChange(false)
  }
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      stacked
      title={
        <span className="flex items-center gap-2">
          <PROBE_ICON className="h-4 w-4 text-accent-text" />
          {t('补排查')}
          <span className="text-caption font-normal text-subtle">{t('报告不重出，马上加；记进「临时排查改动」')}</span>
        </span>
      }
      footer={
        <div className="flex w-full flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 basis-60 text-caption text-subtle">
            {t('报告停在原来的阶段不动；加的每一行都要带 [排查-P…] 标记，面板这一轮结束逐行核对')}
          </span>
          <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
            {t('取消')}
          </Button>
          <Button size="sm" disabled={!ask.trim() || !!acts.busy} onClick={() => void submit()}>
            {acts.busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
            {t('马上加')}
          </Button>
        </div>
      }
    >
      <div data-probe-form className="flex flex-col gap-3">
        <Segmented
          value={kind}
          onChange={setKind}
          label={t('补排查的类型')}
          options={(Object.keys(kinds) as ProbeKind[]).map((k) => ({
            id: k,
            label: kinds[k],
            icon: PROBE_KIND_ICON[k],
          }))}
        />
        <Textarea
          autoFocus
          rows={3}
          value={ask}
          onChange={(e) => setAsk(e.target.value)}
          aria-label={t('想看什么')}
          placeholder={
            kind === 'draw'
              ? t('想看什么：例如把角标的位置画个框，数量写在框上')
              : kind === 'code'
                ? t('临时改什么：例如跳过缓存、把超时改成 1 秒（原有的行不改，新增带标记的行）')
                : t('想看什么：例如点删除之后，打出删之前和删之后的数量')
          }
        />
        {hops.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-caption">
            <span className="text-subtle">{t('加在：')}</span>
            {hops.map((h) => {
              const on = picked.includes(h.id)
              return (
                <button
                  key={h.id}
                  type="button"
                  aria-pressed={on}
                  title={h.file ? `${h.file}${h.line ? `:${h.line}` : ''}` : undefined}
                  onClick={() => setPicked((x) => (on ? x.filter((y) => y !== h.id) : [...x, h.id]))}
                  className={cn(
                    'inline-flex max-w-64 items-center gap-1 rounded-md px-2 py-0.5 font-mono transition-colors',
                    on ? 'bg-accent-soft text-accent-text' : 'bg-hover text-muted hover:text-fg',
                  )}
                >
                  {on ? <Check className="h-3 w-3 shrink-0" /> : <Plus className="h-3 w-3 shrink-0" />}
                  <span className="truncate">{`${h.id} ${h.fn || h.file}`}</span>
                </button>
              )
            })}
            <span className="text-subtle">{t('（从调用栈挑，不挑由它定）')}</span>
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          {canPatch && (
            <Checkbox
              checked={workspace}
              onChange={setWorkspace}
              label={
                <span className="text-body">{t('加好后放到我的工作区（独立分支里改的，我在自己目录里复现）')}</span>
              }
            />
          )}
          <Checkbox
            checked={remind}
            onChange={setRemind}
            label={<span className="text-body">{t('要重新编译 / 热重载时提醒我')}</span>}
          />
        </div>
      </div>
    </Modal>
  )
}
