/**
 * 演示：项目文件索引。演示项目的文件清单（DEMO_FILES）建成同一份 NameTable，按名字找、按文件夹取走 shared 里的同一份逻辑；
 * 演示没有推送通道，「全量重建」当场做完
 */
import { tableFromPaths, type NameTable } from '@shared/file-index/table'
import { fileIndexPage, fileIndexSettingsOf, type FileIndexStatus } from '@shared/file-index/types'
import type { Project } from '@shared/schema'
import { DEMO_FILES } from './demo-project-files'
import { fail } from './demo-http'
import { DEMO_FILE_INDEX_EVENT } from '@/lib/live/file-index-status'

interface DemoIndex {
  /** 演示的重建：开始的时间，建完清掉（进度按过去了多久算） */
  buildingSince?: number
  /** 演示的「增量更新」：核对中，核对完清掉（状态卡和侧栏都显示核对中） */
  verifying?: boolean
  table: NameTable
  builtAt: number
  buildMs: number
  changedAt: number
}
const indexes = new Map<string, DemoIndex>() // 演示的索引只在这一页里
const BYTES_PER_FILE = 18
/** 演示的重建用这么久：侧栏底部的进度和状态卡的「建立中」看得见 */
const DEMO_BUILD_MS = 4000
/** 演示的核对用这么久：超过侧栏的 1.5 秒门槛，看得见两处一起显示核对中、核对完一起收 */
const DEMO_VERIFY_MS = 5000
/** 演示的「目录」规模：进度条上的数假装是个中等项目 */
const DEMO_DIRS = 3200
const DEMO_FILES_SHOWN = 41_000

function indexOf(projectId: string): DemoIndex {
  let x = indexes.get(projectId)
  if (!x) {
    const now = Date.now() - 42 * 60_000
    x = { table: tableFromPaths(DEMO_FILES), builtAt: now - 3 * 3600_000, buildMs: 380, changedAt: now }
    indexes.set(projectId, x)
  }
  return x
}

function statusOf(p: Project): FileIndexStatus {
  const s = fileIndexSettingsOf(p)
  if (!s.enabled) return { projectId: p.id, enabled: false, state: 'off', files: 0, dirs: 0, bytes: 0, roots: [] }
  const x = indexOf(p.id)
  if (x.buildingSince) {
    const f = Math.min(1, (Date.now() - x.buildingSince) / DEMO_BUILD_MS)
    const progress = { dirs: Math.round(DEMO_DIRS * f), files: Math.round(DEMO_FILES_SHOWN * f) }
    const root = {
      key: `demo-${p.id}`,
      root: p.path,
      source: 'project',
      vcs: 'git' as const,
      files: progress.files,
      dirs: progress.dirs,
      bytes: 0,
    }
    return {
      projectId: p.id,
      enabled: true,
      state: 'building',
      files: progress.files,
      dirs: progress.dirs,
      bytes: 0,
      roots: [{ ...root, state: 'building' as const, progress, watching: 'none' as const }],
    }
  }
  const { files, dirs } = x.table.size
  const bytes = files * BYTES_PER_FILE + 64
  return {
    projectId: p.id,
    enabled: true,
    state: x.verifying ? 'verifying' : 'ready',
    files,
    dirs,
    bytes,
    roots: [
      {
        key: `demo-${p.id}`,
        root: p.path,
        source: 'project',
        vcs: 'git',
        state: x.verifying ? 'verifying' : 'ready',
        files,
        dirs,
        bytes,
        builtAt: x.builtAt,
        buildMs: x.buildMs,
        changedAt: x.changedAt,
        verifiedAt: x.changedAt,
        lastBy: 'verify',
        // 演示按 Windows / macOS 的情形：选了「不盯」才不用系统通知
        watching: s.watch === 'off' ? 'none' : 'system',
      },
    ],
  }
}

export const demoFileIndexUsage = () => {
  const files = indexes.size
  const bytes = [...indexes.values()].reduce((a, x) => a + x.table.size.files * BYTES_PER_FILE + 64, 0)
  return { files, bytes }
}

const csv = (v: string | null) =>
  (v ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)

const emitOf = (p: Project) => () =>
  window.dispatchEvent(new CustomEvent(DEMO_FILE_INDEX_EVENT, { detail: { projectId: p.id, status: statusOf(p) } }))

