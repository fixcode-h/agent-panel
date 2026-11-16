import { useEffect, useState, type ReactNode } from 'react'
import { LayoutGrid, Layers } from 'lucide-react'
import type { Project } from '@shared/schema'
import { t } from '@shared/i18n'
import { sortProjects } from '@shared/projects/order'
import { useData, useNav } from '@/lib/data'
import { isMac } from '@/lib/hotkey'
import { cn } from '@/lib/utils'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
  menuItem,
} from '@/components/ui/menu'
import { MenuSearch } from '@/components/ui/menu-search'
import { InlineRename } from '@/components/ui/inline-rename'
import { StatusPill } from '@/components/ui/status-pill'
import { ProjectRunning, SidebarCount } from '@/components/ui/sidebar'
import {
  AddFirstProject,
  ProjectPickerLoading,
  ProjectNewRow,
  ProjectPickerGroup,
  ProjectPickerRow,
  ProjectSwitcherButton,
} from '@/components/ui/project-switcher'
import { EMPTY_STAT, type ProjectStat } from './project-stats'
import type { useProjectActions } from './project-actions'

/** 打开项目下拉的快捷键（设计稿 B2：搜索框里写着 Ctrl P） */
export const PICK_PROJECT_KEY = isMac ? '⌘P' : 'Ctrl P'

/** 行尾状态：等你处理 > 执行中 > 对话数（和侧栏原来的项目行同一个优先级） */
export function ProjectStatus({ stat, on }: { stat: ProjectStat; on?: boolean }) {
  if (stat.needs)
    return (
      <StatusPill tone="wait" className="h-[18px] px-[7px] text-caption font-medium">
        {t('等你处理')}
      </StatusPill>
    )
  if (stat.running) return <ProjectRunning n={stat.running} />
  return stat.count ? <SidebarCount n={stat.count} on={on} /> : null
}

/** 项目按分类分组：分类按设置里的顺序，没分类的放最后；只有一组时不写组名 */
function groupByCategory(projects: Project[], categories: { id: string; name: string }[]) {
  const sorted = sortProjects(projects)
  const groups = categories
    .map((c) => ({ id: c.id, label: c.name, items: sorted.filter((p) => p.categoryId === c.id) }))
    .filter((g) => g.items.length)
  const known = new Set(groups.map((g) => g.id))
  const rest = sorted.filter((p) => !known.has(p.categoryId))
  if (rest.length) groups.push({ id: '', label: t('未分类'), items: rest })
  return groups
}

/**
 * 侧栏顶上的项目切换器（方案 B，效果图 B、B2）：显示当前项目，点开（或 Ctrl P）是下拉：
 * 搜索、「新建项目」、按分类分组的项目（带状态）、底下「全部项目」「管理项目分类」。
 * 右键切换器是这个项目的操作菜单（原来项目树行上的右键菜单）。一个项目都没有时换成「添加第一个项目」
 */
