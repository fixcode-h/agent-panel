/**
 * 记住每个项目的文档根（给插件和文件索引用）。文档根定下来以后不会自己变：P4 / SVN 项目记在文档组里，
 * 只有项目设置改了、或在项目设置里换了共用文档根时才变。以前每分钟重新算一遍——判断版本管理、读文档组记录，
 * P4 慢的时候几秒，UE 插件的每个接口取项目都要等它，Forge、测试页「打开要加载好久」（用户 2026-11-23：
 * 「不是直接就知道文档路径在哪里么」「直接 docs 纳入 index，建立缓存」）。
 * 现在算一次就记住并落盘（<数据目录>/doc-roots.json），重启也直接用；项目改了（updatedAt 变了）或文档根换了（forgetDocRoots）才重算。
 *
 * 重算出来和上次不一样时发 onDocRootChange（开放给插件）：插件自己记着文档根的（UE 插件）马上跟上，
 * 不用再按 TTL 隔一分钟重问（「可统一能力盘点」第 7 项）。项目保存后服务端主动重算一次（index.ts 的 PUT /projects/:id）
 */
import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Project } from '../../shared/schema.ts'
import { DATA_DIR } from '../store.ts'

const FILE = () => path.join(DATA_DIR, 'doc-roots.json')

interface Saved {
  sig: string
  root?: string
}
let saved: Record<string, Saved> | undefined // 模块状态：缓存，落盘一份
const pending = new Map<string, { sig: string; root: Promise<string | undefined> }>() // 模块状态：运行时
/** root 为 undefined：可能变了但还没重算（共用文档根换了位置），收到的一方自己重新问 */
type Listener = (projectId: string, root: string | undefined) => void
const listeners = new Set<Listener>() // 模块状态：运行时，订阅方自己退订

/** 项目的文档根变了（或可能变了）时调 fn；返回退订函数 */
export function onDocRootChange(fn: Listener) {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}

function emit(projectId: string, root: string | undefined) {
  for (const fn of listeners)
    try {
      fn(projectId, root)
    } catch {
      // 一个订阅方出错不影响别的
    }
}

function load() {
  if (saved) return saved
  try {
    const raw = JSON.parse(readFileSync(FILE(), 'utf8')) as unknown
    saved = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, Saved>) : {}
  } catch {
    saved = {}
  }
  return saved
}

function persist() {
  const body = JSON.stringify(saved ?? {})
  void mkdir(DATA_DIR, { recursive: true })
    .then(() => writeFile(FILE(), body))
    .catch(() => {
      // 写不进去只是下次启动要重算一次
    })
}

export function cachedDocRoot(
  p: Project,
  ask: (p: Project) => Promise<string | undefined>,
): Promise<string | undefined> {
  const sig = `${p.path}|${p.updatedAt ?? ''}`
  const hit = load()[p.id]
  if (hit?.sig === sig) return Promise.resolve(hit.root)
  const run = pending.get(p.id)
  if (run?.sig === sig) return run.root
  const root = ask(p).then(
    (r) => {
      load()[p.id] = { sig, root: r }
      persist()
      pending.delete(p.id)
      if (hit && hit.root !== r) emit(p.id, r)
      return r
    },
    (e: unknown) => {
      // 算失败不记：下次再算
      pending.delete(p.id)
      throw e
    },
  )
  pending.set(p.id, { sig, root })
  return root
}

/** 共用文档根换了位置（项目设置里改的）：所有项目下次重算 */
export function forgetDocRoots() {
  // 只作废签名、留着旧的根：下次重算出来能和旧的比，变了才发事件
  const all = load()
  for (const v of Object.values(all)) v.sig = ''
  pending.clear()
  persist()
  for (const id of Object.keys(all)) emit(id, undefined)
}