function simulateBuild(p: Project, x: DemoIndex) {
  x.buildingSince = Date.now()
  const emit = emitOf(p)
  const timer = setInterval(() => {
    if (Date.now() - (x.buildingSince ?? 0) >= DEMO_BUILD_MS) {
      clearInterval(timer)
      x.buildingSince = undefined
      x.table = tableFromPaths(DEMO_FILES)
      x.builtAt = x.changedAt = Date.now()
      x.buildMs = DEMO_BUILD_MS
    }
    emit()
  }, 300)
  emit()
}

/** /projects/:id/file-index[/find|list|refresh|rebuild] */
export function demoProjectFileIndex(
  method: string,
  p: Project | undefined,
  action: string | undefined,
  query: URLSearchParams,
) {
  if (!p) return fail('找不到这个项目', 404)
  if (!action) return statusOf(p)
  if (!fileIndexSettingsOf(p).enabled) return fail('这个项目没有开文件索引')
  const x = indexOf(p.id)
  if (action === 'find') {
    const limit = Math.min(Math.max(Number(query.get('limit')) || 50, 1), 5000)
    const offset = Math.max(Number(query.get('offset')) || 0, 0)
    const hits = x.table.find(query.get('q') ?? '', {
      under: csv(query.get('under')),
      ext: csv(query.get('ext')),
      dirs: query.get('dirs') === '1',
      cap: offset + limit + 1000,
    })
    return fileIndexPage(
      hits.map((h) => h.path),
      offset,
      limit,
    )
  }
  if (action === 'list') {
    const r = x.table.list(
      (query.get('dir') ?? '').replace(/^\.?\/+|\/+$/g, ''),
      query.get('recursive') === '1',
      csv(query.get('ext')),
    )
    return r ?? fail('索引里没有这个目录（不存在，或在排除目录里）', 404)
  }
  if (action === 'refresh' && method === 'POST') {
    // 和正式版一样：核对期间推「核对中」，核对完推「就绪」再回结果
    const emit = emitOf(p)
    x.verifying = true
    emit()
    return new Promise((done) =>
      setTimeout(() => {
        x.verifying = false
        x.changedAt = Date.now()
        emit()
        done({ checked: x.table.size.dirs, added: 0, removed: 0 })
      }, DEMO_VERIFY_MS),
    )
  }
  // 演示没有推送通道：重建假装建几秒，进度在页面里发窗口事件（和正式版的推送同一种数据）
  if (action === 'rebuild' && method === 'POST') {
    if (!x.buildingSince) simulateBuild(p, x)
    return statusOf(p)
  }
  return fail('没有这个接口', 404)
}

/** /file-index（数据页） */
export function demoFileIndexOverview(method: string, key: string | undefined, projects: Project[]) {
  if (method === 'DELETE' && !key) {
    indexes.clear()
    return { ok: true }
  }
  if (method === 'DELETE' && key) {
    indexes.delete(key.replace(/^demo-/, ''))
    return { ok: true }
  }
  if (method === 'POST' && key) {
    const p = projects.find((x) => `demo-${x.id}` === key)
    if (p) demoProjectFileIndex('POST', p, 'rebuild', new URLSearchParams())
    return { ok: true }
  }
  const entries = projects
    .filter((p) => indexes.has(p.id))
    .map((p) => {
      const s = statusOf(p)
      return {
        key: `demo-${p.id}`,
        root: p.path,
        projects: [{ id: p.id, name: p.name }],
        vcs: 'git',
        state: s.state,
        files: s.files,
        dirs: s.dirs,
        bytes: s.bytes,
        changedAt: s.roots[0]?.changedAt,
        builtAt: s.roots[0]?.builtAt,
      }
    })
  return { dir: '~/.agent-panel/file-index', bytes: entries.reduce((a, e) => a + e.bytes, 0), entries }
}

/** 演示后端的入口：/file-index… 和 /projects/:id/file-index… */
export function demoFileIndex(method: string, seg: string[], query: URLSearchParams, projects: Project[]) {
  const [res, id, sub, action] = seg
  if (res === 'file-index') return demoFileIndexOverview(method, id, projects)
  if (res === 'projects' && sub === 'file-index')
    return demoProjectFileIndex(
      method,
      projects.find((p) => p.id === id),
      action,
      query,
    )
  return fail('没有这个接口', 404)
}
