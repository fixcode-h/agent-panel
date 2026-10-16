import { useData, useNav } from '@/lib/data'
import { TaskComposer } from '@/components/tasks/TaskComposer'
import { TaskView } from '@/components/tasks/TaskView'
import { Logo } from '@/components/layout/Sidebar'
import { t } from '@shared/i18n'

/**
 * Chat 模式：和 Claude 的聊天一样，不选项目，直接和 Agent 对话。
 * 没选聊天时是新聊天页，选了就是那次聊天（和项目里的对话任务同一个页面，只是没有项目）。
 */
export function ChatPage() {
  const { route, go } = useNav()
  const { upsertTask } = useData()
  if (route.id) return <TaskView key={route.id} taskId={route.id} />
  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-(--content-w) flex-1 flex-col justify-center gap-7 px-4 py-12 md:px-6">
        <h1 className="flex items-center justify-center gap-3 text-center font-serif text-[28px] font-semibold tracking-tight text-fg md:text-[34px]">
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
      </div>
    </main>
  )
}
