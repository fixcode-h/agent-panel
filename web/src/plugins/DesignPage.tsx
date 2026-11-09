import { useState } from 'react'
import { Plus, Puzzle } from 'lucide-react'
import { t } from '@shared/i18n'
import { useNav, useTasks } from '@/lib/data'
import { TaskView } from '@/components/tasks/TaskView'
import { Button } from '@/components/ui/button'
import { usePlugins, useDesignModes } from './registry'

/**
 * 插件的设计模式页（#/pdesign/<模式>/<对话>，ADR 0059）：打开的是 task.plugin 归这个模式的对话。
 * 对话数据仍挂在某个项目下（插件的产物、命令都在项目目录里），但它属于设计模式：不列进 Agent 模式的项目对话。
 * 没选对话时是这个模式的空页面和「新建」按钮；插件没开或已删除时说明情况。
 */
export function PluginDesignPage() {
  const { route, go } = useNav()
  const { tasks, tasksLoaded } = useTasks()
  const { loaded } = usePlugins()
  const modes = useDesignModes()
  const [creating, setCreating] = useState(false)
  const mode = modes.find((m) => m.id === route.id)
  const id = route.sub
  const task = id ? tasks.find((x) => x.id === id) : undefined
  // 对话本身和插件无关也打得开：插件关掉以后，原来的对话照样能看
  if (id && (task || !tasksLoaded)) return <TaskView key={id} taskId={id} />
  const Icon = mode?.icon ?? Puzzle
  return (
    <main className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <Icon className="h-7 w-7 text-subtle" strokeWidth={1.9} />
      <h1 className="text-subtitle font-semibold">
        {!mode ? (loaded ? t('插件没有打开') : t('读取中…')) : id ? t('找不到这个对话') : mode.name}
      </h1>
      <p className="max-w-md text-body leading-relaxed text-subtle">
        {mode ? mode.empty : loaded ? t('这类设计来自插件，插件关掉或删除后就没有了。到设置 →「插件」里打开。') : ''}
      </p>
      {mode && (
        <>
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="h-3.5 w-3.5" />
            {mode.newLabel}
          </Button>
          <mode.NewDialog
            open={creating}
            onOpenChange={setCreating}
            onCreated={(x) => go({ page: 'pdesign', id: mode.id, sub: x.id })}
          />
        </>
      )}
    </main>
  )
}
