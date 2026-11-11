import { useState } from 'react'
import { ChevronDown, Palette, Plus, Puzzle } from 'lucide-react'
import type { Task } from '@shared/schema'
import { usePlugins, useDesignModes } from '@/plugins/registry'
import type { DesignMode as PluginDesignMode } from '@/plugins/sdk'
import { useData, useNav, useTasks } from '@/lib/data'
import { cn } from '@/lib/utils'
import { Menu, MenuContent, MenuRadioGroup, MenuRadioItem, MenuTrigger } from '@/components/ui/menu'
import { IconButton } from '@/components/ui/icon-button'
import { EmptyPanel } from '@/components/ui/empty-panel'
import { Button } from '@/components/ui/button'
import { SIDEBAR_GROUP_LABEL, SidebarProjectName, SidebarProjectRow, SidebarTaskBlock } from '@/components/ui/sidebar'
import { TaskRow } from './SidebarTasks'
import { isTaskUnread, useUnreadTasks } from '@/lib/task-unread'
import { byAskedAt, taskPlugin } from '@shared/task'
import { t } from '@shared/i18n'

/**
 * 设计模式的侧栏（照设计稿 Design.dc.html）：最上面一个下拉在各种设计之间切换，下面是那一种的列表。
 * 设计都来自插件（ADR 0059）：UI 设计插件（ui-design，以前是面板自带的）、Blender 插件的模型设计……
 * - 插件自己给了侧栏（DesignMode.Sidebar，插件接口 4）就用它的，例如 UI 设计按它自己的项目列界面；
 * - 没给的：task.plugin 归它的对话，按所在项目分组列出来，在 #/pdesign/<模式>/<对话> 里打开，不进 Agent 模式。
 * 插件关掉或删掉后这一项就没了；一个都没有时提示去装。
 */

/** 选了哪种设计只是这台浏览器上的习惯（下次打开还停在这一种），读写失败时用第一种 */
const MODE_KEY = 'agent-panel:design-mode'
const readMode = () => {
  try {
    return localStorage.getItem(MODE_KEY) ?? ''
  } catch {
    return ''
  }
}

/** 进设计模式时停在哪一种：打开着的那种，否则这台浏览器上次选的，记的那种插件没了用第一种 */
export function currentDesignMode(routeMode: string | undefined, modes: PluginDesignMode[]) {
  if (routeMode && modes.some((m) => m.id === routeMode)) return routeMode
  const saved = readMode()
  return modes.some((m) => m.id === saved) ? saved : modes[0]?.id
}

export function DesignList() {
  const { route, go } = useNav()
  const plugins = useDesignModes()
  const [, setSaved] = useState(readMode)
  const mode = currentDesignMode(route.page === 'pdesign' ? route.id : undefined, plugins)
  const plugin = plugins.find((m) => m.id === mode)
  const pick = (m: string) => {
    setSaved(m)
    try {
      localStorage.setItem(MODE_KEY, m)
    } catch {}
    // 换了类型就换到那一类的页面：停在原页面的话，下一次渲染又按页面把下拉改回去
    if (!(route.page === 'pdesign' && route.id === m)) go({ page: 'pdesign', id: m })
  }
  if (!plugin) return <NoDesignPlugin />
  return (
    <div className="mt-2 flex min-h-0 flex-1 flex-col">
      <DesignModeSwitch value={plugin.id} onChange={pick} plugins={plugins} />
      {plugin.Sidebar ? <plugin.Sidebar /> : <PluginDesignList mode={plugin} />}
    </div>
  )
}

/** 一个设计插件都没开：说明设计来自插件，给一个去插件设置的按钮 */
function NoDesignPlugin() {
  const { openSettings } = useNav()
  const { loaded } = usePlugins()
  if (!loaded) return null
  return (
    <div className="mt-2 px-2.5">
      <EmptyPanel as="div" size="md" className="mx-0.5 flex flex-col items-center gap-2">
        <Palette className="h-5 w-5 text-subtle" strokeWidth={2} />
        <p className="text-xs leading-relaxed text-subtle">
          {t('设计都来自插件：UI 设计插件做游戏界面和网页，Blender 插件做模型。到设置 →「插件」里安装或打开。')}
        </p>
        <Button size="sm" variant="secondary" onClick={() => openSettings('plugins')}>
          <Puzzle className="h-3.5 w-3.5" />
          {t('去装插件')}
        </Button>
      </EmptyPanel>
    </div>
  )
}

