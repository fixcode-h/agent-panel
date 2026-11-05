/** 对话消息里提到的文件：解析成本机路径、用系统程序打开。从 api.ts 拆出（api.ts 到了行数上限），api 里展开引入 */
import { json, request } from './api'

/** 和 server/task-paths.ts 的 PathInfo 一致 */
export interface PathInfo {
  path: string
  abs: string
  rel: string
  inTask: boolean
  exists: boolean
  dir: boolean
  text: boolean
  size?: number
  mtime?: string
}

export const pathsApi = {
  /** 一批路径一起解析：完整路径、在不在、是不是目录（悬停卡片和「找不到」的样式用） */
  taskPaths: (id: string, paths: string[]) =>
    request<{ items: PathInfo[] }>(`/tasks/${id}/paths`, json('POST', { paths })),
  /** 用系统默认程序打开（会被执行的类型改成在文件夹里显示）；reveal 时直接在文件夹里显示 */
  openTaskPath: (id: string, path: string, reveal = false) =>
    request<{ ok: boolean; revealed: boolean; abs: string }>(`/tasks/${id}/open-path`, json('POST', { path, reveal })),
}
