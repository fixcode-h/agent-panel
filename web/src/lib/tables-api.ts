/**
 * 表格页的接口（server/tables/*）：列表、打开、内容搜索、结构文件；保存、版本、对比、AI 分析也从这里调。
 * 在线演示由 demo-tables.ts 模拟。
 */
import type { TableDoc, TableSchema, TableSearch, TablesIndex } from '@shared/tables'
import { json, request } from './api'

const q = encodeURIComponent

export const tablesApi = {
  list: (projectId: string) => request<TablesIndex>(`/tables/${projectId}`),
  open: (projectId: string, path: string) => request<TableDoc>(`/tables/${projectId}/file?path=${q(path)}`),
  search: (projectId: string, query: string) => request<TableSearch>(`/tables/${projectId}/search?q=${q(query)}`),
  schema: (projectId: string) => request<TableSchema>(`/tables/${projectId}/schema`),
  saveSchema: (projectId: string, s: TableSchema) =>
    request<TableSchema>(`/tables/${projectId}/schema`, json('PUT', s)),
}
