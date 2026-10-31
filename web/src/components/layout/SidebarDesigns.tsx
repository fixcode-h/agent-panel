import { useState } from 'react'
import {
  Box,
  ChevronDown,
  ChevronRight,
  CopyPlus,
  Folder,
  FolderInput,
  Gamepad2,
  Globe,
  LayoutTemplate,
  PencilLine,
  Plus,
  Settings2,
  Trash2,
  Palette,
} from 'lucide-react'
import { toast } from '@/lib/toast'
import type { DesignMeta, DesignProject } from '@shared/design'
import type { Task } from '@shared/schema'
import { DesignProjectDialog, type DesignProjectSection } from '@/components/design/DesignProjectDialog'
import { NewModelDesignDialog } from '@/components/design/NewModelDesignDialog'
import { api } from '@/lib/api'
import { useData, useNav } from '@/lib/data'
import { cn } from '@/lib/utils'
import { DESIGN_HOME, designHomeRoute, designKind, kindFoldKey, kindLabel, toggleFoldKey } from '@/lib/design-projects'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
  Menu,
  MenuContent,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from '@/components/ui/menu'
import { ConfirmDialog } from '@/components/ui/dialog'
import { IconButton } from '@/components/ui/icon-button'
import { InlineRename } from '@/components/ui/inline-rename'
import { EmptyPanel } from '@/components/ui/empty-panel'
import { Button } from '@/components/ui/button'
import {
  SIDEBAR_BLOCK_ROW_OFF,
  SIDEBAR_BLOCK_ROW_ON,
  SIDEBAR_GROUP_LABEL,
  SidebarCount,
  SidebarProjectName,
  SidebarProjectRow,
  PROJECT_CARD,
  PROJECT_CARD_OFF,
  PROJECT_CARD_ON,
  SidebarTaskBlock,
  TaskRowStatus,
} from '@/components/ui/sidebar'
import { TaskRow } from './SidebarTasks'
import { isTaskUnread, useUnreadTasks } from '@/lib/task-unread'
import { byAskedAt } from '@shared/task'
import { t } from '@shared/i18n'

/**
 * 设计模式的侧栏（照设计稿 Design.dc.html）：最上面一个下拉在「UI 设计 / 模型设计」之间切换，下面按项目列。
 * - UI 设计：UI 设计自己的项目（和 Agent 的项目分开），展开后是这个项目的各个界面。
 * - 模型设计：带 modelDesign 标记的对话（ADR 0025），按所在项目分组列出来，在 #/model 里打开，不进 Agent 模式。
 */
const KINDS = [
  { id: 'game', icon: Gamepad2 },
  { id: 'web', icon: Globe },
] as const

type DesignMode = 'ui' | 'model'
/** 选了哪种设计只是这台浏览器上的习惯（下次打开还停在这一种），读写失败时退回 UI 设计 */
const MODE_KEY = 'agent-panel:design-mode'
const readMode = (): DesignMode => {
  try {
    return localStorage.getItem(MODE_KEY) === 'model' ? 'model' : 'ui'
  } catch {
    return 'ui'
  }
}

export function DesignList() {
  const { route, go } = useNav()
  const [saved, setMode] = useState<DesignMode>(readMode)
  // 打开着模型对话（#/model）时侧栏一定是模型设计，打开着 UI 设计时一定是 UI 设计，不看上次记的
  const mode: DesignMode = route.page === 'model' ? 'model' : route.page === 'design' && route.id ? 'ui' : saved
  const pick = (m: DesignMode) => {
    setMode(m)
    try {
      localStorage.setItem(MODE_KEY, m)
    } catch {}
    // 换了类型就换到那一类的页面：停在原页面的话，下一次渲染又按页面把下拉改回去
    if (m === 'model' && route.page !== 'model') go({ page: 'model' })
    if (m === 'ui' && route.page === 'model') go({ page: 'design' })
  }
  return (
    <div className="mt-2 flex min-h-0 flex-1 flex-col">
      <DesignModeSwitch value={mode} onChange={pick} />
      {mode === 'model' ? <ModelDesignList /> : <UiDesignList />}
    </div>
  )
}

/**
 * 设计类型下拉：40 高的整块按钮，左边带底色的小图标、名字和一行说明，右边小箭头；
 * 点开列出两种，选中项打勾。颜色借现成的状态色（run / peer），不另起一套色板
 */
