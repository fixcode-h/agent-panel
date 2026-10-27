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
  /**
   * GitHub 限流到这一刻（ISO）：存在时说明 releases 是上次的结果，不是刚刚查到的。
   * 页面据此显示温和提示，而不是当成检查失败
   */
  limitedUntil?: string
  error?: string
}

/** 被强制更新打断的任务：新版本启动后弹窗问用户要不要继续 */
export interface InterruptedTask {
  id: string
  title: string
  /** 空表示聊天（不属于任何项目） */
  projectId: string
  projectName: string
  /** 被打断时正在做的事：正在执行的节点标题，没有时用最后一条要求 */
  doing: string
}

export interface InterruptedTasks {
  /** 这次强制更新的时间；没有记录时为空 */
  at: string
  /** 用户已经处理过这次记录：页面不再自动弹窗 */
  acknowledged: boolean
  tasks: InterruptedTask[]
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
  /** 最近一次有进展的时间（ISO）：判断卡住了没有用 */
  updatedAt?: string
  error?: string
}

/**
 * 已经开始、还没结束的更新（在 /app/install 撞上 409 时一并返回）。
 * 光有一句「正在更新」看不出来卡在哪，页面拿到它就能直接显示进度和「强制更新」
 */
export interface AppUpdateBusy {
  /** 正在跑的那个更新；可能已经卡住，见 stale */
  job: AppUpdateJob
  /** 超过 STALE_UPDATE_MS 没有进展，下一次点更新会把它作废重新开始 */
  stale: boolean
}

/** 更新多久没有进展算卡住：下载卡住、等任务结束等太久都按这个算 */
export const STALE_UPDATE_MS = 10 * 60_000

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

/** 被 GitHub 限流后默认多久内不再请求；响应里带了 retry-after / x-ratelimit-reset 时按它算 */
export const LIMIT_COOLDOWN_MS = 15 * 60_000

/**
 * 限流要等到什么时候：优先 retry-after（秒），其次 x-ratelimit-reset（Unix 秒），
 * 都没有时按默认冷却时间算。这两个头只有 403 / 429 才可能带。
 * 服务端和在线演示共用：两边的请求路径不同，限流的处理要一致。
 */
export function rateLimitUntil(res: Response, now = Date.now()) {
  const retry = Number(res.headers.get('retry-after'))
  if (Number.isFinite(retry) && retry > 0) return now + retry * 1000
  const reset = Number(res.headers.get('x-ratelimit-reset'))
  if (Number.isFinite(reset) && reset > 0 && reset * 1000 > now) return reset * 1000
  return now + LIMIT_COOLDOWN_MS
}

/**
 * 距限流恢复还有几分钟：向上取整、至少 1 分钟。
 * 服务端报错文案和页面提示共用这一个口径，两边不会差一分钟
 */
export function minutesUntil(until: number | string, now = Date.now()) {
  const at = typeof until === 'string' ? Date.parse(until) : until
  return Number.isNaN(at) ? 1 : Math.max(1, Math.ceil((at - now) / 60_000))
}

/** 有没有可以更新到的包：正在用正式版的只提示正式版，用预览版的提示更新的任何包 */
export function pickUpdate(current: string, releases: AppRelease[]) {
  const cur = parseVersion(current)
  if (!cur) return undefined
  return releases
    .filter((r) => (cur.dev || !r.prerelease) && compareVersions(r.version, current) > 0)
    .sort((a, b) => compareVersions(b.version, a.version))[0]
}
