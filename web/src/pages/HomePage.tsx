import { FolderPlus } from 'lucide-react'
import { useData, useNav } from '@/lib/data'
import { Button } from '@/components/ui/button'
import { TaskComposer } from '@/components/tasks/TaskComposer'
import { Logo } from '@/components/layout/Sidebar'
import { t } from '@shared/i18n'

const greeting = () => {
  const h = new Date().getHours()
  return h < 5 ? t('夜深了') : h < 11 ? t('早上好') : h < 13 ? t('中午好') : h < 18 ? t('下午好') : t('晚上好')
}

/** 首页：参考 Claude 的新对话页，中间一句问候和任务输入框 */
export function HomePage() {
  const { projects, loading, upsertTask } = useData()
  const { go, openProject } = useNav()
  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-(--content-w) flex-1 flex-col justify-center gap-7 px-4 py-12 md:px-6">
        <h1 className="flex items-center justify-center gap-3 text-center font-serif text-[1.75rem] font-semibold tracking-tight text-fg md:text-[2.125rem]">
          <Logo className="h-9 w-9 rounded-xl [&>svg]:h-5 [&>svg]:w-5" />
          {t('{hi}，今天要做什么？', { hi: greeting() })}
        </h1>
        {!loading && projects.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed p-8 text-center">
            <p className="text-[0.875rem] text-muted">
              {t('先添加一个项目：项目就是本机上的一个代码目录，Agent 会在里面执行任务。')}
            </p>
            <Button onClick={() => openProject()}>
              <FolderPlus className="h-4 w-4" />
              {t('添加项目')}
            </Button>
          </div>
        ) : (
          <TaskComposer
            autoFocus
            onCreated={(t) => {
              upsertTask(t)
              go({ page: 'projects', id: t.projectId, sub: t.id })
            }}
          />
        )}
      </div>
    </main>
  )
}
