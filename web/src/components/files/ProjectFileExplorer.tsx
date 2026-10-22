import { type ComponentProps, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { ContentFile, DirLevel, FileTree, NameSearch, SearchMode } from '@shared/files'
import { api } from '@/lib/api'
import { type FileBrowser, type FileTreeOps, type LevelState, FileExplorer } from './FileTree'
import { ProjectFileDialog } from './ProjectFileDialog'

/** 搜索输入停顿这么久再发请求，打字过程中不发 */
const SEARCH_DELAY = 250

/**
 * 树的写操作接口（按约定声明）：后端那四个接口还没合进来时这里是 undefined，
 * 菜单据此不显示，也不用为了类型检查去动 api.ts。
 */
interface TreeOpsApi {
  createProjectFile?: (
    projectId: string,
    dir: string,
    name: string,
    content?: string,
  ) => Promise<{ path: string; size: number }>
  createProjectDir?: (projectId: string, dir: string, name: string) => Promise<{ path: string }>
  renameProjectFile?: (projectId: string, path: string, name: string) => Promise<{ path: string }>
  deleteProjectFile?: (projectId: string, path: string) => Promise<{ ok: true }>
}

/** 相对路径所在的目录，根目录是空字符串 */
const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')

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
  const [hitsError, setHitsError] = useState('')
  const [searching, setSearching] = useState(false)
  // 读到的层和每一层的状态放在 ref 里：请求回来自行更新，用计数触发渲染
  const levels = useRef<Record<string, DirLevel>>({})
  const states = useRef<Record<string, LevelState>>({})
  const [, setTick] = useState(0)
  const [version, setVersion] = useState(0)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const searchSeq = useRef(0)
  const rootSeq = useRef(0)
  /** 最后一次搜索的关键词和方式：换项目或刷新之后按同样的关键词重搜，不用用户再打一遍 */
  const lastSearch = useRef<{ q: string; mode: SearchMode } | null>(null)
  /** 每一层正在进行中的请求：同一层重复 load 复用同一个 Promise，递归展开才能等到结果 */
  const inflight = useRef<Record<string, { round: number; promise: Promise<DirLevel | null> }>>({})
  /**
   * 每一层请求的序号：写操作后强制重读时，先发的旧请求晚回来不能把新结果盖掉。
   * 只靠「轮次」区分不了同一轮里的一前一后。
   */
  const reqSeq = useRef<Record<string, number>>({})
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
    setHitsError('')
    setSearching(false)
    setInfo(null)
    setError('')
    setLoading(false)
    inflight.current = {}
    reqSeq.current = {}
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
   * 返回这一层的数据（失败时是 null）：递归展开要等每一层读完才知道下面还有哪些目录。
   */
  const load = (path: string): Promise<DirLevel | null> => {
    const project = projectId
    const task = taskId
    if (!project && !task) return Promise.resolve(null)
    const round = epoch.current
    if (levelEpoch.current[path] === round) return Promise.resolve(levels.current[path] ?? null)
    const doing = inflight.current[path]
    if (doing && doing.round === round) return doing.promise
    const seq = (reqSeq.current[path] = (reqSeq.current[path] ?? 0) + 1)
    // 刚点过刷新：这一轮读到的层不要服务端几秒内的旧状态
    const force = Date.now() < freshUntil.current
    states.current[path] = { loading: true, error: '' }
    pending.current[path] = round
    bump()
    const req = project ? api.fileLevel(project, path, force) : api.taskFileLevel(task!, path, force)
    const promise = req
      .then((level) => {
        // 换过项目的话这一层已经不属于当前范围了，丢掉；同一层有更新的请求时旧结果也让位
        if ((projectId || taskId) !== scopeRef.current || reqSeq.current[path] !== seq) return null
        levels.current = { ...levels.current, [path]: level }
        levelEpoch.current[path] = round
        states.current[path] = { loading: false, error: '' }
        // 新结果里没有的目录，连同它下面已经读过的层一起清掉，不留幽灵行
        pruneGone()
        return level
      })
      .catch((e) => {
        if ((projectId || taskId) === scopeRef.current && reqSeq.current[path] === seq)
          states.current[path] = { loading: false, error: (e as Error).message }
        return null
      })
      .finally(() => {
        if (pending.current[path] === round) delete pending.current[path]
        if (inflight.current[path]?.promise === promise) delete inflight.current[path]
        bump()
      })
    inflight.current[path] = { round, promise }
    return promise
  }

  /** 写操作之后强制重读一层：这一轮已经读过也要重新请求 */
  const reload = (path: string) => {
    delete levelEpoch.current[path]
    delete pending.current[path]
    delete inflight.current[path]
    void load(path)
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
    lastSearch.current = needle ? { q, mode } : null
    if (!needle || (!projectId && !taskId)) {
      setNames(null)
      setNamesError('')
      setNamesLoading(false)
      setHits([])
      setHitsTruncated(false)
      setHitsError('')
      setSearching(false)
      return
    }
    if (mode === 'name') {
      setNamesLoading(true)
      setNamesError('')
      setHits([])
      setHitsTruncated(false)
      setHitsError('')
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
    setHitsError('')
    setSearching(true)
    timer.current = setTimeout(() => {
      ;(projectId ? api.searchFileContent(projectId, needle) : api.searchTaskFiles(taskId!, needle))
        .then((r) => {
          if (seq !== searchSeq.current) return
          setHits(r.files)
          setHitsTruncated(r.truncated)
        })
        .catch((e) => {
          // 内容搜索的错误单独放：它只在内容结果里显示，不能混进根错误（那会让整棵树变成报错）
          if (seq === searchSeq.current) setHitsError((e as Error).message)
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
    if (cleared) {
      setVersion((v) => v + 1)
      // 换项目（或刷新）后缓存都清了：搜索框里的关键词还在，按同样的关键词重搜一遍
      const last = lastSearch.current
      if (last) search(last.q, last.mode)
    }
    loadRoot()
    // 项目切换、任务改动或执行结束时重新读；loadRoot、search 每次渲染都是新函数
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, taskId, refreshKey])

  useEffect(() => () => clearTimeout(timer.current), [])

  /** 在系统的文件管理器里打开；传空路径时打开项目（任务）目录本身 */
  const reveal = (path = '') => {
    if (projectId) void api.revealProjectFile(projectId, path).catch((e) => toast.error((e as Error).message))
    else if (taskId) void api.revealTaskFile(taskId, path).catch((e) => toast.error((e as Error).message))
  }

  /**
   * 树的写操作：四个接口都在、而且是项目（任务右栏只读）时才提供。
   * 成功后重读受影响的那一层，失败把原始错误抛给调用方去提示，不在这里静默重试。
   */
  const { createProjectFile, createProjectDir, renameProjectFile, deleteProjectFile } = api as unknown as TreeOpsApi
  const ops: FileTreeOps | undefined =
    projectId && createProjectFile && createProjectDir && renameProjectFile && deleteProjectFile
      ? {
          createFile: async (dir, name, content) => {
            const r = await createProjectFile(projectId, dir, name, content)
            reload(dir)
            return r
          },
          createDir: async (dir, name) => {
            const r = await createProjectDir(projectId, dir, name)
            reload(dir)
            return r
          },
          rename: async (path, name) => {
            const r = await renameProjectFile(projectId, path, name)
            reload(parentOf(path))
            return r
          },
          remove: async (path) => {
            await deleteProjectFile(projectId, path)
            reload(parentOf(path))
          },
        }
      : undefined

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
    // 用 getter：递归展开在 await 之后还要读最新读到的层，渲染时拿到的快照会过期
    get levels() {
      return levels.current
    },
    levelState: (path) => states.current[path] ?? { loading: false, error: '' },
    load,
    refresh,
    version,
    names,
    namesLoading,
    namesError,
    hits,
    hitsTruncated,
    hitsError,
    searching,
    search,
    reveal,
    absolute,
    ops,
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
  // hitLines 是这次要看的文件里全部命中的行号：弹窗接上之后用它做「上一处 / 下一处」
  const [target, setTarget] = useState<{ path: string; line?: number; hitLines?: number[] } | null>(null)
  // 弹窗里保存后重读树，否则改完的文件内容还对不上。
  // onSaved 是那个弹窗新增的可选回调，还没合进来前用展开语法传，避免类型检查卡在别处的改动上
  const saved = { onSaved: files.refresh } as Partial<ComponentProps<typeof ProjectFileDialog>>
  return (
    <>
      <FileExplorer
        browser={files}
        onOpen={(path, line, hitLines) => setTarget({ path, line, hitLines })}
        compact={compact}
        className={className}
      />
      <ProjectFileDialog
        projectId={projectId}
        dir={files.info?.dir ?? dir ?? ''}
        target={target}
        onOpenChange={(open) => !open && setTarget(null)}
        {...saved}
      />
    </>
  )
}
