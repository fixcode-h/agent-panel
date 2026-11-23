/**
 * 算出来的数据的缓存（ADR 0074）：「同一个键同时只算一遍、算失败不记、过期或依赖的文件变了才重算」只写这一份。
 * 以前每处缓存都手写一遍 Map + 时间戳（面板十几处、UE 插件九处、表格一处），各自决定在途去重、失败记不记、多久过期；
 * 只靠过期时间要么慢（改了文件要等过期才看得到）、要么勤（文档根 1 分钟过期，P4 项目每分钟重新跑 p4，2026-11-23）。
 *
 * 依赖文件时给 watch：键第一次算出来后盯这些目录树 / 文件（server/watch/，和别的订阅者共用系统监听），一变就丢掉这个键，
 * 下次取时重算。盯不了（Linux 上目录太多、网络盘）时退回 ttlMs。
 * 每个缓存登记在 memoStats() 里：设置 →「数据」看得到有哪些、各几项，能一键清空（clearMemos）
 */
import { watchFiles } from '../watch/files.ts'
import { watchTree } from '../watch/tree.ts'

export interface MemoWatch {
  /** 盯整棵目录树（任何文件变了都算） */
  trees?: string[]
  /** 只认这些扩展名的变化（小写、不带点）；不给时都算 */
  exts?: string[]
  /** 盯这几个文件的内容 */
  files?: string[]
}

export interface MemoOpts<K, V> {
  /** 登记名（设置里显示、日志里用）：<模块>.<用途>，例如 ue.class-headers */
  name: string
  load: (key: K) => Promise<V>
  keyOf?: (key: K) => string
  /** 多久后过期；不给就一直有效（直到依赖的文件变了或被清掉） */
  ttlMs?: number
  /** 最多留几项，超了丢最早的 */
  max?: number
  watch?: (key: K) => MemoWatch | undefined
}

interface Entry<V> {
  at: number
  value: Promise<V>
  stop?: () => void
}

export interface Memo<K, V> {
  /** 取：有就给记住的，没有或过期就算（同一个键同时只算一遍）。fresh 强制重算 */
  get: (key: K, o?: { fresh?: boolean }) => Promise<V>
  /** 已经算好的（不触发计算）；没有返回 undefined */
  peek: (key: K) => Promise<V> | undefined
  /** 丢掉一个键；不给键就全丢 */
  invalidate: (key?: K) => void
  size: () => number
}

interface Registered {
  name: string
  size: () => number
  clear: () => void
}
const registry = new Map<string, Registered>() // 模块状态：登记表，进程里的缓存都在这

export function memoStats() {
  return [...registry.values()].map((r) => ({ name: r.name, size: r.size() }))
}

export function clearMemos(name?: string) {
  for (const r of registry.values()) if (!name || r.name === name) r.clear()
}

const extOf = (rel: string) => {
  const base = rel.slice(rel.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

export function createMemo<K, V>(o: MemoOpts<K, V>): Memo<K, V> {
  const keyOf = o.keyOf ?? ((k: K) => String(k))
  const entries = new Map<string, Entry<V>>()

  const drop = (k: string) => {
    const e = entries.get(k)
    if (!e) return
    entries.delete(k)
    e.stop?.()
  }

  const follow = (k: string, key: K, e: Entry<V>) => {
    const w = o.watch?.(key)
    if (!w) return
    const stops: (() => void)[] = []
    const gone = () => {
      if (entries.get(k) === e) drop(k)
    }
    for (const t of w.trees ?? []) {
      const tw = watchTree(
        t,
        (rel) => {
          if (rel === null || !w.exts?.length || w.exts.includes(extOf(rel))) gone()
        },
        { onLost: gone },
      )
      if (tw) stops.push(() => tw.close())
    }
    if (w.files?.length) {
      const fw = watchFiles(w.files, gone)
      stops.push(() => fw.close())
    }
    e.stop = () => {
      for (const s of stops) s()
    }
  }

  const get = (key: K, g: { fresh?: boolean } = {}) => {
    const k = keyOf(key)
    const hit = entries.get(k)
    if (hit && !g.fresh && (!o.ttlMs || Date.now() - hit.at < o.ttlMs)) return hit.value
    drop(k)
    const e: Entry<V> = { at: Date.now(), value: o.load(key) }
    entries.set(k, e)
    if (o.max && entries.size > o.max) drop(entries.keys().next().value as string)
    e.value.then(
      () => {
        if (entries.get(k) === e) follow(k, key, e)
      },
      () => {
        // 算失败不记：下次再算
        if (entries.get(k) === e) drop(k)
      },
    )
    return e.value
  }

  const memo: Memo<K, V> = {
    get,
    peek: (key) => entries.get(keyOf(key))?.value,
    invalidate: (key) => {
      if (key === undefined) for (const k of [...entries.keys()]) drop(k)
      else drop(keyOf(key))
    },
    size: () => entries.size,
  }
  registry.set(o.name, { name: o.name, size: memo.size, clear: () => memo.invalidate() })
  return memo
}
