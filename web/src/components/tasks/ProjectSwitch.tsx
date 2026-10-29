import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, FolderGit2 } from 'lucide-react'
import type { Project } from '@shared/schema'
import { t } from '@shared/i18n'
import { byAskedAt, convStateText, taskState } from '@shared/task'
import { useData, type Route } from '@/lib/data'
import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger, menuItem } from '@/components/ui/menu'

/** 状态的说法和颜色：文字用全站同一份（convStateText），这里只按状态分组给颜色 */
function stateTone(state: ReturnType<typeof taskState>) {
  if (state === 'running') return 'text-accent-text'
  if (state === 'needs') return 'text-warning'
  if (state === 'failed') return 'text-danger'
  if (state === 'done') return 'text-success'
  return 'text-subtle'
}

/**
 * 标题栏左上角的项目名。点开是当前项目下的对话，点一项就地打开；
 * 原来「点项目名直接进项目页」的动作挪到浮层底部的「打开项目」。
 * Chat 模式（没有项目）列最近的聊天，底部是「打开聊天」。
 */
export function ProjectSwitch({
  project,
  currentTaskId,
  onGo,
}: {
  project?: Project
  currentTaskId: string
  onGo: (r: Route) => void
}) {
  const { tasks } = useData()
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const items = useRef<(HTMLButtonElement | null)[]>([])
  const panel = useRef<HTMLDivElement | null>(null)
  const wasOpen = useRef(false)
  // 和侧栏、项目首页同一份筛选和排序：归档的、子对话不占项目下的列表，最近发言的在前
  const list = useMemo(
    () =>
      tasks
        .filter((x) => !x.archived && !x.parentTaskId && (project ? x.projectId === project.id : !x.projectId))
        .sort(byAskedAt),
    [tasks, project],
  )
  // 只在打开时从当前这条开始选：打开期间 tasks 会随摘要刷新换新数组，不能把用户移到的位置拨回来
  useEffect(() => {
    if (!open) {
      wasOpen.current = false
      return
    }
    if (!wasOpen.current) {
      wasOpen.current = true
      const i = list.findIndex((x) => x.id === currentTaskId)
      setActive(i < 0 ? 0 : i)
      return
    }
    // 列表变短时下标要落在有效范围内（最后一项是「打开项目」）
    setActive((i) => Math.min(i, list.length))
  }, [open, list, currentTaskId])
  // 列表比浮层高时，键盘选中的那项要跟着滚进可视区
  useEffect(() => {
    if (open && active < list.length) items.current[active]?.scrollIntoView({ block: 'nearest' })
  }, [open, active, list.length])
  // Radix 打开时焦点落在 Content 上，按键不会冒泡到里面监听的方向键：把焦点放到监听的这层
  useEffect(() => {
    if (!open) return
    const id = requestAnimationFrame(() => panel.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [open])
  const openTask = (id: string) => {
    setOpen(false)
    onGo(project ? { page: 'projects', id: project.id, sub: id } : { page: 'chat', id })
  }
  const openProject = () => {
    setOpen(false)
    onGo(project ? { page: 'projects', id: project.id } : { page: 'chat' })
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className="hidden max-w-[30%] shrink-0 cursor-pointer truncate rounded-md px-1.5 py-1 text-muted hover:bg-sel hover:text-fg data-[state=open]:bg-sel data-[state=open]:text-fg sm:block">
        {project?.name ?? t('聊天')}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(340px,calc(100vw-24px))] p-0">
        <div
          ref={panel}
          tabIndex={-1}
          className="outline-none"
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive((i) => Math.min(i + 1, list.length))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((i) => Math.max(i - 1, 0))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              if (active < list.length) openTask(list[active].id)
              else openProject()
            }
          }}
        >
          <div className="max-h-[min(60vh,22rem)] overflow-y-auto p-1">
            {list.map((x, i) => {
              const state = taskState(x)
              const current = x.id === currentTaskId
              return (
                <button
                  key={x.id}
                  ref={(el) => {
                    items.current[i] = el
                  }}
                  type="button"
                  tabIndex={-1}
                  title={x.title}
                  aria-current={current ? 'true' : undefined}
                  onClick={() => openTask(x.id)}
                  onMouseEnter={() => setActive(i)}
                  className={cn(
                    'flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[0.8125rem] outline-none',
                    i === active ? 'bg-sel text-fg' : 'text-muted',
                  )}
                >
                  <span className="flex w-1.5 shrink-0 justify-center">
                    {current && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent" />}
                  </span>
                  <span className={cn('min-w-0 flex-1 truncate', current && 'font-medium text-fg')}>{x.title}</span>
                  <span className={cn('shrink-0 text-[0.6875rem]', stateTone(state))}>{convStateText(state)}</span>
                </button>
              )
            })}
            {!list.length && (
              <p className="px-2 py-2 text-xs text-subtle">{project ? t('这个项目还没有对话') : t('还没有聊天。')}</p>
            )}
          </div>
          <div className="border-t p-1">
            <button
              type="button"
              tabIndex={-1}
              onClick={openProject}
              onMouseEnter={() => setActive(list.length)}
              className={cn(menuItem, 'gap-2 py-1.5', active === list.length && 'bg-sel text-fg')}
            >
              <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-subtle" />
              <span className="min-w-0 flex-1 truncate">{project ? t('打开项目') : t('打开聊天')}</span>
              <ArrowRight className="h-3.5 w-3.5 shrink-0 text-subtle" />
            </button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
