import type { RemoteAccess } from './schema.ts'

export type RemoteMode = RemoteAccess['mode']

/** 隧道当前的状态：off 没开，starting 正在连，running 可用，error 出错 */
export type RemoteState = 'off' | 'starting' | 'running' | 'error'

export interface CloudflaredInfo {
  installed: boolean
  version: string
  path: string
  /** 没找到或检测失败的原因 */
  error: string
}

/** 设置页「外部访问」显示的状态 */
export interface RemoteAccessStatus {
  enabled: boolean
  mode: RemoteMode
  state: RemoteState
  /** 外网访问地址（不带令牌） */
  url: string
  /** 带访问令牌的地址，外网的浏览器用它打开一次 */
  link: string
  /** 出错原因 */
  error: string
  cloudflared: CloudflaredInfo
  /** 正在下载 cloudflared；percent 为 -1 时不知道总大小 */
  download: { running: boolean; percent: number; error: string } | null
}
