import { useRef } from 'react'
import { FileUp } from 'lucide-react'
import { useData, useNav } from '@/lib/data'
import { TaskComposer } from '@/components/tasks/TaskComposer'
import { TaskView } from '@/components/tasks/TaskView'
import { Logo } from '@/components/layout/Sidebar'
import { Button } from '@/components/ui/button'
import { importTaskFile } from '@/lib/task-transfer'
import { toast, toastError } from '@/lib/toast'
import { taskSummary } from '@shared/task'
import { t } from '@shared/i18n'

/**
 * Chat 模式：和 Claude 的聊天一样，不选项目，直接和 Agent 对话。
 * 没选聊天时是新聊天页，选了就是那次聊天（和项目里的对话任务同一个页面，只是没有项目）。
 */
export function ChatPage() {
  const { route, go } = useNav()
  const { upsertTask } = useData()
  // 导入别人导出的对话：以前只能在项目工作区里导入，不属于任何项目的聊天没有入口
  const file = useRef<HTMLInputElement>(null)
  const onImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    try {
      const [tk, ...kids] = await importTaskFile(f, '')
      upsertTask(taskSummary(tk))
      toast.success(
        kids.length
          ? t('已导入「{title}」和 {n} 个子对话', { title: tk.title, n: kids.length })
          : t('已导入「{title}」', { title: tk.title }),
      )
      go({ page: 'chat', id: tk.id })
    } catch (err) {
      toastError(err)
    }
  }
  if (route.id) return <TaskView key={route.id} taskId={route.id} />
  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-(--content-w) flex-1 flex-col justify-center gap-7 px-4 py-12 md:px-6">
        <h1 className="flex items-center justify-center gap-3 text-center font-serif text-display font-semibold tracking-tight text-fg md:text-hero">
          <Logo className="h-9 w-9 rounded-xl [&>svg]:h-5 [&>svg]:w-5" />
          {t('有什么可以帮你？')}
        </h1>
        <TaskComposer
          standalone
          autoFocus
          onCreated={(t) => {
            upsertTask(t)
            go({ page: 'chat', id: t.id })
          }}
        />
        <div className="flex justify-center">
          <input ref={file} type="file" accept=".json,application/json" hidden onChange={onImport} />
          <Button variant="ghost" size="sm" className="text-subtle" onClick={() => file.current?.click()}>
            <FileUp className="h-3.5 w-3.5" />
            {t('导入对话')}
          </Button>
        </div>
      </div>
    </main>
  )
}
