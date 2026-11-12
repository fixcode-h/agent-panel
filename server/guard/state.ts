import { readFileSync } from 'node:fs'
import path from 'node:path'
import { DATA_DIR, writeJsonAtomic } from '../store.ts'
import { getSettings } from '../settings.ts'
import { hashPassword, randomPassword, verifyPassword } from './password.ts'
import { SessionStore } from './sessions.ts'

/**
 * 外网访问的密码和会话。都放数据目录、不进 settings.json：「导出数据」不会把它们带出去，
 * 和访问令牌（access-token）一样只属于这台电脑。
 */
const FILE = path.join(DATA_DIR, 'guard.json')

interface GuardFile {
  /** scrypt 哈希，见 password.ts */
  passwordHash: string
  /**
   * 面板自动生成的初始密码明文：只在本机设置页显示（托盘用户看不到终端，只打一行日志会找不到）。
   * 用户改过密码后清空；文件权限 0600，和 access-token 同一级别
   */
  initialPassword: string
}

let cache: GuardFile | null = null // 模块状态：缓存，丢了重算

function read(): GuardFile {
  if (cache) return cache
  try {
    const d = JSON.parse(readFileSync(FILE, 'utf8')) as Partial<GuardFile>
    cache = { passwordHash: String(d.passwordHash ?? ''), initialPassword: String(d.initialPassword ?? '') }
  } catch {
    cache = { passwordHash: '', initialPassword: '' }
  }
  return cache
}

async function write(next: GuardFile) {
  cache = next
  await writeJsonAtomic(FILE, next, false, 0o600)
}

export const sessions = new SessionStore(path.join(DATA_DIR, 'guard-sessions.json'))

/** 会话有效期、锁定次数和时长跟着设置走，改了马上生效 */
export async function syncLimits() {
  const r = (await getSettings()).remoteAccess
  sessions.limits = { sessionDays: r.sessionDays, maxAttempts: r.maxAttempts, lockMinutes: r.lockMinutes }
}

export const hasPassword = () => !!read().passwordHash

/** 打开外网访问时调用：还没有密码就生成一个 */
export async function ensurePassword() {
  if (hasPassword()) return
  const pw = randomPassword()
  await write({ passwordHash: hashPassword(pw), initialPassword: pw })
}

export const checkPassword = (pw: string) => verifyPassword(pw, read().passwordHash)

export const initialPassword = () => read().initialPassword

export async function setPassword(pw: string) {
  await write({ passwordHash: hashPassword(pw), initialPassword: '' })
}

/** 测试用：换数据目录后清掉缓存 */
export const resetGuardCache = () => {
  cache = null
}
