import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { versionSnapshot, type Design, type DesignVersion, type DesignVersionMeta } from '../shared/design.ts'
import { walk } from '../shared/umg.ts'
import { readJson, writeJsonAtomic } from './store.ts'

/** 自动存的版本最多留这么多，手动存的最多 50 个 */
export const MAX_AUTO_VERSIONS = 20
export const MAX_VERSIONS = 50

export const versionMeta = ({ snapshot, ...rest }: DesignVersion): DesignVersionMeta => {
  let widgets = 0
  for (const r of [snapshot.root, ...snapshot.components.map((c) => c.Root)]) walk(r, () => widgets++)
  return { ...rest, widgets }
}

/**
 * 设计版本的存取（每个设计一个 versions.json）。
 * 写入都是「读整份 → 改 → 写回」，同一个设计的写入必须串行：用户手动存版本和 AI 开轮自动存版本
 * 会同时发生，不串行的话后写的那份不含先写的那条，版本就悄悄丢了。
 */
export function versionStore(fileOf: (id: string) => string, now = () => new Date().toISOString()) {
  const chains = new Map<string, Promise<unknown>>()
  function serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = chains.get(id) ?? Promise.resolve()
    // 上一个写失败不影响下一个：错误由上一个调用方自己收到
    const next = prev.catch(() => {}).then(fn)
    chains.set(id, next)
    // 链尾是自己时清掉，免得 Map 越攒越多
    void next.finally(() => chains.get(id) === next && chains.delete(id)).catch(() => {})
    return next
  }
  async function read(id: string): Promise<DesignVersion[]> {
    const raw = await readJson(fileOf(id))
    return Array.isArray(raw) ? (raw as DesignVersion[]) : []
  }
  async function write(id: string, list: DesignVersion[]) {
    await mkdir(path.dirname(fileOf(id)), { recursive: true })
    await writeJsonAtomic(fileOf(id), list)
  }
  return {
    read,
    /** 存一个版本（最新的在最前面）；自动存的超过上限时删掉最老的自动版本 */
    add(d: Design, name: string, auto: boolean) {
      // 快照在调用时就拍下：排队等写入期间设计可能已经被改了
      const v: DesignVersion = { id: randomUUID(), name, at: now(), auto, snapshot: versionSnapshot(d) }
      return serial(d.id, async () => {
        let list = [v, ...(await read(d.id))]
        const autos = list.filter((x) => x.auto)
        if (autos.length > MAX_AUTO_VERSIONS) {
          const drop = new Set(autos.slice(MAX_AUTO_VERSIONS).map((x) => x.id))
          list = list.filter((x) => !drop.has(x.id))
        }
        await write(d.id, list.slice(0, MAX_VERSIONS + MAX_AUTO_VERSIONS))
        return v
      })
    },
    remove(id: string, vid: string) {
      return serial(id, async () =>
        write(
          id,
          (await read(id)).filter((x) => x.id !== vid),
        ),
      )
    },
  }
}