function DesignModeSwitch({ value, onChange }: { value: DesignMode; onChange: (m: DesignMode) => void }) {
  const modes = [
    { id: 'ui' as const, name: t('UI 设计'), desc: t('界面 · 原画 · 切图'), icon: LayoutTemplate, tone: 'bg-run' },
    { id: 'model' as const, name: t('模型设计'), desc: t('Blender 建模 · 按项目对话'), icon: Box, tone: 'bg-peer' },
  ]
  const cur = modes.find((m) => m.id === value) ?? modes[0]
  const tile = (m: (typeof modes)[number], size: string) => (
    <span className={cn('grid shrink-0 place-items-center rounded-lg text-on-primary', size, m.tone)}>
      <m.icon className="h-3.5 w-3.5" strokeWidth={2.3} />
    </span>
  )
  return (
    <div className="mb-1.5 shrink-0 px-3">
      <Menu>
        <MenuTrigger asChild>
          <button
            type="button"
            aria-label={t('切换设计类型')}
            data-design-mode={value}
            // 下拉按钮要看得出是一个可点的框：白底 + 一圈细线（输入框同一类），按下时底色加深一档
            className="group/kind flex h-10 w-full cursor-pointer items-center gap-2.5 rounded-xl bg-card px-2.5 text-left shadow-[0_0_0_1px_var(--line-strong)] transition-colors outline-none hover:bg-panel focus-visible:ring-2 focus-visible:ring-focus-soft data-[state=open]:bg-sel"
          >
            {tile(cur, 'h-[26px] w-[26px]')}
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-body font-semibold">{cur.name}</span>
              <span className="truncate text-caption text-subtle">{cur.desc}</span>
            </span>
            <ChevronDown
              aria-hidden
              className="h-3.5 w-3.5 shrink-0 text-subtle transition-transform group-data-[state=open]/kind:rotate-180"
              strokeWidth={2.2}
            />
          </button>
        </MenuTrigger>
        <MenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width) rounded-xl p-1">
          <MenuRadioGroup value={value} aria-label={t('设计类型')}>
            {modes.map((m) => (
              <MenuRadioItem
                key={m.id}
                value={m.id}
                onSelect={() => m.id !== value && onChange(m.id)}
                className="h-auto gap-2.5 rounded-xl p-2"
              >
                {tile(m, 'h-7 w-7')}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-body font-semibold">{m.name}</span>
                  <span className="truncate text-caption text-subtle">{m.desc}</span>
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuContent>
      </Menu>
    </div>
  )
}

/**
 * 模型设计：Agent 项目里带 modelDesign 标记的顶层对话，按项目分组（只列有模型对话的项目）。
 * 点项目名打开那个 Agent 项目，点对话进对话页；对话自己的右键菜单（重命名、删除…）沿用 TaskRow
 */
function ModelDesignList() {
  const { projects, tasks } = useData()
  const { route, go } = useNav()
  const [folded, setFolded] = useState<Set<string>>(new Set())
  const unread = useUnreadTasks()
  const [creating, setCreating] = useState(false)
  const models = tasks.filter((x: Task) => x.modelDesign && x.projectId && !x.parentTaskId && !x.archived)
  const groups = projects
    .map((p) => ({ p, ts: models.filter((x) => x.projectId === p.id).sort(byAskedAt) }))
    .filter((g) => g.ts.length)
  return (
    <div className="scroll-fade flex min-h-0 flex-1 flex-col overflow-y-auto px-2.5 pb-2">
      <div className="mb-1.5 flex h-6 shrink-0 items-center pr-1 pl-2">
        <p className={cn('flex-1 font-semibold tracking-[0.08em]', SIDEBAR_GROUP_LABEL)}>{t('项目')}</p>
        <IconButton icon={Plus} label={t('新建模型设计')} size="sm" onClick={() => setCreating(true)} />
      </div>
      {!groups.length && (
        <EmptyPanel as="div" size="md" className="mx-0.5 mt-1 flex flex-col items-center gap-2">
          <Box className="h-5 w-5 text-subtle" strokeWidth={2} />
          <p className="text-xs leading-relaxed text-subtle">
            {t('还没有模型设计对话。模型设计用 Blender 建模，对话会按项目列在这里。')}
          </p>
          <Button size="sm" variant="secondary" onClick={() => setCreating(true)}>
            <Plus className="h-3.5 w-3.5" />
            {t('新建模型设计')}
          </Button>
        </EmptyPanel>
      )}
      <NewModelDesignDialog open={creating} onOpenChange={setCreating} />
      {groups.map(({ p, ts }) => {
        const open = !folded.has(p.id)
        return (
          <section key={p.id} className="mb-1 flex flex-col">
            <SidebarProjectRow
              open={open}
              onToggle={() => setFolded((f) => toggleFoldKey(f, p.id))}
              count={ts.length}
              name={
                // 点项目名只是收起展开：项目主页在 Agent 模式里，模型设计不往那边跳
                <button
                  onClick={() => setFolded((f) => toggleFoldKey(f, p.id))}
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
                >
                  <SidebarProjectName open={open} name={p.name} />
                </button>
              }
            />
            {open && (
              <SidebarTaskBlock>
                {ts.map((x) => (
                  <TaskRow
                    key={x.id}
                    task={x}
                    active={route.page === 'model' && route.id === x.id}
                    unread={isTaskUnread(x) || unread.includes(x.id)}
                    onOpen={() => go({ page: 'model', id: x.id })}
                    onDeleted={() => route.page === 'model' && route.id === x.id && go({ page: 'model' })}
                    inBlock
                    className="pr-2 pl-2"
                  />
                ))}
              </SidebarTaskBlock>
            )}
          </section>
        )
      })}
    </div>
  )
}

function UiDesignList() {
  const { designProjects: projects, setDesignProjects, designs, setDesigns } = useData()
  const { route, go } = useNav()
  const [folded, setFolded] = useState<Set<string>>(new Set())
  const [renaming, setRenaming] = useState('')
  const [deleting, setDeleting] = useState<DesignMeta>()
  // 新建（null）或编辑项目；undefined 表示没打开
  const [editing, setEditing] = useState<DesignProject | null>()
  const [section, setSection] = useState<DesignProjectSection>('general')
  const [removingProject, setRemovingProject] = useState<DesignProject>()
  const byProject = new Map<string, DesignMeta[]>()
  for (const d of [...designs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)))
    byProject.set(d.projectId, [...(byProject.get(d.projectId) ?? []), d])
  const last = (pid: string, fallback: string) => byProject.get(pid)?.[0]?.updatedAt ?? fallback
  const list = [...projects].sort((a, b) => last(b.id, b.updatedAt).localeCompare(last(a.id, a.updatedAt)))
  // 项目和分类（`项目id:分类id`）共用一份折叠集合。只有最前面的箭头按钮和分类行改这个集合，
  // 点项目名是打开项目主页，不再顺带折叠
  const toggleFold = (key: string) => setFolded((f) => toggleFoldKey(f, key))

  const rename = async (d: DesignMeta, title: string) => {
    setRenaming('')
    title = title.trim()
    if (!title || title === d.title) return
    try {
      const f = await api.design(d.id)
      await api.saveDesign(d.id, {
        title,
        data: f.data,
        designSize: f.designSize,
        style: f.style,
        root: f.root,
        components: f.components,
        annotations: f.annotations,
        images: f.images,
        animations: f.animations,
      })
      setDesigns((l) => l.map((x) => (x.id === d.id ? { ...x, title } : x)))
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  const remove = async (d: DesignMeta) => {
    try {
      await api.deleteDesign(d.id)
      setDesigns((l) => l.filter((x) => x.id !== d.id))
      if (route.page === 'design' && route.id === d.id) go({ page: 'design' })
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setDeleting(undefined)
    }
  }

  const copy = async (d: DesignMeta) => {
    try {
      const c = await api.copyDesign(d.id)
      setDesigns((l) => [
        ...l,
        {
          id: c.id,
          projectId: c.projectId,
          kind: c.kind,
          title: c.title,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
        },
      ])
      go({ page: 'design', id: c.id })
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  const move = async (d: DesignMeta, projectId: string) => {
    try {
      await api.moveDesign(d.id, projectId)
      setDesigns((l) => l.map((x) => (x.id === d.id ? { ...x, projectId } : x)))
      // 目标项目如果折叠着就展开，能看到移过去的设计
      setFolded((f) => {
        const n = new Set(f)
        n.delete(projectId)
        return n
      })
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  const removeProject = async (p: DesignProject) => {
    try {
      await api.deleteDesignProject(p.id)
      setDesignProjects((l) => l.filter((x) => x.id !== p.id))
      setDesigns((l) => l.filter((x) => x.projectId !== p.id))
      if (route.page === 'design' && designs.some((d) => d.id === route.id && d.projectId === p.id))
        go({ page: 'design' })
      // 正停在这个项目的主页上：项目没了就回新建设计页
      else if (route.page === 'design' && route.id === DESIGN_HOME && route.sub === p.id) go({ page: 'design' })
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setRemovingProject(undefined)
    }
  }

  /** 侧栏里的一个设计 */
  const designRow = (d: DesignMeta) => {
    const on = route.page === 'design' && route.id === d.id
    return (
      <ContextMenu key={d.id}>
        <ContextMenuTrigger asChild>
          <div
            // 整行都能点：以前只有文字能点，点到图标或空白处没反应，像是要点两次
            onClick={() => renaming !== d.id && go({ page: 'design', id: d.id })}
            className={cn(
              'ml-1 flex h-[31px] cursor-pointer items-center gap-2 rounded-lg border pr-2 pl-[11px] text-body transition-colors',
              // 设计行和 Agent 项目下的对话行一样：平时无底、悬停浅底，选中是一张白卡片 + 极淡投影
              on ? SIDEBAR_BLOCK_ROW_ON : SIDEBAR_BLOCK_ROW_OFF,
            )}
          >
            {d.kind === 'web' ? (
              <Globe className="h-3.5 w-3.5 shrink-0 text-subtle" />
            ) : (
              <Gamepad2 className="h-3.5 w-3.5 shrink-0 text-subtle" />
            )}
            {renaming === d.id ? (
              <InlineRename
                value={d.title}
                label={t('设计名称')}
                size="sm"
                onCommit={(v) => void rename(d, v)}
                onCancel={() => setRenaming('')}
                className="flex-1"
              />
            ) : (
              // 点击冒泡到整行去跳转；保留按钮是为了能用键盘选中
              <button className="min-w-0 flex-1 cursor-pointer truncate text-left">{d.title}</button>
            )}
            {/* 行尾状态和 Agent 侧栏的对话行同一个部件（设计稿：行尾放「等你 / 进行中」小标签） */}
            {renaming !== d.id && <TaskRowStatus needs={d.asking} running={d.running} />}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => setRenaming(d.id)}>
            <PencilLine className="h-4 w-4" />
            {t('重命名')}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => void copy(d)}>
            <CopyPlus className="h-4 w-4" />
            {t('创建副本')}
          </ContextMenuItem>
          {projects.length > 1 && (
            <ContextMenuSub>
              <ContextMenuSubTrigger>
                <FolderInput className="h-4 w-4" />
                {t('移到项目')}
              </ContextMenuSubTrigger>
              <ContextMenuSubContent>
                {projects
                  .filter((x) => x.id !== d.projectId)
                  .map((x) => (
                    <ContextMenuItem key={x.id} onSelect={() => void move(d, x.id)}>
                      <Folder className="h-4 w-4 text-subtle" />
                      {x.name}
                    </ContextMenuItem>
                  ))}
              </ContextMenuSubContent>
            </ContextMenuSub>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem danger onSelect={() => setDeleting(d)}>
            <Trash2 className="h-4 w-4" />
            {t('删除')}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    )
  }

  return (
    <div className="scroll-fade flex min-h-0 flex-1 flex-col overflow-y-auto px-2.5 pb-2">
      <div className="mb-1.5 flex h-6 shrink-0 items-center pr-1 pl-2">
        {/* 上面的下拉已经写了是 UI 设计，分组标题只写「项目」（照设计稿） */}
        <p className={cn('flex-1 font-semibold tracking-[0.08em]', SIDEBAR_GROUP_LABEL)}>{t('项目')}</p>
        <IconButton icon={Plus} label={t('新建 UI 项目')} onClick={() => setEditing(null)} />
      </div>
      {!projects.length && (
        <EmptyPanel as="div" size="md" className="mx-0.5 mt-1 flex flex-col items-center gap-2">
          <Palette className="h-5 w-5 text-subtle" strokeWidth={2} />
          <p className="text-xs leading-relaxed text-subtle">
            {t('还没有 UI 项目。UI 设计的项目和 Agent 的项目是分开的。')}
          </p>
          <Button variant="link" onClick={() => setEditing(null)} className="text-xs font-medium">
            {t('新建 UI 项目')}
          </Button>
        </EmptyPanel>
      )}
      {list.map((p) => {
        const ds = byProject.get(p.id) ?? []
        const open = !folded.has(p.id)
        const on = route.page === 'design' && route.id === DESIGN_HOME && route.sub === p.id
        return (
          <section key={p.id} className="mb-1 flex flex-col">
            <ContextMenu>
              <ContextMenuTrigger asChild>
                {/* 整行只是排成一行的容器：点空白处不展开也不打开，展开 / 打开各有自己的按钮；
                    折叠箭头在卡片外，和 Agent 侧栏的项目卡片一样（照设计稿 Workspace 侧栏） */}
                <div className="group/proj flex items-center gap-1">
                  <button
                    // 折叠只由这个箭头按钮触发：以前整行可点、靠冒泡折叠，点项目名打不开主页
                    onClick={() => toggleFold(p.id)}
                    // 界面检查按项目定位这个按钮：侧栏里 Agent 项目行也有同名「收起」按钮，不能靠 DOM 顺序取第一个
                    data-fold={p.id}
                    aria-expanded={open}
                    aria-label={open ? t('收起') : t('展开')}
                    disabled={!ds.length}
                    className={cn(
                      'grid h-6 w-3 shrink-0 cursor-pointer place-items-center rounded-md text-subtle transition-colors hover:text-fg',
                      !ds.length && 'invisible',
                    )}
                  >
                    <ChevronRight
                      className={cn('h-3 w-3 transition-transform', open && 'rotate-90')}
                      strokeWidth={2.3}
                    />
                  </button>
                  <div className={cn(PROJECT_CARD, on ? PROJECT_CARD_ON : PROJECT_CARD_OFF)}>
                    <button
                      onClick={() => go(designHomeRoute(p.id))}
                      aria-label={t('打开项目「{name}」，右键查看更多操作', { name: p.name })}
                      title={t('打开项目「{name}」，右键查看更多操作', { name: p.name })}
                      className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
                    >
                      <SidebarProjectName open={open} on={on} name={p.name} />
                    </button>
                    {ds.length > 0 && <SidebarCount n={ds.length} on={on} className="group-hover/proj:hidden" />}
                    <IconButton
                      icon={Plus}
                      onClick={() => go({ page: 'design', id: 'new', sub: p.id })}
                      label={t('在「{name}」新建设计', { name: p.name })}
                      title={t('新建设计')}
                      className={cn(
                        ds.length ? 'hidden' : 'opacity-60',
                        'group-hover/proj:grid group-hover/proj:opacity-100',
                      )}
                    />
                  </div>
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem onSelect={() => go({ page: 'design', id: 'new', sub: p.id })}>
                  <Plus className="h-4 w-4" />
                  {t('新建设计')}
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => (setSection('general'), setEditing(p))}>
                  <Settings2 className="h-4 w-4" />
                  {t('项目设置')}
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => (setSection('prompts'), setEditing(p))}>
                  <Palette className="h-4 w-4" />
                  {t('美术提示词')}
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem danger onSelect={() => setRemovingProject(p)}>
                  <Trash2 className="h-4 w-4" />
                  {t('删除项目')}
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
            {open && ds.length > 0 && (
              <SidebarTaskBlock>
                {/* 同一个项目里游戏 UI 和网页 UI 分开列，各自可以收起 */}
                {KINDS.filter((k) => ds.some((d) => designKind(d) === k.id)).map((k) => {
                  const list = ds.filter((d) => designKind(d) === k.id)
                  const key = kindFoldKey(p.id, k.id)
                  const kOpen = !folded.has(key)
                  return (
                    <div key={k.id} className="flex flex-col gap-px">
                      <button
                        data-kind={k.id}
                        onClick={() => toggleFold(key)}
                        aria-expanded={kOpen}
                        className="ml-1 flex h-7 cursor-pointer items-center gap-1.5 rounded-lg pr-2 pl-[9px] text-footnote text-subtle transition-colors hover:bg-sel hover:text-fg"
                      >
                        <ChevronRight className={cn('h-3 w-3 shrink-0 transition-transform', kOpen && 'rotate-90')} />
                        <k.icon className="h-3.5 w-3.5 shrink-0" />
                        <span className="min-w-0 flex-1 truncate text-left">{kindLabel(k.id)}</span>
                        <span className="shrink-0 text-caption tabular-nums">{list.length}</span>
                      </button>
                      {kOpen && <div className="ml-2 flex flex-col gap-px">{list.map(designRow)}</div>}
                    </div>
                  )
                })}
              </SidebarTaskBlock>
            )}
          </section>
        )
      })}
      <DesignProjectDialog
        open={editing !== undefined}
        onOpenChange={(o) => !o && setEditing(undefined)}
        project={editing ?? undefined}
        section={editing ? section : 'general'}
        onSaved={(np) => !editing && go({ page: 'design', id: 'new', sub: np.id })}
      />
      <ConfirmDialog
        open={!!removingProject}
        onOpenChange={(o) => !o && setRemovingProject(undefined)}
        title={t('删除项目「{name}」？', { name: removingProject?.name ?? '' })}
        description={t('会一起删除这个项目里的 {n} 个设计和它们的图片，本机目录里导出的文件不受影响。', {
          n: designs.filter((d) => d.projectId === removingProject?.id).length,
        })}
        onConfirm={() => removingProject && removeProject(removingProject)}
      />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(undefined)}
        title={t('删除「{name}」？', { name: deleting?.title ?? '' })}
        description={t('会删除这个设计的控件树、对话和生成的图片。')}
        onConfirm={() => deleting && void remove(deleting)}
      />
    </div>
  )
}
