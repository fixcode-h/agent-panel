import { useState } from 'react'
import { FolderOpen, GitBranch } from 'lucide-react'
import { t } from '@shared/i18n'
import { useData, useNav } from '@/lib/data'
import { Select } from '@/components/ui/input'
import { FileExplorer } from '@/components/files/FileTree'
import { useProjectFiles } from '@/components/files/ProjectFileExplorer'
import { ProjectFileDialog } from '@/components/files/ProjectFileDialog'

export function FilesPage() {
  const { projects, loading } = useData()
  const { route, go } = useNav()
  const project = projects.find((p) => p.id === route.id) ?? projects[0]
  const projectId = project?.id ?? ''
  // 目录按层读取：只拿根信息，展开哪层读哪层
  const files = useProjectFiles(projectId)
  const [target, setTarget] = useState<{ path: string; line?: number } | null>(null)

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
          <span className="flex min-w-0 items-center gap-1 text-[0.75rem] text-subtle">
            <GitBranch className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate font-mono">{files.info.branch}</span>
          </span>
        )}
        <div className="ml-auto w-48 shrink-0">
          {projects.length > 1 && (
            <Select
              aria-label={t('切换项目')}
              value={project?.id ?? ''}
              onChange={(e) => go({ page: 'files', id: e.target.value })}
              options={projects.map((p) => ({ value: p.id, label: p.name }))}
            />
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
        />
      )}
    </main>
  )
}
