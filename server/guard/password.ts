/**
 * 外网访问的密码：scrypt 哈希、核对、随机生成。
 *
 * 做法参考 dsh-web-guard（https://github.com/lvxianchao/dsh-web-guard，MIT，Copyright (c) 2026 lvxianchao）的 src/auth.ts：
 * 存成 `scrypt$N$r$p$salt$key` 一行字符串，核对用固定时间比较，按响应时间猜不出密码。
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

const N = 16384
const R = 8
const P = 1
const KEYLEN = 32
// 默认 32 MB 上限对 N=16384、r=8 刚好不够，放宽到 64 MB
const MAXMEM = 64 * 1024 * 1024

/** 密码最短长度：外网能直接试密码，短于 8 位靠锁定也挡不了多久 */
export const MIN_PASSWORD = 8

export function hashPassword(password: string, salt: Buffer = randomBytes(16)): string {
  const key = scryptSync(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM })
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`
}

/** 核对密码；哈希格式不对一律不通过（不会把坏数据当成「没设密码」放行） */
export function verifyPassword(password: string, stored: string): boolean {
  if (typeof password !== 'string' || !password || typeof stored !== 'string') return false
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, n, r, p, salt, key] = parts
  const expected = Buffer.from(key, 'base64')
  if (!expected.length || ![n, r, p].every((x) => /^\d+$/.test(x))) return false
  try {
    const actual = scryptSync(password, Buffer.from(salt, 'base64'), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: MAXMEM,
    })
    return timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

/** 自动生成的初始密码：xxxx-xxxx-xxxx-xxxx，去掉了容易看错的 0/o、1/l/i，约 79 位熵 */
export function randomPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'
  const bytes = randomBytes(16)
  let out = ''
  for (let i = 0; i < 16; i++) out += alphabet[bytes[i] % alphabet.length]
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}`
}
