/**
 * 外网登录的会话表和登录失败计数。
 *
 * 做法参考 dsh-web-guard（https://github.com/lvxianchao/dsh-web-guard，MIT，Copyright (c) 2026 lvxianchao）的 SessionStore：
 * - 浏览器拿到的是随机令牌，服务端只存它的 SHA-256：拿到会话文件或内存快照也伪造不出能用的 Cookie
 * - 每个会话按最后活动时间滑动过期；会话表落盘，面板重启（更新、改设置）不会把已登录的设备踢下线
 * - 同一个来源连续输错锁一段时间；经过隧道 / 反代时来源 IP 可能都一样，另有一道全局上限兜底
 */
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { writeJsonAtomic } from '../store.ts'

export interface SessionRow {
  createdAt: number
  lastSeen: number
  ip: string
  ua: string
}

/** 给设置页看的会话：id 是摘要的前 16 位，不是令牌本身 */
export interface SessionView extends SessionRow {
  id: string
}

export interface SessionLimits {
  /** 会话多少天没活动就失效；0 = 关掉浏览器就失效（服务端最多留 12 小时） */
  sessionDays: number
  /** 连续输错几次锁定 */
  maxAttempts: number
  /** 锁多少分钟 */
  lockMinutes: number
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const DAY = 24 * 60 * 60 * 1000
/** 全局失败上限是单个来源的这么多倍：挡住换着 IP（或经过隧道看不出 IP）一直试 */
const GLOBAL_FACTOR = 10

export class SessionStore {
  private sessions = new Map<string, SessionRow>()
  private failures = new Map<string, { fails: number; until: number }>()
  private loaded = false
  private timer: NodeJS.Timeout | null = null
  limits: SessionLimits = { sessionDays: 7, maxAttempts: 5, lockMinutes: 5 }

  private file: string

  constructor(file: string) {
    this.file = file
  }

  private get ttl() {
    return this.limits.sessionDays > 0 ? this.limits.sessionDays * DAY : DAY / 2
  }

  /** 读上次落盘的会话；文件坏了当没有，不能因为缓存坏了挡住登录 */
  private load() {
    if (this.loaded) return
    this.loaded = true
    if (!this.file) return
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8')) as {
        version?: number
        sessions?: Record<string, unknown>
      }
      if (data?.version !== 1 || !data.sessions || typeof data.sessions !== 'object') return
      const now = Date.now()
      for (const [key, v] of Object.entries(data.sessions)) {
        const row = v as Partial<SessionRow>
        if (!/^[0-9a-f]{64}$/.test(key) || typeof row?.createdAt !== 'number' || typeof row.lastSeen !== 'number')
          continue
        if (now - row.lastSeen > this.ttl) continue
        this.sessions.set(key, {
          createdAt: row.createdAt,
          lastSeen: row.lastSeen,
          ip: String(row.ip ?? ''),
          ua: String(row.ua ?? ''),
        })
      }
    } catch {}
  }

  /** 一阵改动合成一次写盘；写不进去（盘满、只读）不影响登录，内存里照常用 */
  private persist() {
    if (!this.file || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, 500)
    this.timer.unref()
  }

  async flush() {
    if (!this.file) return
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const sessions = Object.fromEntries(this.sessions)
    await writeJsonAtomic(this.file, { version: 1, savedAt: Date.now(), sessions }, true, 0o600).catch(() => {})
  }

  private failRow(key: string) {
    const row = this.failures.get(key)
    if (row && row.until && row.until <= Date.now()) {
      this.failures.delete(key)
      return undefined
    }
    return row
  }

  /** 这个来源现在是不是被锁着（全局上限也算） */
  isLocked(ip: string) {
    return !!this.failRow(ip)?.until || !!this.failRow('*')?.until
  }

  /** 记一次输错，返回还能再试几次（锁上时为 0） */
  recordFailure(ip: string) {
    const lock = this.limits.lockMinutes * 60_000
    const bump = (key: string, max: number) => {
      const row = this.failRow(key) ?? { fails: 0, until: 0 }
      row.fails += 1
      if (row.fails >= max) row.until = Date.now() + lock
      this.failures.set(key, row)
      return row
    }
    bump('*', this.limits.maxAttempts * GLOBAL_FACTOR)
    const row = bump(ip, this.limits.maxAttempts)
    return row.until ? 0 : Math.max(0, this.limits.maxAttempts - row.fails)
  }

  clearFailures(ip: string) {
    this.failures.delete(ip)
  }

  /** 登录成功：发一个新会话，返回给浏览器的令牌（服务端只留摘要） */
  issue(ip: string, ua: string) {
    this.load()
    const token = randomBytes(32).toString('base64url')
    const now = Date.now()
    this.sessions.set(sha256(token), { createdAt: now, lastSeen: now, ip, ua: ua.slice(0, 300) })
    this.persist()
    return token
  }

  /** 令牌对应的会话，顺手续上最后活动时间；过期的删掉 */
  resolve(token: string | undefined): SessionRow | undefined {
    if (!token) return undefined
    this.load()
    const key = sha256(token)
    const row = this.sessions.get(key)
    if (!row) return undefined
    const now = Date.now()
    if (now - row.lastSeen > this.ttl) {
      this.sessions.delete(key)
      this.persist()
      return undefined
    }
    // 每次请求都写盘太勤：一分钟内的活动只记内存
    if (now - row.lastSeen > 60_000) this.persist()
    row.lastSeen = now
    return row
  }

  idOf(token: string | undefined) {
    return token ? sha256(token).slice(0, 16) : ''
  }

  list(): SessionView[] {
    this.load()
    const now = Date.now()
    return [...this.sessions]
      .filter(([, r]) => now - r.lastSeen <= this.ttl)
      .map(([key, r]) => ({ id: key.slice(0, 16), ...r }))
      .sort((a, b) => b.lastSeen - a.lastSeen)
  }

  revoke(token: string | undefined) {
    if (token && this.sessions.delete(sha256(token))) this.persist()
  }

  removeById(id: string) {
    this.load()
    for (const key of this.sessions.keys())
      if (key.slice(0, 16) === id) {
        this.sessions.delete(key)
        this.persist()
        return true
      }
    return false
  }

  /** 退出所有设备；except 是要留下的令牌（在外网改密码时，改的人自己不用重新登录） */
  revokeAll(except?: string) {
    this.load()
    const keep = except ? sha256(except) : ''
    for (const key of [...this.sessions.keys()]) if (key !== keep) this.sessions.delete(key)
    this.persist()
  }
}
