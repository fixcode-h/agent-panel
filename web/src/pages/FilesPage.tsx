import { useEffect, useRef, useState } from 'react'
import { FolderOpen, GitBranch, RefreshCw } from 'lucide-react'
import { t } from '@shared/i18n'
import { useData, useNav } from '@/lib/data'
import { cn } from '@/lib/utils'
import { Select } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { FileExplorer } from '@/components/files/FileTree'
import { useProjectFiles } from '@/components/files/ProjectFileExplorer'
import { ProjectFileDialog } from '@/components/files/ProjectFileDialog'

/** 窗口重新获得焦点后这么久之内只刷一次：切来切去时不会连着发请求 */
const FOCUS_REFRESH_GAP = 1500

export function FilesPage() {
  const { projects, loading } = useData()
  const { route, go } = useNav()
  const project = projects.find((p) => p.id === route.id) ?? projects[0]
  const projectId = project?.id ?? ''
  // 刷新靠这个计数走 useProjectFiles 的 refreshKey：手动点刷新和切回来时都让它加一
  const [refreshKey, setRefreshKey] = useState(0)
  const bump = () => setRefreshKey((n) => n + 1)
  // 目录按层读取：只拿根信息，展开哪层读哪层
  const files = useProjectFiles(projectId, String(refreshKey))
  const [target, setTarget] = useState<{ path: string; line?: number } | null>(null)
  // 弹窗开着（在读文件、在编辑）时不要自动刷新，刷新会让树跳一下，也可能打断正在写的修改
  const openRef = useRef(false)
  openRef.current = !!target

  useEffect(() => {
    let last = 0
    const onFocus = () => {
      if (openRef.current) return
      const now = Date.now()
      if (now - last < FOCUS_REFRESH_GAP) return
      last = now
      // 在编辑器里改完文件切回来：分支名、git 状态和文件列表都要跟着变
      setRefreshKey((n) => n + 1)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  if (!loading && !project)
    return (
      <main className="flex flex-1 items-center justify-center p-6">
        <p className="text-[0.8125rem] text-subtle">{t('先添加一个项目，再浏览项目里的文件。')}</p>
      </main>
    )

  return (
    <main className="flex min-w-0 flex-1 flex-col md:h-full">
      <header className="flex h-14 shrink-0 items-center gap-2 px-3 md:px-5">
        <FolderOpen className="h-4.5 w-4.5 shrink-0 text-accent" strokeWidth={1.8} />
        <h1 className="min-w-0 truncate font-serif text-[1.0625rem] font-semibold tracking-tight">
          {project?.name ?? t('文件')}
        </h1>
        {files.info?.branch && (
          // 分支名最多占一半宽度：名字再长也不把项目名挤没
          <span className="flex min-w-0 max-w-[45%] items-center gap-1 text-[0.75rem] text-subtle">
            <GitBranch className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 truncate font-mono" title={files.info.branch}>
              {files.info.branch}
            </span>
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('刷新文件')}
            title={t('刷新文件')}
            onClick={bump}
            className="h-8 w-8"
          >
            <RefreshCw className={cn('h-4 w-4', files.loading && 'animate-spin')} />
          </Button>
          {projects.length > 1 && (
            <div className="w-48">
              <Select
                aria-label={t('切换项目')}
                value={project?.id ?? ''}
                onChange={(e) => go({ page: 'files', id: e.target.value })}
                options={projects.map((p) => ({ value: p.id, label: p.name }))}
              />
            </div>
          )}
        </div>
      </header>

      <FileExplorer browser={files} onOpen={(path, line) => setTarget({ path, line })} />

      {project && (
        <ProjectFileDialog
          projectId={project.id}
          dir={files.info?.dir ?? project.path}
          target={target}
          onOpenChange={(o) => !o && setTarget(null)}
          // 保存成功后刷新文件树：文件大小、改动标记都要跟着变
          onSaved={files.refresh}
        />
      )}
    </main>
  )
}
