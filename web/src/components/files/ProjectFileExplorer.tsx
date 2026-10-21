import { useEffect, useRef, useState } from 'react'
import type { ContentFile, DirLevel, FileTree, NameSearch, SearchMode } from '@shared/files'
import { api } from '@/lib/api'
import { type FileBrowser, type LevelState, FileExplorer } from './FileTree'
import { ProjectFileDialog } from './ProjectFileDialog'

/** 搜索输入停顿这么久再发请求，打字过程中不发 */
const SEARCH_DELAY = 250

/**
 * 项目文件的数据：根信息、按层读取的目录、按名称或内容搜索。
 * 展开的层缓存在内存里，收起再展开不重复请求；刷新时清掉缓存重读。
 * 没有项目的聊天（Chat 模式）回退到任务自己的工作目录，和以前一样能看文件。
 */
export function useProjectFiles(projectId: string, refreshKey?: string, taskId?: string): FileBrowser {
  const [info, setInfo] = useState<FileTree | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [names, setNames] = useState<NameSearch | null>(null)
  const [namesLoading, setNamesLoading] = useState(false)
  const [namesError, setNamesError] = useState('')
  const [hits, setHits] = useState<ContentFile[]>([])
  const [hitsTruncated, setHitsTruncated] = useState(false)
  const [searching, setSearching] = useState(false)
  // 读到的层和每一层的状态放在 ref 里：请求回来自行更新，用计数触发渲染
  const levels = useRef<Record<string, DirLevel>>({})
  const states = useRef<Record<string, LevelState>>({})
  const [, setTick] = useState(0)
  const [version, setVersion] = useState(0)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const searchSeq = useRef(0)
  const rootSeq = useRef(0)
  const lastScope = useRef('')
  const lastRefresh = useRef(refreshKey)
  /** 手动刷新后的一小段时间里，重新读的层不要服务端缓存的状态 */
  const freshUntil = useRef(0)
  const scope = projectId || taskId || ''
  const scopeRef = useRef(scope)
  scopeRef.current = scope

  const bump = () => setTick((n) => n + 1)

  /** 换项目时把上一个的缓存全清掉 */
  const clear = () => {
    levels.current = {}
    states.current = {}
    setNames(null)
    setNamesError('')
    setHits([])
    setHitsTruncated(false)
    setSearching(false)
    setInfo(null)
    setError('')
    setLoading(false)
  }

  const loadRoot = () => {
    if (!scopeRef.current) {
      clear()
      return
    }
    const seq = ++rootSeq.current
    setLoading(true)
    setError('')
    ;(projectId ? api.fileTree(projectId) : api.taskFiles(taskId!))
      .then((r) => {
        if (seq === rootSeq.current) setInfo(r)
      })
      .catch((e) => {
        if (seq === rootSeq.current) setError((e as Error).message)
      })
      .finally(() => {
        if (seq === rootSeq.current) setLoading(false)
      })
  }

  /** 读一层：已经读过或正在读就不重复请求 */
  const load = (path: string) => {
    const s = states.current[path]
    if (levels.current[path] || s?.loading) return
    const project = projectId
    const task = taskId
    if (!project && !task) return
    // 刚点过刷新：这一轮读到的层不要服务端几秒内的旧状态
    const force = Date.now() < freshUntil.current
    states.current[path] = { loading: true, error: '' }
    bump()
    const req = project ? api.fileLevel(project, path, force) : api.taskFileLevel(task!, path, force)
    req
      .then((level) => {
        // 换过项目的话这一层已经不属于当前范围了，丢掉
        if ((projectId || taskId) !== scopeRef.current) return
        levels.current = { ...levels.current, [path]: level }
        states.current[path] = { loading: false, error: '' }
      })
      .catch((e) => {
        if ((projectId || taskId) !== scopeRef.current) return
        states.current[path] = { loading: false, error: (e as Error).message }
      })
      .finally(bump)
  }

  /** 手动刷新：丢掉已读的层，让展开着的目录重新读（重新读时不再用服务端的状态缓存） */
  const refresh = () => {
    levels.current = {}
    states.current = {}
    freshUntil.current = Date.now() + 2000
    loadRoot()
    setVersion((v) => v + 1)
  }

  const search = (q: string, mode: SearchMode) => {
    const needle = q.trim()
    clearTimeout(timer.current)
    const seq = ++searchSeq.current
    if (!needle || (!projectId && !taskId)) {
      setNames(null)
      setNamesError('')
      setNamesLoading(false)
      setHits([])
      setHitsTruncated(false)
      setSearching(false)
      return
    }
    if (mode === 'name') {
      setNamesLoading(true)
      setNamesError('')
      setHits([])
      setHitsTruncated(false)
      setSearching(false)
      timer.current = setTimeout(() => {
        ;(projectId ? api.searchFileNames(projectId, needle) : api.searchTaskFileNames(taskId!, needle))
          .then((r) => {
            if (seq === searchSeq.current) setNames(r)
          })
          .catch((e) => {
            if (seq === searchSeq.current) setNamesError((e as Error).message)
          })
          .finally(() => {
            if (seq === searchSeq.current) setNamesLoading(false)
          })
      }, SEARCH_DELAY)
      return
    }
    setNames(null)
    setNamesError('')
    setNamesLoading(false)
    setSearching(true)
    timer.current = setTimeout(() => {
      ;(projectId ? api.searchFileContent(projectId, needle) : api.searchTaskFiles(taskId!, needle))
        .then((r) => {
          if (seq !== searchSeq.current) return
          setHits(r.files)
          setHitsTruncated(r.truncated)
        })
        .catch((e) => {
          if (seq === searchSeq.current) setError((e as Error).message)
        })
        .finally(() => {
          if (seq === searchSeq.current) setSearching(false)
        })
    }, SEARCH_DELAY)
  }

  useEffect(() => {
    // 换项目（或从项目任务换到聊天任务）时清掉上一个的缓存，已经展开的目录按新的范围重读
    let cleared = false
    if (lastScope.current !== scope) {
      lastScope.current = scope
      clear()
      cleared = true
    }
    // 刷新状态变化（任务改动了文件、执行结束）时缓存的层已经过时：丢掉已读的层重读，
    // 否则展开着的目录还显示旧的 git 状态
    if (lastRefresh.current !== refreshKey) {
      lastRefresh.current = refreshKey
      levels.current = {}
      states.current = {}
      freshUntil.current = Date.now() + 2000
      cleared = true
    }
    if (cleared) setVersion((v) => v + 1)
    loadRoot()
    // 项目切换、任务改动或执行结束时重新读；loadRoot 每次渲染都是新函数
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, taskId, refreshKey])

  useEffect(() => () => clearTimeout(timer.current), [])

  return {
    info,
    error,
    loading,
    levels: levels.current,
    levelState: (path) => states.current[path] ?? { loading: false, error: '' },
    load,
    refresh,
    version,
    names,
    namesLoading,
    namesError,
    hits,
    hitsTruncated,
    searching,
    search,
  }
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
        browser={files}
        onOpen={(path, line) => setTarget({ path, line })}
        compact={compact}
        className={className}
      />
      <ProjectFileDialog
        projectId={projectId}
        dir={files.info?.dir ?? dir ?? ''}
        target={target}
        onOpenChange={(open) => !open && setTarget(null)}
      />
    </>
  )
}
