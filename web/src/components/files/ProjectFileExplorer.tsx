import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
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
  /**
   * 刷新轮次。每刷新一次加一，已展开的层据此在后台重读；
   * 有了它才能区分「这一层这一轮已经读过」和「读的是上一轮的旧数据」。
   */
  const epoch = useRef(0)
  /** 每一层是在哪一轮读到的 */
  const levelEpoch = useRef<Record<string, number>>({})
  /** 每一层正在进行中的请求属于哪一轮，同一轮里不重复发请求 */
  const pending = useRef<Record<string, number>>({})
  /** 根信息也放在 ref 里：后台重读要知道现在有没有旧内容可以先顶着 */
  const infoRef = useRef<FileTree | null>(null)
  const scope = projectId || taskId || ''
  const scopeRef = useRef(scope)
  scopeRef.current = scope

  const bump = () => setTick((n) => n + 1)

  /** 换项目时把上一个的缓存全清掉 */
  const clear = () => {
    levels.current = {}
    states.current = {}
    levelEpoch.current = {}
    pending.current = {}
    infoRef.current = null
    setNames(null)
    setNamesError('')
    setHits([])
    setHitsTruncated(false)
    setSearching(false)
    setInfo(null)
    setError('')
    setLoading(false)
  }

  /**
   * 读根信息。busy 为 true 时（手动刷新）让刷新图标转一下作为反馈；
   * 已经有 info 时一律后台重读，不切回 loading 空态，否则整块内容会消失。
   */
  const loadRoot = (busy = false) => {
    if (!scopeRef.current) {
      clear()
      return
    }
    const seq = ++rootSeq.current
    // 已经有根信息时后台重读：切回 loading 会让整块内容消失、图标一直转，
    // 任务执行期间每改一次文件就闪一下。只有第一次读的时候才显示加载态。
    setLoading(busy || !infoRef.current)
    setError('')
    ;(projectId ? api.fileTree(projectId) : api.taskFiles(taskId!))
      .then((r) => {
        if (seq !== rootSeq.current) return
        infoRef.current = r
        setInfo(r)
      })
      .catch((e) => {
        if (seq === rootSeq.current) setError((e as Error).message)
      })
      .finally(() => {
        if (seq === rootSeq.current) setLoading(false)
      })
  }

  /**
   * 清掉这一轮重读后发现已经不存在的子目录缓存。
   * 只按「这一轮已经重读过的父层」判断，没重读的父层数据还是旧的，不能拿来判定目录没了。
   */
  const pruneGone = () => {
    const round = epoch.current
    const gone: string[] = []
    for (const path of Object.keys(levels.current)) {
      // 根目录没有父层，不参与这种判断
      if (!path) continue
      const cut = path.lastIndexOf('/')
      const parent = cut < 0 ? '' : path.slice(0, cut)
      const parentLevel = levels.current[parent]
      if (!parentLevel || levelEpoch.current[parent] !== round) continue
      if (!parentLevel.entries.some((e) => e.kind === 'dir' && e.path === path)) gone.push(path)
    }
    if (!gone.length) return
    // 目录没了，它下面读过的层也一起丢掉，否则展开状态还会把幽灵行渲染出来
    const dead = (path: string) => gone.some((g) => path === g || path.startsWith(g + '/'))
    levels.current = Object.fromEntries(Object.entries(levels.current).filter(([path]) => !dead(path)))
    states.current = Object.fromEntries(Object.entries(states.current).filter(([path]) => !dead(path)))
    levelEpoch.current = Object.fromEntries(Object.entries(levelEpoch.current).filter(([path]) => !dead(path)))
    pending.current = Object.fromEntries(Object.entries(pending.current).filter(([path]) => !dead(path)))
  }

  /**
   * 读一层：这一轮已经读过或正在读就不重复请求。
   * 刷新后旧数据先留着（FileTree 继续显示），新结果回来再原地替换，避免整块闪成「读取中…」。
   */
  const load = (path: string) => {
    const project = projectId
    const task = taskId
    if (!project && !task) return
    const round = epoch.current
    if (pending.current[path] === round || levelEpoch.current[path] === round) return
    // 刚点过刷新：这一轮读到的层不要服务端几秒内的旧状态
    const force = Date.now() < freshUntil.current
    states.current[path] = { loading: true, error: '' }
    pending.current[path] = round
    bump()
    const req = project ? api.fileLevel(project, path, force) : api.taskFileLevel(task!, path, force)
    req
      .then((level) => {
        // 换过项目的话这一层已经不属于当前范围了，丢掉
        if ((projectId || taskId) !== scopeRef.current) return
        // 上一轮的请求晚回来：新一轮正在重读，旧结果比它旧，直接丢掉
        if (round !== epoch.current) return
        levels.current = { ...levels.current, [path]: level }
        levelEpoch.current[path] = round
        states.current[path] = { loading: false, error: '' }
        // 新结果里没有的目录，连同它下面已经读过的层一起清掉，不留幽灵行
        pruneGone()
      })
      .catch((e) => {
        if ((projectId || taskId) !== scopeRef.current) return
        if (round !== epoch.current) return
        states.current[path] = { loading: false, error: (e as Error).message }
      })
      .finally(() => {
        if (pending.current[path] === round) delete pending.current[path]
        bump()
      })
  }

  /** 刷新：开新的一轮，已经展开的层在旧数据之上后台重读（重读时不再用服务端的状态缓存） */
  const refresh = () => {
    epoch.current += 1
    freshUntil.current = Date.now() + 2000
    // 手动刷新给个进度：树保留旧内容，只让刷新图标转起来
    loadRoot(true)
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
    // 刷新状态变化（任务改动了文件、执行结束）时缓存的层已经过时：开新的一轮重读。
    // 不清空已读的层，旧数据继续显示，新结果回来再原地替换，避免执行中每次改文件都整块闪一下。
    if (lastRefresh.current !== refreshKey) {
      lastRefresh.current = refreshKey
      epoch.current += 1
      freshUntil.current = Date.now() + 2000
      cleared = true
    }
    if (cleared) setVersion((v) => v + 1)
    loadRoot()
    // 项目切换、任务改动或执行结束时重新读；loadRoot 每次渲染都是新函数
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, taskId, refreshKey])

  useEffect(() => () => clearTimeout(timer.current), [])

  /** 在系统的文件管理器里打开；传空路径时打开项目（任务）目录本身 */
  const reveal = (path = '') => {
    if (projectId) void api.revealProjectFile(projectId, path).catch((e) => toast.error((e as Error).message))
    else if (taskId) void api.revealTaskFile(taskId, path).catch((e) => toast.error((e as Error).message))
  }

  /** 相对路径 → 绝对路径；目录还没读到时只能给相对路径 */
  const absolute = (path: string) => {
    const root = info?.dir ?? ''
    if (!root) return path
    const sep = root.includes('\\') ? '\\' : '/'
    const base = root.replace(/[\\/]+$/, '')
    const rel = path.replace(/\//g, sep)
    return rel ? `${base}${sep}${rel}` : base
  }

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
    reveal,
    absolute,
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
