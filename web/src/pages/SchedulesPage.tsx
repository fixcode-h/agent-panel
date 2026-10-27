import { useEffect, useRef, useState } from 'react'
import { toast } from '@/lib/toast'
import { Plus } from 'lucide-react'
import { groupLabel, groupSchedules, SCHEDULE_TICK_MS, type Schedule } from '@shared/schedule'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { useData, useNav } from '@/lib/data'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/dialog'
import { PageFrame } from '@/components/library/parts'
import { ScheduleCard } from '@/components/schedule/ScheduleCard'
import { ScheduleDialog } from '@/components/schedule/ScheduleDialog'
import { ScheduleEmpty } from '@/components/schedule/ScheduleEmpty'
import { ScheduleOverview } from '@/components/schedule/ScheduleOverview'

const DEMO = !!import.meta.env.VITE_DEMO

/** 分组标题：组名 + 数量 */
function GroupHeading({ group, count }: { group: string; count: number }) {
  return (
    <h2 className="flex items-center gap-2 text-[0.8125rem] font-semibold text-muted">
      {group}
      <span className="rounded-full bg-field px-1.5 text-[0.6875rem] font-normal text-subtle tabular-nums">
        {count}
      </span>
    </h2>
  )
}

const toInput = (s: Schedule) => ({
  name: s.name,
  prompt: s.prompt,
  projectId: s.projectId,
  agentId: s.agentId,
  repeat: s.repeat,
  weekdays: s.weekdays,
  at: s.at,
  enabled: s.enabled,
  dependsOn: s.dependsOn,
  budget: s.budget,
})

export function SchedulesPage() {
  const { projects, agents, tasks } = useData()
  const { go } = useNav()
  const [list, setList] = useState<Schedule[] | null>(null)
  const [error, setError] = useState('')
  /** 相对时间（3 小时后）和数据一起算、一起刷：不和列表数据分开各算一次 */
  const [now, setNow] = useState(() => Date.now())
  /** 正在新建 / 编辑的那条；'new' 是模板新建，'blank' 是空白新建 */
  const [edit, setEdit] = useState<Schedule | 'new' | 'blank' | null>(null)
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
        <ScheduleEmpty onCreateTemplate={() => setEdit('new')} onCreateBlank={() => setEdit('blank')} />
      ) : (
        <>
          <ScheduleOverview
            buckets={buckets}
            now={now}
            onJumpToProblem={() =>
              document.getElementById('schedule-group-problem')?.scrollIntoView({ block: 'start', behavior: 'smooth' })
            }
          />
          {buckets.map(({ group, items }) => (
            <section key={group} id={`schedule-group-${group}`} className="flex scroll-mt-6 flex-col gap-2">
              <GroupHeading group={groupLabel(group)} count={items.length} />
              <ul className="flex flex-col gap-2">
                {items.map((s) => {
                  const project = projects.find((p) => p.id === s.projectId)
                  const agent = agents.find((a) => a.id === s.agentId)
                  return (
                    <ScheduleCard
                      key={s.id}
                      schedule={s}
                      now={now}
                      projectName={project?.name ?? ''}
                      agentName={agent?.name ?? ''}
                      upstreams={upstreamNames(s)}
                      busy={busy === s.id}
                      taskTitle={taskTitle}
                      onEdit={() => setEdit(s)}
                      onRun={() => void runNow(s)}
                      onToggle={(on) => void toggle(s, on)}
                      onDelete={() => setDel(s)}
                      onOpenTask={(taskId) => openTask(taskId, s.projectId)}
                    />
                  )
                })}
              </ul>
            </section>
          ))}
        </>
      )}

      {edit && (
        <ScheduleDialog
          key={edit === 'new' ? 'new' : edit === 'blank' ? 'blank' : edit.id}
          schedule={edit === 'new' || edit === 'blank' ? undefined : edit}
          blank={edit === 'blank'}
          schedules={list ?? []}
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
