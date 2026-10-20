import { useEffect, useRef, useState } from 'react'
import type { ContentFile, FileTree, SearchMode } from '@shared/files'
import { api } from '@/lib/api'
import { FileExplorer } from './FileTree'
import { ProjectFileDialog } from './ProjectFileDialog'

/**
 * 项目文件系统：读取当前项目的全量文件树、按内容搜索。
 * 没有项目的聊天（Chat 模式）回退到任务自己的工作目录，和以前一样能看文件。
 */
export function useProjectFiles(projectId: string, refreshKey?: string, taskId?: string) {
  const [tree, setTree] = useState<FileTree | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [hits, setHits] = useState<ContentFile[]>([])
  const [hitsTruncated, setHitsTruncated] = useState(false)
  const [searching, setSearching] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const lastScope = useRef('')

  const load = () => {
    const scope = projectId || taskId
    if (!scope) {
      setTree(null)
      setError('')
      setLoading(false)
      return
    }
    setLoading(true)
    setError('')
    ;(projectId ? api.fileTree(projectId) : api.taskFiles(taskId!))
      .then(setTree)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    // 换项目（或从项目任务换到聊天任务）时清掉上一个的文件树和搜索结果；
    // 同一个范围只是刷新状态时保留列表
    const scope = projectId || taskId || ''
    if (lastScope.current !== scope) {
      lastScope.current = scope
      setTree(null)
      setHits([])
      setHitsTruncated(false)
    }
    load()
    // 项目切换、任务改动或执行结束时重新读取文件树
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, taskId, refreshKey])

  const search = (q: string, mode: SearchMode) => {
    const needle = q.trim()
    clearTimeout(timer.current)
    if (mode !== 'content' || !needle || (!projectId && !taskId)) {
      setHits([])
      setHitsTruncated(false)
      setSearching(false)
      return
    }
    setSearching(true)
    timer.current = setTimeout(() => {
      ;(projectId ? api.searchFileContent(projectId, needle) : api.searchTaskFiles(taskId!, needle))
        .then((r) => {
          setHits(r.files)
          setHitsTruncated(r.truncated)
        })
        .catch((e) => setError((e as Error).message))
        .finally(() => setSearching(false))
    }, 250)
  }

  useEffect(() => () => clearTimeout(timer.current), [])

  return { tree, error, loading, hits, hitsTruncated, searching, search, load }
}

export function ProjectFileExplorer({
  projectId,
  dir,
  compact,
  className,
}: {
  projectId: string
  dir?: string
  compact?: boolean
  className?: string
}) {
  const files = useProjectFiles(projectId)
  const [target, setTarget] = useState<{ path: string; line?: number } | null>(null)
  return (
    <>
      <FileExplorer
        tree={files.tree}
        error={files.error}
        loading={files.loading}
        hits={files.hits}
        hitsTruncated={files.hitsTruncated}
        searching={files.searching}
        onSearch={files.search}
        onOpen={(path, line) => setTarget({ path, line })}
        compact={compact}
        className={className}
      />
      <ProjectFileDialog
        projectId={projectId}
        dir={files.tree?.dir ?? dir ?? ''}
        target={target}
        onOpenChange={(open) => !open && setTarget(null)}
      />
    </>
  )
}
