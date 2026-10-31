import { FolderPlus } from 'lucide-react'
import { useData, useNav } from '@/lib/data'
import { Button } from '@/components/ui/button'
import { EmptyPanel } from '@/components/ui/empty-panel'
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
      {/* 首页单独限宽：输入框 760px（加上左右内边距 808），宽屏下不再跟着内容宽度拉到 950px，一行字视线不用扫太远；对话页不受影响 */}
      <div className="mx-auto flex w-full max-w-[min(var(--content-w),808px)] flex-1 flex-col justify-center gap-7 px-4 py-12 md:px-6">
        <h1 className="flex items-center justify-center gap-3 text-center font-serif text-display font-semibold tracking-tight text-fg md:text-hero">
          <Logo className="h-9 w-9 rounded-xl [&>svg]:h-5 [&>svg]:w-5" />
          {t('{hi}，今天要做什么？', { hi: greeting() })}
        </h1>
        {!loading && projects.length === 0 ? (
          <EmptyPanel as="div" className="flex flex-col items-center gap-3 p-8">
            <p className="text-prose text-muted">
              {t('先添加一个项目：项目就是本机上的一个代码目录，Agent 会在里面执行任务。')}
            </p>
            <Button onClick={() => openProject()}>
              <FolderPlus className="h-4 w-4" />
              {t('添加项目')}
            </Button>
          </EmptyPanel>
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