/**
 * 设计类型下拉：40 高的整块按钮，左边带底色的小图标、名字和一行说明，右边小箭头；
 * 点开列出两种，选中项打勾。颜色借现成的状态色（run / peer），不另起一套色板
 */
function DesignModeSwitch({
  value,
  onChange,
  plugins,
}: {
  value: string
  onChange: (m: string) => void
  plugins: PluginDesignMode[]
}) {
  const modes = plugins.map((m) => ({ id: m.id, name: m.name, desc: m.desc, icon: m.icon, tone: m.tone ?? 'bg-peer' }))
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
 * 插件的设计模式：Agent 项目里 task.plugin 归它的顶层对话，按项目分组（只列有这类对话的项目）。
 * 点对话进对话页；对话自己的右键菜单（重命名、删除…）沿用 TaskRow，新建用插件给的弹窗
 */
function PluginDesignList({ mode }: { mode: PluginDesignMode }) {
  const { projects } = useData()
  const { tasks } = useTasks()
  const { route, go } = useNav()
  const [folded, setFolded] = useState<Set<string>>(new Set())
  const unread = useUnreadTasks()
  const [creating, setCreating] = useState(false)
  // 没给新建弹窗的模式（新建由它的整页管）：直接去它的空页面
  const create = () => (mode.NewDialog ? setCreating(true) : go({ page: 'pdesign', id: mode.id }))
  const models = tasks.filter((x: Task) => taskPlugin(x) === mode.id && x.projectId && !x.parentTaskId && !x.archived)
  const groups = projects
    .map((p) => ({ p, ts: models.filter((x) => x.projectId === p.id).sort(byAskedAt) }))
    .filter((g) => g.ts.length)
  return (
    <div className="scroll-fade flex min-h-0 flex-1 flex-col overflow-y-auto px-2.5 pb-2">
      <div className="mb-1.5 flex h-6 shrink-0 items-center pr-1 pl-2">
        <p className={cn('flex-1 font-semibold tracking-[0.08em]', SIDEBAR_GROUP_LABEL)}>{t('项目')}</p>
        <IconButton icon={Plus} label={mode.newLabel} size="sm" onClick={create} />
      </div>
      {!groups.length && (
        <EmptyPanel as="div" size="md" className="mx-0.5 mt-1 flex flex-col items-center gap-2">
          <mode.icon className="h-5 w-5 text-subtle" strokeWidth={2} />
          <p className="text-xs leading-relaxed text-subtle">{mode.empty}</p>
          <Button size="sm" variant="secondary" onClick={create}>
            <Plus className="h-3.5 w-3.5" />
            {mode.newLabel}
          </Button>
        </EmptyPanel>
      )}
      {mode.NewDialog ? (
        <mode.NewDialog
          open={creating}
          onOpenChange={setCreating}
          onCreated={(task) => go({ page: 'pdesign', id: mode.id, sub: task.id })}
        />
      ) : null}
      {groups.map(({ p, ts }) => {
        const open = !folded.has(p.id)
        return (
          <section key={p.id} className="mb-1 flex flex-col">
            <SidebarProjectRow
              open={open}
              onToggle={() => setFolded((f) => toggleKey(f, p.id))}
              count={ts.length}
              name={
                // 点项目名只是收起展开：项目主页在 Agent 模式里，模型设计不往那边跳
                <button
                  onClick={() => setFolded((f) => toggleKey(f, p.id))}
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
                    active={route.page === 'pdesign' && route.sub === x.id}
                    unread={isTaskUnread(x) || unread.includes(x.id)}
                    onOpen={() => go({ page: 'pdesign', id: mode.id, sub: x.id })}
                    onDeleted={() => route.sub === x.id && go({ page: 'pdesign', id: mode.id })}
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

/** 收起 / 展开：集合里有就去掉，没有就加上 */
function toggleKey(set: Set<string>, key: string): Set<string> {
  const next = new Set(set)
  if (!next.delete(key)) next.add(key)
  return next
}
