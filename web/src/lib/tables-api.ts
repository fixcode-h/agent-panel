/**
 * 表格页的接口（server/tables/*）：列表、打开、内容搜索、结构文件；保存、版本、对比、AI 分析也从这里调。
 * 在线演示由 demo-tables.ts 模拟。
 */
import type { TableDoc, TableRoot, TableSchema, TableSearch, TablesConfig, TablesIndex } from '@shared/tables'
import type { SheetEdit, TableSave } from '@shared/table-edit'
import type { SheetProblems } from '@shared/table-struct'
import type { SheetData } from '@shared/files'
import type { ExportEvent } from '@shared/table-export'
import type { EnumRename } from '@shared/table-enum-rename'
import type { CellAt, CellChange } from '@shared/table-blame'
import { failure, json, request } from './api'
import { trackedFetch } from './connection'

const q = encodeURIComponent

export const tablesApi = {
  /** fresh：重走目录（刷新按钮），不用服务端几秒内的缓存 */
  list: (projectId: string, fresh = false) => request<TablesIndex>(`/tables/${projectId}${fresh ? '?fresh=1' : ''}`),
  /** 按还没保存的配置找一遍（项目设置里逐个目录显示找到几个） */
  probe: (projectId: string, path: string, tables: TablesConfig) =>
    request<TablesProbe>(`/tables/${projectId}/probe`, json('POST', { path, tables })),
  open: (projectId: string, path: string) => request<TableDoc>(`/tables/${projectId}/file?path=${q(path)}`),
  /** 文件现在的修改时间（外部改动检测） */
  stat: (projectId: string, path: string) =>
    request<{ mtime?: string; size?: number; missing?: boolean }>(`/tables/${projectId}/stat?path=${q(path)}`),
  search: (projectId: string, query: string, signal?: AbortSignal) =>
    request<TableSearch>(`/tables/${projectId}/search?q=${q(query)}`, { signal }),
  schema: (projectId: string) => request<TableSchema>(`/tables/${projectId}/schema`),
  saveSchema: (projectId: string, s: TableSchema) =>
    request<TableSchema>(`/tables/${projectId}/schema`, json('PUT', s)),
  /** 保存改动：返回保存后的文件 */
  save: (projectId: string, body: TableSave) => request<TableDoc>(`/tables/${projectId}/save`, json('POST', body)),
  /** AI 分析表格风格用的样本 */
  sample: (projectId: string) => request<{ text: string; files: number }>(`/tables/${projectId}/sample`),
  /** 版本记录 */
  history: (projectId: string, path: string) => request<TableHistory>(`/tables/${projectId}/history?path=${q(path)}`),
  /** 某一版的内容 */
  at: (projectId: string, path: string, rev: string) =>
    request<{ sheets: SheetData[] }>(`/tables/${projectId}/at?path=${q(path)}&rev=${q(rev)}`),
  /** 一格的历史：哪几次提交改过它 */
  cellHistory: (projectId: string, path: string, at: CellAt) =>
    request<CellHistory>(
      `/tables/${projectId}/cell-history?path=${q(path)}&` +
        new URLSearchParams(Object.entries(at).flatMap(([k, v]) => (v === undefined ? [] : [[k, String(v)]]))),
    ),
  /** 跨项目对比：按相对路径配对 */
  compare: (projectId: string, other: string) =>
    request<{ pairs: TablePair[]; truncated?: boolean }>(`/tables/${projectId}/compare?other=${q(other)}`),
  /** 跨项目批量同步：apply=false 只预览 */
  sync: (
    projectId: string,
    body: { other: string; items: SyncItem[]; mode: 'file' | 'column'; field?: string; apply: boolean },
  ) => request<{ results: SyncResult[] }>(`/tables/${projectId}/sync`, json('POST', body)),
  /** AI 提的改动（还没写进文件） */
  proposal: (projectId: string, path: string) =>
    request<{ proposal: TableProposal | null }>(`/tables/${projectId}/proposal?path=${q(path)}`),
  dropProposal: (projectId: string, path: string, id: string) =>
    request<{ ok: true }>(`/tables/${projectId}/proposal?path=${q(path)}&pid=${q(id)}`, { method: 'DELETE' }),
  /** 全项目检查 */
  check: (projectId: string, all = false) => request<TablesCheck>(`/tables/${projectId}/check${all ? '?all=1' : ''}`),
  /** 把本地文件切换到某一版：返回切换后的文件 */
  checkout: (projectId: string, path: string, rev: string) =>
    request<TableDoc>(`/tables/${projectId}/checkout`, json('POST', { path, rev })),
  runExport,
  /** 这个文件在版本管理里的状态 */
  vcsStatus: (projectId: string, path: string) => request<VcsStatus>(`/tables/${projectId}/vcs-status?path=${q(path)}`),
  /** 只提交这一个文件 */
  vcsSubmit: (projectId: string, path: string, message: string) =>
    request<{ vcs: string; out: string }>(`/tables/${projectId}/vcs-submit`, json('POST', { path, message })),
  /** 开始合并冲突：共同祖先、对方的内容；replaced 时工作区文件换成了干净的我这边，要重新载入 */
  mergeStart: (projectId: string, path: string) =>
    request<MergeSources>(`/tables/${projectId}/merge-start`, json('POST', { path })),
  /** 合并保存后标记冲突已解决 */
  vcsResolve: (projectId: string, path: string) =>
    request<VcsStatus>(`/tables/${projectId}/vcs-resolve`, json('POST', { path })),
  /** 枚举值改名后替换所有表里的旧值；apply=false 只预览 */
  enumRename: (projectId: string, renames: EnumRename[], apply: boolean) =>
    request<EnumRenameResult>(`/tables/${projectId}/enum-rename`, json('POST', { renames, apply })),
}

