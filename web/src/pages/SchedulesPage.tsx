import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { toast } from '@/lib/toast'
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import {
  groupLabel,
  groupSchedules,
  movedSchedule,
  nextToRun,
  SCHEDULE_TICK_MS,
  weekStartOf,
  type Schedule,
} from '@shared/schedule'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { useData, useNav } from '@/lib/data'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/dialog'
import { ResizeHandle, usePaneWidth } from '@/components/ui/resize'
import { Segmented } from '@/components/ui/segmented'
import { Badge } from '@/components/ui/badge'
import { ScheduleCard } from '@/components/schedule/ScheduleCard'
import { ScheduleDetail } from '@/components/schedule/ScheduleDetail'
import { ScheduleDialog } from '@/components/schedule/ScheduleDialog'
import { ScheduleEmpty } from '@/components/schedule/ScheduleEmpty'
import { ScheduleMonth } from '@/components/schedule/ScheduleMonth'
import { ScheduleOverview } from '@/components/schedule/ScheduleOverview'
import { isoWeek, ScheduleWeek } from '@/components/schedule/ScheduleWeek'
import { scheduleInputOf, type SchedulePreset } from '@/components/schedule/use-schedule-form'

const DEMO = !!import.meta.env.VITE_DEMO

/** 分组标题：组名 + 数量 */
function GroupHeading({ group, count }: { group: string; count: number }) {
  return (
    <h2 className="flex items-center gap-2 text-[0.8125rem] font-semibold text-muted">
      {group}
      <Badge className="px-1.5 py-0 text-[0.6875rem] font-normal tabular-nums">{count}</Badge>
    </h2>
  )
}

type View = 'week' | 'month' | 'list'
const VIEW_KEY = 'schedules:view'
const DAY_MS = 86_400_000

/** 上次看的视图：只是本机的顺手记忆，读不到（隐私窗口、被禁用）就回到默认的周视图 */
function storedView(): View {
  try {
    const v = localStorage.getItem(VIEW_KEY)
    return v === 'month' || v === 'list' ? v : 'week'
  } catch {
    return 'week'
  }
}

/** 某天所在月的 1 号 0 点：月视图按它翻月 */
const monthStartOf = (ms: number) => {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime()
}

