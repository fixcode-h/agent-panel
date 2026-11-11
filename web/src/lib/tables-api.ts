/**
 * 表格页的接口（server/tables/*）：列表、打开、内容搜索、结构文件；保存、版本、对比、AI 分析也从这里调。
 * 在线演示由 demo-tables.ts 模拟。
 */
import type { TableDoc, TableRoot, TableSchema, TableSearch, TablesConfig, TablesIndex } from '@shared/tables'
import type { TableSave } from '@shared/table-edit'
import type { SheetProblems } from '@shared/table-struct'
import type { SheetData } from '@shared/files'
import { json, request } from './api'

const q = encodeURIComponent

export const tablesApi = {
  list: (projectId: string) => request<TablesIndex>(`/tables/${projectId}`),
  /** 按还没保存的配置找一遍（项目设置里逐个目录显示找到几个） */
  probe: (projectId: string, path: string, tables: TablesConfig) =>
    request<TablesProbe>(`/tables/${projectId}/probe`, json('POST', { path, tables })),
  open: (projectId: string, path: string) => request<TableDoc>(`/tables/${projectId}/file?path=${q(path)}`),
  search: (projectId: string, query: string) => request<TableSearch>(`/tables/${projectId}/search?q=${q(query)}`),
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
  /** 跨项目对比：按相对路径配对 */
  compare: (projectId: string, other: string) =>
    request<{ pairs: TablePair[]; truncated?: boolean }>(`/tables/${projectId}/compare?other=${q(other)}`),
  /** 全项目检查 */
  check: (projectId: string) => request<TablesCheck>(`/tables/${projectId}/check`),
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