export interface TableProposal {
  id: string
  path: string
  sheet: string
  mtime: string
  edit: SheetEdit
  note: string
  cells: number
  added: number
  removed: number
  at: string
}

export interface SyncItem {
  path: string
  left?: string
  right?: string
}

export interface SyncResult {
  path: string
  action: 'create' | 'replace' | 'cells' | 'same' | 'skip'
  cells: number
  missing?: number
  error?: string
}

export interface VcsStatus {
  vcs: 'git' | 'p4' | 'svn' | 'none'
  changed: boolean
  conflict: boolean
  error?: string
}

export interface MergeSources {
  vcs: string
  base: SheetData[]
  theirs: SheetData[]
  theirsLabel: string
  replaced: boolean
}

export interface CellHistory {
  vcs: string
  changes: CellChange<TableRev>[]
  scanned: number
  error?: string
}

export interface EnumRenameResult {
  files: { path: string; cells: number }[]
  failed: { path: string; error: string }[]
  applied: boolean
}

/** 执行导表脚本：服务端一行一个 JSON 边跑边推，每收到一条回调一次；signal 停止（服务端跟着停掉命令） */
async function runExport(
  projectId: string,
  script: number,
  paths: string[],
  onEvent: (e: ExportEvent) => void,
  signal?: AbortSignal,
) {
  const url = `/tables/${projectId}/export`
  // 演示版没有后端：模拟出整串消息，隔一会儿放一条
  if (import.meta.env.VITE_DEMO) {
    const events = await request<ExportEvent[]>(url, json('POST', { script, paths }))
    for (const e of events) {
      if (signal?.aborted) return
      await new Promise((r) => setTimeout(r, 120))
      onEvent(e)
    }
    return
  }
  const res = await trackedFetch(`/api${url}`, {
    ...json('POST', { script, paths }),
    headers: { 'Content-Type': 'application/json' },
    signal,
  })
  if (!res.ok) await failure(res)
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += value
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (line) onEvent(JSON.parse(line) as ExportEvent)
    }
  }
}

export interface TableRev {
  id: string
  label: string
  author: string
  time: string
  message: string
}
export interface TableHistory {
  vcs: 'git' | 'p4' | 'svn' | 'none'
  base: string
  revs: TableRev[]
  error?: string
}
export interface TablePair {
  /** 配对用的路径（项目目录外的表格目录是「目录名/里面的路径」） */
  path: string
  /** 和 path 不一样时，两边各自的真实路径 */
  left?: string
  right?: string
  status: 'same' | 'diff' | 'left' | 'right' | 'error'
  error?: string
}

export interface TablesCheck {
  files: number
  sheets: SheetProblems[]
  failed: { path: string; error: string }[]
}

/** 按还没保存的表格配置找一遍的结果 */
export interface TablesProbe {
  roots: TableRoot[]
  files: number
  /** 前几个文件的路径 */
  sample: string[]
  truncated?: boolean
}