export function SchedulesPage() {
  const { projects, agents, tasks } = useData()
  const { go } = useNav()
  const [list, setList] = useState<Schedule[] | null>(null)
  const [error, setError] = useState('')
  /** 相对时间（3 小时后）和数据一起算、一起刷：不和列表数据分开各算一次 */
  const [now, setNow] = useState(() => Date.now())
  /** 正在新建 / 编辑的那条；'new' 是模板新建，'blank' 是空白新建，preset 是在日历某一格新建 */
  const [edit, setEdit] = useState<Schedule | 'new' | 'blank' | { preset: SchedulePreset } | null>(null)
  const [del, setDel] = useState<Schedule | null>(null)
  /** 正在执行的那条计划 id：按钮转圈、防止重复点 */
  const [busy, setBusy] = useState('')
  /** 请求序号：保存 / 删除后比它早发出的轮询迟到返回时丢掉，不把刚保存的列表覆盖回旧值 */
  const loadSeq = useRef(0)
  /** 周 / 月 / 列表：周视图照设计稿是默认，列表是原来按状态分组的卡片 */
  const [view, setViewState] = useState<View>(storedView)
  const setView = (v: View) => {
    setViewState(v)
    try {
      localStorage.setItem(VIEW_KEY, v)
    } catch {}
  }
  /** 周视图看的那周（周一 0 点）、月视图看的那月（1 号 0 点）：各翻各的 */
  const [week, setWeek] = useState(() => weekStartOf(Date.now()))
  const [month, setMonth] = useState(() => monthStartOf(Date.now()))
  /** 日历里选中的计划；没选过时右侧详情默认给下一条要跑的 */
  const [selId, setSelId] = useState('')
  /** 窄屏上详情是滑出来的浮层：只有用户点了一条才打开 */
  const [detailOpen, setDetailOpen] = useState(false)
  const detailPane = usePaneWidth('schedule-detail', 380, 320, 560)
  /** 详情面板里有没有没保存的改动：换到别的计划、切到列表前要先确认，不悄悄丢掉 */
  const [detailDirty, setDetailDirty] = useState(false)
  /** 等用户确认「放弃改动」之后要做的事 */
  const [discard, setDiscard] = useState<(() => void) | null>(null)
  const guard = (action: () => void) => (detailDirty ? setDiscard(() => action) : action())
  const onDetailDirty = useCallback((d: boolean) => setDetailDirty(d), [])

  const load = async () => {
    const seq = ++loadSeq.current
    try {
      const next = await api.schedules()
      if (seq !== loadSeq.current) return
      setList(next)
      setNow(Date.now())
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
    setList((l) => [...(l ?? []).filter((x) => x.id !== s.id), s])
    setNow(Date.now())
    setEdit(null)
  }

  const toggle = async (s: Schedule, on: boolean) => {
    try {
      saved(await api.updateSchedule(s.id, { ...scheduleInputOf(s), enabled: on }))
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  /** 日历上拖动、拉伸后直接保存（不经过弹窗）；放不下（拖到过去、工作日拖到周末）时说明原因，不改 */
  const reschedule = async (s: Schedule, patch: Partial<ReturnType<typeof scheduleInputOf>>) => {
    try {
      saved(await api.updateSchedule(s.id, { ...scheduleInputOf(s), ...patch }))
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  const moveTo = (s: Schedule, occAt: number, to: number) =>
    guard(() => {
      const r = movedSchedule(s, occAt, to, Date.now())
      if ('error' in r) return void toast.error(r.error)
      void reschedule(s, r)
    })
  const resize = (s: Schedule, minutes: number) => guard(() => void reschedule(s, { durationMin: minutes }))

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

  const openTask = (taskId: string, projectId: string) => {
    if (!taskId) return
    go(projectId ? { page: 'projects', id: projectId, sub: taskId } : { page: 'chat', id: taskId })
  }

  /** 对话标题：历史里显示这次启动了哪个对话；还不在这份数据里时为空，退回「打开对话」 */
  const taskTitle = (taskId: string) => tasks.find((x) => x.id === taskId)?.title ?? ''

  /** 上游的名字：找不到的是已经被删掉的，用占位名字，不显示一串 id */
  const upstreamNames = (s: Schedule) =>
    s.dependsOn.map((id) => list?.find((x) => x.id === id)?.name ?? t('已删除的计划'))

  const buckets = list ? groupSchedules(list) : []
  const selected = list?.find((x) => x.id === selId) ?? (list ? (nextToRun(list) ?? list[0]) : undefined)
  const calendar = view !== 'list'
  const select = (s: Schedule) =>
    guard(() => {
      setSelId(s.id)
      setDetailOpen(true)
    })
  // 开始改了就把当前这条钉住：没点选过时详情默认跟着「下一条要跑的」走，轮询后可能换成别的，改到一半的会被换掉
  useEffect(() => {
    if (detailDirty && selected && !selId) setSelId(selected.id)
    // 只在开始改的那一刻钉一次
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [detailDirty])

  // 页头的翻页：周视图一次一周、月视图一次一月；标签和「第几周」跟着当前视图走
  const weekEnd = new Date(week)
  weekEnd.setDate(weekEnd.getDate() + 6)
  const first = new Date(view === 'month' ? month : week)
  const range =
    view === 'month'
      ? t('{y} 年 {m} 月', { y: first.getFullYear(), m: first.getMonth() + 1 })
      : t('{y} 年 {m} 月 {d} 日 – {m2} 月 {d2} 日', {
          y: first.getFullYear(),
          m: first.getMonth() + 1,
          d: first.getDate(),
          m2: weekEnd.getMonth() + 1,
          d2: weekEnd.getDate(),
        })
  const step = (dir: -1 | 1) => {
    if (view === 'month') {
      const d = new Date(month)
      setMonth(new Date(d.getFullYear(), d.getMonth() + dir, 1).getTime())
    } else setWeek((w) => weekStartOf(w + (dir < 0 ? -DAY_MS : 8 * DAY_MS)))
  }
  const toToday = () => (view === 'month' ? setMonth(monthStartOf(Date.now())) : setWeek(weekStartOf(Date.now())))

  const cardProps = (s: Schedule) => ({
    schedule: s,
    now,
    projectName: projects.find((p) => p.id === s.projectId)?.name ?? '',
    agentName: agents.find((a) => a.id === s.agentId)?.name ?? '',
    upstreams: upstreamNames(s),
    busy: busy === s.id,
    taskTitle,
    onEdit: () => setEdit(s),
    onRun: () => void runNow(s),
    onToggle: (on: boolean) => void toggle(s, on),
    onDelete: () => setDel(s),
    onOpenTask: (taskId: string) => openTask(taskId, s.projectId),
  })

  return (
    <div className="flex min-w-0 flex-1">
      <main className="panel flex min-w-0 flex-1 flex-col md:h-full">
        {/* 页头（照设计稿）：标题 → 翻页和日期范围 → 视图切换 → 新建；窄屏放不下时换行 */}
        <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2.5">
          <h1 className="text-lg font-semibold">{t('计划')}</h1>
          {calendar && (
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
              <div className="flex items-center gap-0.5">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={view === 'month' ? t('上个月') : t('上一周')}
                  onClick={() => step(-1)}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button variant="secondary" size="sm" className="h-7" onClick={toToday}>
                  {view === 'month' ? t('本月') : t('本周')}
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={view === 'month' ? t('下个月') : t('下一周')}
                  onClick={() => step(1)}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
              <span className="text-[0.8125rem] font-semibold tabular-nums">{range}</span>
              {view === 'week' && (
                <span className="text-[0.75rem] text-subtle">{t('第 {n} 周', { n: isoWeek(week) })}</span>
              )}
            </div>
          )}
          <span className="flex-1" />
          <Segmented
            size="sm"
            label={t('视图')}
            value={view}
            onChange={(v) => (v === 'list' ? guard(() => setView(v)) : setView(v))}
            options={[
              { id: 'week', label: t('周') },
              { id: 'month', label: t('月') },
              { id: 'list', label: t('列表') },
            ]}
          />
          <Button size="sm" onClick={() => setEdit('new')}>
            <Plus className="h-4 w-4" />
            {t('新建计划')}
          </Button>
        </header>

        {/* 日历的用法写一行：右键 / 双击、拖动这些操作光看界面猜不到 */}
        {calendar && list && !error && (
          <p className="shrink-0 border-b px-4 py-1.5 text-[0.75rem] text-subtle">
            {!list.length && <span className="font-medium text-muted">{t('还没有计划。')}</span>}
            {view === 'week'
              ? t('右键或双击空白格在那个时间新建；拖动计划改时间，拖底边改时长，半小时一格。')
              : t('双击一天在那天新建；点日期看那一周。')}
          </p>
        )}
        <div className="min-h-0 flex-1 overflow-auto">
          {error || !list || view === 'list' ? (
            <div className="mx-auto flex w-full max-w-[900px] flex-col gap-5 px-4 pt-6 pb-12 md:px-8">
              {error ? (
                <p className="text-[0.8125rem] text-warning">{t('读取失败：{error}', { error })}</p>
              ) : !list ? (
                <p className="text-[0.8125rem] text-subtle">{t('读取中…')}</p>
              ) : !list.length ? (
                <ScheduleEmpty onCreateTemplate={() => setEdit('new')} onCreateBlank={() => setEdit('blank')} />
              ) : (
                <>
                  <p className="max-w-[620px] text-[0.8125rem] leading-relaxed text-muted">
                    {t(
                      '到点自动新建一个对话去执行。面板进程在跑时才会触发；面板关着期间错过的计划不会补跑，会在列表里标出来。',
                    )}
                  </p>
                  <ScheduleOverview
                    buckets={buckets}
                    now={now}
                    onJumpToProblem={() =>
                      document
                        .getElementById('schedule-group-problem')
                        ?.scrollIntoView({ block: 'start', behavior: 'smooth' })
                    }
                  />
                  {buckets.map(({ group, items }) => (
                    <section key={group} id={`schedule-group-${group}`} className="flex scroll-mt-6 flex-col gap-2">
                      <GroupHeading group={groupLabel(group)} count={items.length} />
                      <ul className="flex flex-col gap-2">
                        {items.map((s) => (
                          <ScheduleCard key={s.id} {...cardProps(s)} />
                        ))}
                      </ul>
                    </section>
                  ))}
                </>
              )}
            </div>
          ) : view === 'week' ? (
            <ScheduleWeek
              list={list}
              now={now}
              start={week}
              selected={selected?.id ?? ''}
              onSelect={select}
              onCreate={(at) => setEdit({ preset: { at: new Date(at).toISOString(), durationMin: 60 } })}
              onMove={moveTo}
              onResize={resize}
              onEdit={(s) => guard(() => setEdit(s))}
              onRun={(s) => void runNow(s)}
              onDelete={setDel}
            />
          ) : (
            <ScheduleMonth
              list={list}
              now={now}
              month={month}
              selected={selected?.id ?? ''}
              onSelect={select}
              onCreate={(at) => setEdit({ preset: { at: new Date(at).toISOString(), durationMin: 60 } })}
              onOpenDay={(day) => {
                setWeek(weekStartOf(day))
                setView('week')
              }}
            />
          )}
        </div>
      </main>

      {/* 详情：宽屏是右侧常驻的一块（宽度可拖），窄屏点了一条才从右边滑出来，盖住日历而不是把它挤扁 */}
      {calendar && selected && (
        <aside
          aria-label={t('计划详情')}
          style={{ '--panel-w': `${detailPane.width}px` } as CSSProperties}
          className={cn(
            'panel fixed inset-y-0 right-0 z-40 w-[min(380px,100%)] flex-col shadow-pop',
            'lg:relative lg:inset-auto lg:z-auto lg:flex lg:h-full lg:w-(--panel-w) lg:shrink-0 lg:shadow-none',
            detailOpen ? 'flex' : 'hidden',
          )}
        >
          <ResizeHandle pane={detailPane} label={t('拖动调整右栏宽度')} className="hidden lg:block" />
          <ScheduleDetail
            key={selected.id}
            schedule={selected}
            schedules={list ?? []}
            now={now}
            upstreams={upstreamNames(selected)}
            busy={busy === selected.id}
            taskTitle={taskTitle}
            onEdit={() => guard(() => setEdit(selected))}
            onRun={() => void runNow(selected)}
            onDelete={() => setDel(selected)}
            onOpenTask={(taskId) => openTask(taskId, selected.projectId)}
            onClose={() => guard(() => setDetailOpen(false))}
            onSaved={saved}
            onDirtyChange={onDetailDirty}
          />
        </aside>
      )}

      {edit && (
        <ScheduleDialog
          key={edit === 'new' ? 'new' : edit === 'blank' ? 'blank' : 'preset' in edit ? edit.preset.at : edit.id}
          schedule={edit === 'new' || edit === 'blank' || 'preset' in edit ? undefined : edit}
          blank={edit === 'blank' || (typeof edit === 'object' && 'preset' in edit)}
          preset={typeof edit === 'object' && 'preset' in edit ? edit.preset : undefined}
          schedules={list ?? []}
          onClose={() => setEdit(null)}
          onSaved={saved}
        />
      )}
      <ConfirmDialog
        open={!!discard}
        title={t('放弃没有保存的改动？')}
        description={t('详情面板里改过的设置还没有保存，离开后这些改动会丢掉。')}
        confirmText={t('放弃改动')}
        onOpenChange={(open) => !open && setDiscard(null)}
        onConfirm={() => {
          const action = discard
          setDiscard(null)
          setDetailDirty(false)
          action?.()
        }}
      />
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
    </div>
  )
}
