import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { CalendarClock, ExternalLink, Pencil, Play, Plus, Trash2 } from 'lucide-react'
import {
  fromLocalInput,
  SCHEDULE_TICK_MS,
  toLocalInput,
  workdayTemplate,
  type Schedule,
  type ScheduleInput,
  type ScheduleRepeat,
} from '@shared/schedule'
import { getLang, t } from '@shared/i18n'
import { api } from '@/lib/api'
import { useData, useNav } from '@/lib/data'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Input, Select, Textarea } from '@/components/ui/input'
import { Modal } from '@/components/ui/modal'
import { Segmented } from '@/components/ui/segmented'
import { Switch } from '@/components/ui/switch'
import { PageFrame } from '@/components/library/parts'

const DEMO = !!import.meta.env.VITE_DEMO

/** 时间按本机时区显示到分钟：计划只精确到分钟，秒没有意义 */
const fmtAt = (iso: string) => {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return '—'
  return d.toLocaleString(getLang() === 'en' ? 'en-US' : 'zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** 待执行的排前面、按时间先后；跑过的和停用的放后面 */
const rank = (s: Schedule) => (s.enabled && s.status === 'pending' ? 0 : 1)
const sortSchedules = (list: Schedule[]) =>
  [...list].sort((a, b) => rank(a) - rank(b) || Date.parse(a.at) - Date.parse(b.at))

const toInput = (s: Schedule): ScheduleInput => ({
  name: s.name,
  prompt: s.prompt,
  projectId: s.projectId,
  agentId: s.agentId,
  repeat: s.repeat,
  at: s.at,
  enabled: s.enabled,
})

function StatusBadge({ schedule: s }: { schedule: Schedule }) {
  if (!s.enabled) return <Badge>{t('已停用')}</Badge>
  if (s.status === 'done') return <Badge tone="success">{t('已执行')}</Badge>
  if (s.status === 'skipped') return <Badge tone="warning">{t('已跳过')}</Badge>
  return <Badge tone="accent">{t('待执行')}</Badge>
}

/** 列表里一行时间说明：下次什么时候跑、上次什么时候跑过 */
const timeText = (s: Schedule) => {
  if (!s.enabled) return t('已停用，不会执行')
  if (s.status === 'pending') return t('下次执行 {time}', { time: fmtAt(s.at) })
  if (s.lastRunAt) return t('上次执行 {time}', { time: fmtAt(s.lastRunAt) })
  return t('没有执行过')
}

/** 编辑表单的值：时间用 datetime-local 的字符串（本机时区） */
interface Form {
  name: string
  prompt: string
  projectId: string
  agentId: string
  repeat: ScheduleRepeat
  atLocal: string
}

const newForm = (): Form => {
  // 新建时预填「今日工作」模板：每天 19:00 总结当天的工作，用户直接改就行
  const tpl = workdayTemplate(Date.now())
  return {
    name: tpl.name,
    prompt: tpl.prompt,
    repeat: tpl.repeat,
    projectId: '',
    agentId: '',
    atLocal: toLocalInput(tpl.at),
  }
}

const formOf = (s: Schedule): Form => ({
  name: s.name,
  prompt: s.prompt,
  projectId: s.projectId,
  agentId: s.agentId,
  repeat: s.repeat,
  atLocal: toLocalInput(s.at),
})

function ScheduleDialog({
  schedule,
  onClose,
  onSaved,
}: {
  /** 不传是新建 */
  schedule?: Schedule
  onClose: () => void
  onSaved: (s: Schedule) => void
}) {
  const { projects, agents } = useData()
  const [form, setForm] = useState<Form>(() => (schedule ? formOf(schedule) : newForm()))
  const [saving, setSaving] = useState(false)
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }))

  const save = async () => {
    const at = fromLocalInput(form.atLocal)
    if (!at) {
      toast.error(t('请选择执行时间'))
      return
    }
    const input: ScheduleInput = {
      name: form.name,
      prompt: form.prompt,
      projectId: form.projectId,
      agentId: form.agentId,
      repeat: form.repeat,
      at,
      enabled: schedule?.enabled ?? true,
    }
    setSaving(true)
    try {
      if (schedule) {
        // 弹窗开着的时候这条计划可能已经跑过一次、排期变了（每天的计划会自己推到下一次）：
        // 提交打开时那份旧时间，服务端会当成重新排期，让同一次计划再跑一遍。
        // 保存前确认它还是打开时的排期，不是就让用户重新打开再改
        const latest = (await api.schedules()).find((x) => x.id === schedule.id)
        if (!latest) throw new Error(t('计划不存在'))
        if (latest.at !== schedule.at) {
          onSaved(latest)
          toast.error(t('这条计划刚执行过或已被改过，请重新打开再编辑'))
          return
        }
      }
      const saved = schedule ? await api.updateSchedule(schedule.id, input) : await api.createSchedule(input)
      toast.success(schedule ? t('计划已保存') : t('计划已创建'))
      onSaved(saved)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title={schedule ? t('编辑计划') : t('新建计划')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('取消')}
          </Button>
          <Button className="ml-auto" disabled={saving} onClick={save}>
            {t('保存')}
          </Button>
        </>
      }
    >
      {!schedule && (
        <p className="text-[0.8125rem] text-muted">
          {t('已按「今日工作」填好：每天 19:00 总结当天的工作，可以直接改。')}
        </p>
      )}
      <label className="flex flex-col gap-1.5">
        <span className="text-[0.8125rem] font-medium">{t('名称')}</span>
        <Input
          autoFocus
          value={form.name}
          placeholder={t('例如：今日工作')}
          onChange={(e) => set('name', e.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-[0.8125rem] font-medium">{t('到点后执行的对话内容')}</span>
        <Textarea
          rows={4}
          value={form.prompt}
          placeholder={t('交给 Agent 的一句话目标，例如：总结今天做的工作')}
          onChange={(e) => set('prompt', e.target.value)}
        />
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-[0.8125rem] font-medium">{t('在哪个项目里执行')}</span>
          <Select
            value={form.projectId}
            aria-label={t('在哪个项目里执行')}
            options={[
              { value: '', label: t('聊天（不属于项目）') },
              ...projects.map((p) => ({ value: p.id, label: p.name })),
            ]}
            onChange={(e) => set('projectId', e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[0.8125rem] font-medium">{t('用哪个角色')}</span>
          <Select
            value={form.agentId}
            aria-label={t('用哪个角色')}
            options={[
              { value: '', label: t('不用角色（跟随默认 CLI）') },
              ...agents.map((a) => ({
                value: a.id,
                label: a.enabled ? a.name : t('{name}（已停用）', { name: a.name }),
              })),
            ]}
            onChange={(e) => set('agentId', e.target.value)}
          />
        </label>
      </div>
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1.5">
          <span className="text-[0.8125rem] font-medium">{t('重复')}</span>
          <Segmented
            label={t('重复')}
            value={form.repeat}
            onChange={(v) => set('repeat', v)}
            options={[
              { id: 'once', label: t('只执行一次') },
              { id: 'daily', label: t('每天') },
            ]}
          />
        </div>
        <label className="flex flex-col gap-1.5">
          <span className="text-[0.8125rem] font-medium">{t('执行时间')}</span>
          <Input
            type="datetime-local"
            className="h-10 dark:[color-scheme:dark]"
            value={form.atLocal}
            onChange={(e) => set('atLocal', e.target.value)}
          />
        </label>
      </div>
      <p className="text-xs text-subtle">
        {t('时间按本机时区。每天的计划每次执行完自动推到第二天，只执行一次的执行完就停下。')}
      </p>
    </Modal>
  )
}

export function SchedulesPage() {
  const { projects } = useData()
  const { go } = useNav()
  const [list, setList] = useState<Schedule[] | null>(null)
  const [error, setError] = useState('')
  /** 正在新建 / 编辑的那条；'new' 是新建 */
  const [edit, setEdit] = useState<Schedule | 'new' | null>(null)
  const [del, setDel] = useState<Schedule | null>(null)
  /** 正在执行的那条计划 id：按钮转圈、防止重复点 */
  const [busy, setBusy] = useState('')
  /** 请求序号：保存 / 删除后比它早发出的轮询迟到返回时丢掉，不把刚保存的列表覆盖回旧值 */
  const loadSeq = useRef(0)

  const load = async () => {
    const seq = ++loadSeq.current
    try {
      const next = await api.schedules()
      if (seq !== loadSeq.current) return
      setList(sortSchedules(next))
      setError('')
    } catch (e) {
      if (seq === loadSeq.current) setError((e as Error).message)
    }
  }

  useEffect(() => {
    void load()
    // 到点后状态和下次执行时间会变：和服务端轮询同一个节奏，页面开着就能看到
    const timer = setInterval(() => void load(), SCHEDULE_TICK_MS)
    return () => clearInterval(timer)
    // load 每次渲染都是新的函数，只在挂载时开始轮询
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const saved = (s: Schedule) => {
    // 本地已经是最新的，把在途的轮询请求作废（它带的是保存前的列表）
    loadSeq.current++
    setList((l) => sortSchedules([...(l ?? []).filter((x) => x.id !== s.id), s]))
    setEdit(null)
  }

  const toggle = async (s: Schedule, on: boolean) => {
    try {
      saved(await api.updateSchedule(s.id, { ...toInput(s), enabled: on }))
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const runNow = async (s: Schedule) => {
    setBusy(s.id)
    try {
      const res = await api.runSchedule(s.id)
      saved(res.schedule)
      if (res.taskId) toast.success(t('已启动对话「{name}」', { name: s.name }))
      else if (DEMO) toast.info(t('在线演示里不会真的启动对话，正式版会新建一个对话开始执行。'))
      else toast.error(res.schedule.lastError || t('启动失败'))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  const openTask = (s: Schedule) => {
    if (!s.lastTaskId) return
    go(s.projectId ? { page: 'projects', id: s.projectId, sub: s.lastTaskId } : { page: 'chat', id: s.lastTaskId })
  }

  return (
    <PageFrame
      title={t('计划')}
      intro={t(
        '到点自动新建一个对话去执行。面板进程在跑时才会触发；面板关着期间错过的计划不会补跑，会在列表里标出来。',
      )}
      actions={
        <Button onClick={() => setEdit('new')}>
          <Plus className="h-4 w-4" />
          {t('新建计划')}
        </Button>
      }
    >
      {error ? (
        <p className="text-[0.8125rem] text-warning">{t('读取失败：{error}', { error })}</p>
      ) : !list ? (
        <p className="text-[0.8125rem] text-subtle">{t('读取中…')}</p>
      ) : !list.length ? (
        <p className="rounded-xl border border-dashed px-4 py-10 text-center text-[0.8125rem] text-subtle">
          {t('还没有计划。点右上角「新建计划」，默认已经按「今日工作」填好。')}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {list.map((s) => {
            const project = projects.find((p) => p.id === s.projectId)
            return (
              <li key={s.id} className="flex items-start gap-3 rounded-xl border bg-card px-4 py-3">
                <CalendarClock className={cn('mt-0.5 h-4 w-4 shrink-0', s.enabled ? 'text-accent' : 'text-subtle')} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={cn('truncate text-[0.9375rem] font-medium', !s.enabled && 'text-muted')}>
                      {s.name}
                    </span>
                    <StatusBadge schedule={s} />
                    <Badge>{s.repeat === 'daily' ? t('每天') : t('单次')}</Badge>
                  </div>
                  <p className="mt-1 line-clamp-2 text-[0.8125rem] leading-relaxed text-muted">{s.prompt}</p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-subtle">
                    <span>{timeText(s)}</span>
                    <span>{project ? project.name : t('聊天')}</span>
                    {!!s.agentId && <span>{t('用角色执行')}</span>}
                    {!!s.missedAt && (
                      <span className="text-warning">
                        {t('错过 {time}（面板没开着，不补跑）', { time: fmtAt(s.missedAt) })}
                      </span>
                    )}
                    {!!s.lastError && (
                      <span className="text-warning">{t('上次启动失败：{error}', { error: s.lastError })}</span>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {!!s.lastTaskId && (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      title={t('打开这次执行')}
                      aria-label={t('打开这次执行')}
                      onClick={() => openTask(s)}
                    >
                      <ExternalLink className="h-4 w-4" />
                    </Button>
                  )}
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    title={t('立即执行')}
                    aria-label={t('立即执行')}
                    disabled={busy === s.id}
                    onClick={() => void runNow(s)}
                  >
                    <Play className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    title={t('编辑')}
                    aria-label={t('编辑')}
                    onClick={() => setEdit(s)}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Switch
                    checked={s.enabled}
                    aria-label={t('启用这条计划')}
                    onCheckedChange={(on) => void toggle(s, on)}
                  />
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    title={t('删除')}
                    aria-label={t('删除')}
                    onClick={() => setDel(s)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {edit && (
        <ScheduleDialog
          key={edit === 'new' ? 'new' : edit.id}
          schedule={edit === 'new' ? undefined : edit}
          onClose={() => setEdit(null)}
          onSaved={saved}
        />
      )}
      <ConfirmDialog
        open={!!del}
        title={t('删除计划「{name}」？', { name: del?.name ?? '' })}
        description={t('删除后不会再执行，已经启动过的对话会留着。')}
        onOpenChange={(open) => !open && setDel(null)}
        onConfirm={async () => {
          if (!del) return
          try {
            await api.deleteSchedule(del.id)
            loadSeq.current++
            setList((l) => (l ?? []).filter((x) => x.id !== del.id))
            toast.success(t('计划已删除'))
          } catch (e) {
            toast.error((e as Error).message)
          }
        }}
      />
    </PageFrame>
  )
}
