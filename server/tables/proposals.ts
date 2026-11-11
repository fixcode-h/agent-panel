/**
 * AI 提的表格改动（table.propose）：先存在这里，不写文件。表格页打开这张表时取出来给用户看差异，
 * 用户点「放进表格」才变成页面上的改动、再走正常保存。只放内存：面板重启就没了，AI 再提一次就行。
 * 每个文件只留最新的一份
 */
import type { SheetEdit } from '../../shared/table-edit.ts'

export interface TableProposal {
  id: string
  path: string
  sheet: string
  /** 提出时文件的修改时间：对不上说明文件之后改过，提议作废 */
  mtime: string
  edit: SheetEdit
  /** 给用户看的一句话：这次改了什么、为什么 */
  note: string
  cells: number
  added: number
  removed: number
  at: string
}

const store = new Map<string, TableProposal>()
const MAX = 200
const key = (projectId: string, path: string) => `${projectId}\n${path}`

export function putProposal(projectId: string, p: Omit<TableProposal, 'id' | 'at'>): TableProposal {
  const full: TableProposal = { ...p, id: Math.random().toString(36).slice(2, 10), at: new Date().toISOString() }
  const k = key(projectId, p.path)
  store.delete(k)
  store.set(k, full)
  if (store.size > MAX) store.delete(store.keys().next().value!)
  return full
}

export const getProposal = (projectId: string, path: string) => store.get(key(projectId, path)) ?? null

export function dropProposal(projectId: string, path: string, id?: string) {
  const k = key(projectId, path)
  if (!id || store.get(k)?.id === id) store.delete(k)
}
