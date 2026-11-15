import { FileInput, FolderGit2, GitBranch, PanelRight, Settings2, Workflow as WorkflowIcon, X } from 'lucide-react'
import { useRef, useState, type CSSProperties } from 'react'
import { toast } from '@/lib/toast'
import type { Project } from '@shared/schema'
import { taskSummary } from '@shared/task'
import { importTaskFile } from '@/lib/task-transfer'
import { useData, useNav } from '@/lib/data'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useDirInfo } from '@/components/projects/DirPicker'
import { ProjectLessonsCard } from '@/components/projects/Lessons'
import { TaskComposer } from './TaskComposer'
import { HomeGlance } from './HomeGlance'
import { projectDefaultWorkflow } from '@shared/projects/workflow'
import { TaskView } from './TaskView'
import { ProjectFileExplorer } from '@/components/files/ProjectFileExplorer'
import { ResizeHandle, usePaneWidth } from '@/components/ui/resize'
import { IconButton } from '@/components/ui/icon-button'
import { t } from '@shared/i18n'

/**
 * 项目首页：和面板首页同一个样子（HomePage），用户要求点进项目也这么显示。
 * 中间项目名和输入框（项目固定），输入框下面是这个项目的目录、分支、工作流，
 * 再下面是这个项目等你处理的和最近的对话（HomeGlance 按项目筛）；全部对话在侧栏的项目分组里
 */
function ProjectHome({ project }: { project: Project }) {
  const { workflows, projectCategories, upsertTask } = useData()
  const { go, openProject } = useNav()
  const dir = useDirInfo(project.path)
  const [filesOpen, setFilesOpen] = useState(false)
  // 示例任务点了填进输入框（HomeGlance）
  const [fill, setFill] = useState<{ text: string; n: number }>()
  // 文件栏和任务页的右栏一样可以拖宽；上限按这一行剩下的宽度算，给主内容至少留 480
  const row = useRef<HTMLDivElement>(null)
  const filesPane = usePaneWidth('project-files', 360, 260, () => {
    const width = row.current?.clientWidth ?? window.innerWidth
    return Math.max(320, width - 480)
  })
  const wf = projectDefaultWorkflow(project, projectCategories, workflows)
  const open = (sub?: string) => go({ page: 'projects', id: project.id, sub })
  // 导入别人导出的任务：放进这个项目，只能查看
  const file = useRef<HTMLInputElement>(null)
  const onImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    try {
      // 包里的子对话一起导入：返回父任务在前的整棵树，打开父任务就能在子对话栏看到它们
      const [tk, ...kids] = await importTaskFile(f, project.id)
      upsertTask(taskSummary(tk))
      toast.success(
        kids.length
          ? t('已导入「{title}」和 {n} 个子对话', { title: tk.title, n: kids.length })
          : t('已导入「{title}」', { title: tk.title }),
      )
      open(tk.id)
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  return (
    <div ref={row} className="flex min-w-0 flex-1">
      <main className="panel flex min-w-0 flex-1 flex-col md:h-full">
        <div className="flex flex-1 flex-col md:min-h-0 md:overflow-y-auto">
          <header className="flex h-14 shrink-0 items-center gap-2 px-3 md:px-5">
            <input ref={file} type="file" accept=".json,application/json" hidden onChange={onImport} />
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              title={t('导入别人导出的任务（对话或工作流执行），只能查看，也可以交给 AI 分析')}
              onClick={() => file.current?.click()}
            >
              <FileInput className="h-4 w-4" />
              {t('导入任务')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => openProject(project.id)}>
              <Settings2 className="h-4 w-4" />
              {t('项目设置')}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={filesOpen ? t('关闭文件') : t('显示文件')}
              title={filesOpen ? t('关闭文件') : t('显示文件')}
              aria-expanded={filesOpen}
              onClick={() => setFilesOpen((v) => !v)}
            >
              {filesOpen ? <X className="h-4 w-4" /> : <PanelRight className="h-4 w-4" />}
            </Button>
          </header>
          {/* 和首页同样的限宽、上下居中（HomePage）；上面多了 56px 的标题栏，底部多留同样高度，内容中心和首页对齐 */}
          <div
            className="mx-auto flex w-full max-w-[min(var(--content-w),808px)] flex-1 flex-col justify-center gap-7 px-4 pt-6 pb-12 md:px-6 md:pb-[calc(3rem+56px)]"
            data-project-home
          >
            <h1 className="flex min-w-0 items-center justify-center gap-3 text-center font-serif text-display font-semibold tracking-tight text-fg md:text-hero">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent-text">
                <FolderGit2 className="h-5 w-5" strokeWidth={2} />
              </span>
              <span className="min-w-0 truncate">{project.name}</span>
            </h1>
            <div className="flex flex-col gap-2">
              <TaskComposer
                project={project}
                autoFocus
                fill={fill}
                onCreated={(created) => {
                  upsertTask(created)
                  open(created.id)
                }}
              />
              {/* 首页这里是选项目的胶囊；项目页项目已经定了，换成这个项目的目录、分支和默认工作流 */}
              <p className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 px-2 text-xs text-subtle">
                <span className="flex min-w-0 items-center gap-1.5" title={project.path || undefined}>
                  <FolderGit2 className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate font-mono">{project.path || t('还没有选择目录')}</span>
                </span>
                {dir?.gitBranch && (
                  <span className="flex items-center gap-1.5">
                    <GitBranch className="h-3.5 w-3.5" />
                    <span className="font-mono">{dir.gitBranch}</span>
                  </span>
                )}
                <span className="flex items-center gap-1.5">
                  <WorkflowIcon className="h-3.5 w-3.5" />
                  {wf?.name ?? t('没有默认工作流')}
                </span>
              </p>
            </div>
            {/* 输入框下面：这个项目等你处理的、最近的对话；还没有对话时是示例任务 */}
            <HomeGlance projectId={project.id} onExample={(text) => setFill((f) => ({ text, n: (f?.n ?? 0) + 1 }))} />
            <ProjectLessonsCard project={project} />
          </div>
        </div>
      </main>
      {/* 文件栏：宽屏是右侧常驻的一列（宽度可拖），窄屏放不下时从右边滑出，盖住主内容而不是把它挤扁 */}
      {filesOpen && (
        <aside
          aria-label={t('文件')}
          style={{ '--panel-w': `${filesPane.width}px` } as CSSProperties}
          className={cn(
            'panel fixed inset-y-0 right-0 z-40 flex w-[min(420px,100%)] flex-col shadow-pop',
            'lg:relative lg:inset-auto lg:z-auto lg:h-full lg:w-(--panel-w) lg:shrink-0 lg:shadow-none',
          )}
        >
          <ResizeHandle pane={filesPane} label={t('拖动调整文件面板的宽度')} className="hidden lg:block" />
          {/* 面板自己的标题栏和页面标题栏同高，浮层盖住页面标题栏时也能在这里关掉 */}
          <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b px-3">
            <span className="text-body font-semibold">{t('文件')}</span>
            <IconButton size="sm" icon={X} label={t('关闭文件')} onClick={() => setFilesOpen(false)} />
          </div>
          <div className="flex min-h-0 flex-1 flex-col">
            <ProjectFileExplorer projectId={project.id} dir={project.path} />
          </div>
        </aside>
      )}
    </div>
  )
}

/** 点进一个项目后的工作区：项目首页（新建任务 + 这个项目的对话）或任务对话 */
export function ProjectWorkspace({ project, sub }: { project: Project; sub?: string }) {
  if (sub) return <TaskView key={sub} taskId={sub} project={project} />
  return <ProjectHome project={project} />
}
