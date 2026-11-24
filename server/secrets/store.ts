import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { DATA_DIR, writeJsonAtomic } from '../store.ts'

/**
 * 本机保密项（令牌、密钥）：加密存在数据目录 secrets/ 下，不进 settings.json。
 *
 * 为什么不直接放设置里：settings.json 是明文，Agent 在终端里 cat 一下就能拿到令牌，绕开插件的权限闸直接调外部接口；
 * 设置还会被导出备份、贴给别人排查。这里按命名空间（插件是 plugin:<id>）存，AES-256-GCM 加密，
 * 密钥在同目录的 key 文件（只给本机用户读写）。挡的是「顺手读到」和「跟着备份出去」，挡不住专门来解密的本机进程。
 * 数据导出的 PATHS 里没有 secrets/，备份不会带走（server/data.ts）。
 */

const DIR = path.join(DATA_DIR, 'secrets')
const KEY_FILE = path.join(DIR, 'key')
const FILE = path.join(DIR, 'store.json')

type Box = { iv: string; tag: string; data: string }
type Store = Record<string, Record<string, Box>>

// 模块状态：缓存，丢了没事（下次从 key 文件读回）
let keyCache: Buffer | undefined
async function key() {
  if (keyCache) return keyCache
  await mkdir(DIR, { recursive: true, mode: 0o700 })
  const old = await readFile(KEY_FILE).catch(() => undefined)
  if (old?.length === 32) return (keyCache = old)
  const k = randomBytes(32)
  await writeFile(KEY_FILE, k, { mode: 0o600 })
  await chmod(KEY_FILE, 0o600).catch(() => {})
  return (keyCache = k)
}

const load = async (): Promise<Store> => JSON.parse(await readFile(FILE, 'utf8').catch(() => '{}')) as Store

// 同一进程里的写入排队：两次 set 同时读改写会丢一次
// 模块状态：运行时，只管本进程的写入顺序，重启后从空队列开始
let queue: Promise<unknown> = Promise.resolve()
const serial = <T>(fn: () => Promise<T>) => {
  const p = queue.then(fn, fn)
  queue = p.catch(() => {})
  return p
}

async function seal(value: string): Promise<Box> {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', await key(), iv)
  const data = Buffer.concat([c.update(value, 'utf8'), c.final()])
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') }
}

async function open(b: Box) {
  const d = createDecipheriv('aes-256-gcm', await key(), Buffer.from(b.iv, 'base64'))
  d.setAuthTag(Buffer.from(b.tag, 'base64'))
  return Buffer.concat([d.update(Buffer.from(b.data, 'base64')), d.final()]).toString('utf8')
}

/** 读一项；没有、或密钥换过解不开时返回空串（解不开等于没设置，让用户重填，不抛错卡住插件） */
export async function getSecret(ns: string, name: string): Promise<string> {
  const b = (await load())[ns]?.[name]
  if (!b) return ''
  return open(b).catch(() => '')
}

/** 写一项；value 为空串时删掉 */
export function setSecret(ns: string, name: string, value: string) {
  return serial(async () => {
    const s = await load()
    const cur = { ...s[ns] }
    if (value) cur[name] = await seal(value)
    else delete cur[name]
    if (Object.keys(cur).length) s[ns] = cur
    else delete s[ns]
    await writeJsonAtomic(FILE, s, false, 0o600)
  })
}

/** 界面上显示用：只给「设没设」和末 4 位，原文不出服务端 */
export async function secretHints(ns: string): Promise<Record<string, { tail: string }>> {
  const s = (await load())[ns] ?? {}
  const out: Record<string, { tail: string }> = {}
  for (const [k, b] of Object.entries(s)) {
    const v = await open(b).catch(() => '')
    if (v) out[k] = { tail: v.length > 8 ? v.slice(-4) : '' }
  }
  return out
}

/** 删掉一个命名空间（删除插件时） */
export function dropSecrets(ns: string) {
  return serial(async () => {
    const s = await load()
    if (!(ns in s)) return
    delete s[ns]
    await writeJsonAtomic(FILE, s, false, 0o600)
  })
}