export function ProjectPicker({
  current,
  stats,
  actions,
  hotkey,
}: {
  current: Project | undefined
  stats: Map<string, ProjectStat>
  actions: ReturnType<typeof useProjectActions>
  /** 只给宽屏侧栏那一份挂快捷键：手机抽屉里还有一份，同一个键不能开两个下拉 */
  hotkey?: boolean
}) {
  const { route, go, openProject, openSettings } = useNav()
  const { projects, categories, loading } = useData()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  useEffect(() => {
    if (!hotkey) return
    const onKey = (e: KeyboardEvent) => {
      // 浏览器的 Ctrl+P 是打印：面板里拿来切项目，和常见编辑器的「快速打开」一致
      if ((isMac ? e.metaKey : e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        setOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hotkey])
  useEffect(() => {
    if (!open) setQuery('')
  }, [open])

  // 还在取项目列表（服务刚启动时可能要好几秒）：先占位，不能显示「添加第一个项目」，
  // 不然用户以为旧项目没了，点进去是一个空的新建项目
  if (!current) return loading ? <ProjectPickerLoading /> : <AddFirstProject onClick={() => openProject()} />

  const q = query.trim().toLowerCase()
  const hits = q
    ? projects.filter((p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q))
    : projects
  const groups = groupByCategory(hits, categories)
  const stat = stats.get(current.id) ?? EMPTY_STAT
  const category = categories.find((c) => c.id === current.categoryId)?.name
  const meta = [category || current.path, stat.running ? t('{n} 个执行中', { n: stat.running }) : '']
    .filter(Boolean)
    .join(' · ')
  // 别的项目有对话在等你处理：切换器上亮一个黄点，不然切走以后就看不到了
  const othersNeed = [...stats.entries()].some(([pid, s]) => pid !== current.id && s.needs > 0)
  const pick = (p: Project) => {
    setOpen(false)
    // 正在看项目工具页时切项目，留在同一个工具（新项目没打开这个工具时插件页自己会说明）
    // （插件的子位置以项目 id 开头，换项目时从新项目那一层开始）
    if (route.page === 'plugin' && route.project) go({ ...route, project: p.id, msg: p.id })
    else go({ page: 'projects', id: p.id })
  }
  const close = (fn: () => void) => () => {
    setOpen(false)
    fn()
  }

  if (actions.renaming === current.id)
    return (
      <InlineRename
        value={current.name}
        label={t('项目名称')}
        onCommit={(v) => actions.rename(current, v)}
        onCancel={() => actions.setRenaming('')}
        className="h-12"
      />
    )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <PopoverTrigger asChild>
            <ProjectSwitcherButton
              data-project-switcher
              name={current.name}
              meta={meta}
              alert={othersNeed ? t('其他项目有对话在等你处理') : undefined}
              aria-label={t('当前项目「{name}」，点开切换项目', { name: current.name })}
              title={t('切换项目（{key}），右键查看更多操作', { key: PICK_PROJECT_KEY })}
            />
          </PopoverTrigger>
        </ContextMenuTrigger>
        <ContextMenuContent>{actions.menu(current, ContextMenuItem, ContextMenuSeparator)}</ContextMenuContent>
      </ContextMenu>
      <PopoverContent className="w-[max(var(--radix-popover-trigger-width),18rem)]">
        <div data-project-picker className="flex max-h-[min(70vh,560px)] flex-col">
          <MenuSearch
            value={query}
            onChange={setQuery}
            placeholder={t('搜索项目')}
            onKeyDown={(e) => {
              // 回车直接打开第一个搜到的项目
              const first = groups[0]?.items[0]
              if (e.key === 'Enter' && first) pick(first)
            }}
            className="pr-1.5"
          />
          <ProjectNewRow hint={t('选目录、选能力')} onClick={close(() => openProject())} className="mb-1" />
          <div className="scroll-fade min-h-0 flex-1 overflow-y-auto">
            {groups.map((g) => (
              <div key={g.id || '_'} role="group" aria-label={g.label}>
                {groups.length > 1 && <ProjectPickerGroup label={g.label} />}
                {g.items.map((p) => (
                  <ProjectPickerRow
                    key={p.id}
                    name={p.name}
                    on={p.id === current.id}
                    title={p.path || undefined}
                    status={<ProjectStatus stat={stats.get(p.id) ?? EMPTY_STAT} on={p.id === current.id} />}
                    onClick={() => pick(p)}
                  />
                ))}
              </div>
            ))}
            {!groups.length && <p className="px-2.5 py-3 text-caption text-subtle">{t('没有符合的项目。')}</p>}
          </div>
          <div className="mt-1 border-t border-line pt-1">
            <FooterRow
              icon={<LayoutGrid className="h-4 w-4 text-subtle" />}
              label={t('全部项目')}
              onClick={close(() => go({ page: 'projects' }))}
            />
            <FooterRow
              icon={<Layers className="h-4 w-4 text-subtle" />}
              label={t('管理项目分类')}
              onClick={close(() => openSettings('categories'))}
            />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function FooterRow({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={cn(menuItem, 'h-9 py-0')}>
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  )
}
