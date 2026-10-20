/** 面板自己的版本和 GitHub Releases 上的包：设置里「版本更新」用，服务端和在线演示共用 */

export const REPO = 'fixcode-h/agent-panel'

export interface AppRelease {
  /** 例如 v0.11.22-dev */
  tag: string
  version: string
  /** 预览版（dev 分支出的包） */
  prerelease: boolean
  publishedAt: string
  /** 更新说明（Markdown） */
  notes: string
  /** Release 页面 */
  url: string
  /** 包的下载地址（tar.gz 和 zip） */
  tarUrl: string
  zipUrl: string
  /** 包的 SHA256 校验文件；早期的包没有 */
  sumsUrl?: string
  size: number
}

export interface AppReleases {
  /** 当前运行的版本；从源码运行时是 package.json 的版本 */
  current: string
  /** 是否从发布的包运行；只有包能在设置里更新 */
  packaged: boolean
  /** 更新前留下的上一个版本，可以退回；没有时为空 */
  previous?: string
  /** 最近的几个包，新的在前 */
  releases: AppRelease[]
  /** 比当前新的包（正式版只看正式版，预览版看全部） */
  update?: AppRelease
  /** 上次从 GitHub 读到发布列表的时间 */
  checkedAt?: string
  error?: string
}

export interface AppUpdateJob {
  id: string
  tag: string
  status: 'running' | 'done' | 'failed'
  /** 当前阶段的说明 */
  phase: string
  received: number
  total: number
  /** 下载完了，在等正在执行的任务结束；这时可以强制更新 */
  waiting?: boolean
  error?: string
}

/** v0.11.22-dev → [0, 11, 22, 预览版] */
export function parseVersion(v: string) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(-dev)?/.exec(v.trim())
  return m ? { nums: [Number(m[1]), Number(m[2]), Number(m[3])], dev: !!m[4] } : null
}

/** 比较两个版本，a 新返回正数；版本号相同时正式版比预览版新 */
export function compareVersions(a: string, b: string) {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) return 0
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] - y.nums[i]
  return Number(y.dev) - Number(x.dev)
}

/** 有没有可以更新到的包：正在用正式版的只提示正式版，用预览版的提示更新的任何包 */
export function pickUpdate(current: string, releases: AppRelease[]) {
  const cur = parseVersion(current)
  if (!cur) return undefined
  return releases
    .filter((r) => (cur.dev || !r.prerelease) && compareVersions(r.version, current) > 0)
    .sort((a, b) => compareVersions(b.version, a.version))[0]
}
