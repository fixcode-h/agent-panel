/**
 * 「表格」入口打开哪个项目：上次在表格页看的那个（还开着表格功能的话），否则第一个设了表格目录的项目。
 * 没有项目设表格目录时返回空，入口就不显示
 */
import { tablesOn } from '@shared/tables'
import { useData } from './data'

const KEY = 'tables-last-project'

export function rememberTablesProject(id: string) {
  try {
    localStorage.setItem(KEY, id)
  } catch {
    // 隐私模式等存不了：下次打开回到第一个项目，不影响使用
  }
}

function lastTablesProject() {
  try {
    return localStorage.getItem(KEY) ?? ''
  } catch {
    return ''
  }
}

/** 开了表格功能的项目 */
export function useTablesProjects() {
  return useData().projects.filter((p) => tablesOn(p.tables))
}

export function useTablesEntry(): string {
  const list = useTablesProjects()
  const last = lastTablesProject()
  return (list.find((p) => p.id === last) ?? list[0])?.id ?? ''
}
