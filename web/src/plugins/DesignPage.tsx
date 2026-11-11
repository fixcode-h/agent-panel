import { useEffect, useState } from 'react'
import { Plus, Puzzle } from 'lucide-react'
import { t } from '@shared/i18n'
import { useNav, useTasks } from '@/lib/data'
import { TaskView } from '@/components/tasks/TaskView'
import { Button } from '@/components/ui/button'
import { usePlugins, useDesignModes } from './registry'
import { currentDesignMode } from '@/components/layout/SidebarDesigns'

/**
 * 插件的设计模式页（#/pdesign/<模式>/<对话>，ADR 0059）：打开的是 task.plugin 归这个模式的对话。
 * 对话数据仍挂在某个项目下（插件的产物、命令都在项目目录里），但它属于设计模式：不列进 Agent 模式的项目对话。
 * 没选对话时是这个模式的空页面和「新建」按钮；插件没开或已删除时说明情况。
 */
export function PluginDesignPage() {
  const { route, go, openSettings } = useNav()
  const { tasks, tasksLoaded } = useTasks()
  const { loaded } = usePlugins()
  const modes = useDesignModes()
  const [creating, setCreating] = useState(false)
  // 只点了「设计」没选哪一种（#/pdesign）：停在侧栏下拉选中的那一种
  const mode = modes.find((m) => m.id === (route.id ?? currentDesignMode(undefined, modes)))
  const id = route.sub
  // 地址里补上是哪一种：插件的整页按 #/pdesign/<模式>/… 解释位置
  const fill = !route.id && mode ? mode.id : ''
  useEffect(() => {
    if (fill) go({ page: 'pdesign', id: fill })
    // 只在要补的模式变了时跳
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [fill])
  if (fill) return null
  // 自带整页的模式（插件接口 4）：位置交给插件自己解释，不当成对话 id
  if (mode?.Page) return <mode.Page key={mode.id} id={id} sub={route.msg} />
  const task = id ? tasks.find((x) => x.id === id) : undefined
  // 对话本身和插件无关也打得开：插件关掉以后，原来的对话照样能看
  if (id && (task || !tasksLoaded)) return <TaskView key={id} taskId={id} />
  const Icon = mode?.icon ?? Puzzle
  return (
    <main className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <Icon className="h-7 w-7 text-subtle" strokeWidth={1.9} />
      <h1 className="text-subtitle font-semibold">
        {!mode
          ? loaded
            ? route.id
              ? t('插件没有打开')
              : t('还没有设计插件')
            : t('读取中…')
          : id
            ? t('找不到这个对话')
            : mode.name}
      </h1>
      <p className="max-w-md text-body leading-relaxed text-subtle">
        {mode
          ? mode.empty
          : loaded
            ? route.id
              ? t('这类设计来自插件，插件关掉或删除后就没有了。到设置 →「插件」里打开。')
              : t('设计都来自插件：UI 设计插件做游戏界面和网页，Blender 插件做模型。到设置 →「插件」里安装或打开。')
            : ''}
      </p>
      {!mode && loaded && !route.id && (
        <Button size="sm" variant="secondary" onClick={() => openSettings('plugins')}>
          <Puzzle className="h-3.5 w-3.5" />
          {t('去装插件')}
        </Button>
      )}
      {mode && (
        <>
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="h-3.5 w-3.5" />
            {mode.newLabel}
          </Button>
          {mode.NewDialog ? (
            <mode.NewDialog
              open={creating}
              onOpenChange={setCreating}
              onCreated={(x) => go({ page: 'pdesign', id: mode.id, sub: x.id })}
            />
          ) : null}
        </>
      )}
    </main>
  )
}
