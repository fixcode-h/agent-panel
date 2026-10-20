import { useEffect, useRef, useState } from 'react'
import { FolderOpen, GitBranch } from 'lucide-react'
import type { ContentFile, FileTree, SearchMode } from '@shared/files'
import { t } from '@shared/i18n'
import { useData, useNav } from '@/lib/data'
import { api } from '@/lib/api'
import { Select } from '@/components/ui/input'
import { FileExplorer } from '@/components/files/FileTree'
import { ProjectFileDialog } from '@/components/files/ProjectFileDialog'

export function FilesPage() {
  const { projects, loading } = useData()
  const { route, go } = useNav()
  const project = projects.find((p) => p.id === route.id) ?? projects[0]
  const [tree, setTree] = useState<FileTree | null>(null)
  const [error, setError] = useState('')
  const [hits, setHits] = useState<ContentFile[]>([])
  const [hitsTruncated, setHitsTruncated] = useState(false)
  const [searching, setSearching] = useState(false)
  const [target, setTarget] = useState<{ path: string; line?: number } | null>(null)

  // 没有项目时显示空状态，不报错
  const projectId = project?.id ?? ''
  useEffect(() => {
    if (!projectId) return
    setTree(null)
    setError('')
    setHits([])
    api
      .fileTree(projectId)
      .then(setTree)
      .catch((e) => setError((e as Error).message))
  }, [projectId])

  // 按内容搜索：停顿一下再搜，输入过程中不发请求
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const search = (q: string, mode: SearchMode) => {
    const needle = q.trim()
    clearTimeout(timer.current)
    if (mode !== 'content' || !needle || !projectId) {
      setHits([])
      setHitsTruncated(false)
      setSearching(false)
      return
    }
    setSearching(true)
    timer.current = setTimeout(() => {
      api
        .searchFileContent(projectId, needle)
        .then((r) => {
          setHits(r.files)
          setHitsTruncated(r.truncated)
        })
        .catch((e) => setError((e as Error).message))
        .finally(() => setSearching(false))
    }, 250)
  }
  useEffect(() => () => clearTimeout(timer.current), [])

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
        {tree?.branch && (
          <span className="flex min-w-0 items-center gap-1 text-[0.75rem] text-subtle">
            <GitBranch className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate font-mono">{tree.branch}</span>
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

      <FileExplorer
        tree={tree}
        error={error}
        hits={hits}
        hitsTruncated={hitsTruncated}
        searching={searching}
        onSearch={search}
        onOpen={(path, line) => setTarget({ path, line })}
      />

      {project && (
        <ProjectFileDialog
          projectId={project.id}
          dir={tree?.dir ?? project.path}
          target={target}
          onOpenChange={(o) => !o && setTarget(null)}
        />
      )}
    </main>
  )
}
