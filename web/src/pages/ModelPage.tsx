import { useState } from 'react'
import { Box, Plus } from 'lucide-react'
import { t } from '@shared/i18n'
import { useTasks } from '@/lib/data'
import { TaskView } from '@/components/tasks/TaskView'
import { Button } from '@/components/ui/button'
import { NewModelDesignDialog } from '@/components/design/NewModelDesignDialog'

/**
 * 模型设计（ADR 0025）：设计模式下的一页，打开的是带 modelDesign 标记的对话。
 * 对话数据仍挂在某个项目下（Blender 导出的文件、命令都在项目目录里跑），但它属于设计模式：
 * 不列进 Agent 模式的项目对话、打开时不切到 Agent 模式（#/model/<对话 id>）
 */
export function ModelPage({ id }: { id?: string }) {
  const { tasks, tasksLoaded } = useTasks()
  const [creating, setCreating] = useState(false)
  const task = id ? tasks.find((x) => x.id === id) : undefined
  if (id && (task || !tasksLoaded)) return <TaskView key={id} taskId={id} />
  return (
    <main className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <Box className="h-7 w-7 text-subtle" strokeWidth={1.9} />
      <h1 className="text-subtitle font-semibold">{id ? t('找不到这个模型设计对话') : t('模型设计')}</h1>
      <p className="max-w-md text-body leading-relaxed text-subtle">
        {t('模型设计在后台启动 Blender，Agent 用它建模，右栏实时预览。左侧按项目列出已有的模型对话。')}
      </p>
      <Button size="sm" onClick={() => setCreating(true)}>
        <Plus className="h-3.5 w-3.5" />
        {t('新建模型设计')}
      </Button>
      <NewModelDesignDialog open={creating} onOpenChange={setCreating} />
    </main>
  )
}
