import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { z } from 'zod'

const DATA_DIR = process.env.AGENT_PANEL_DATA ?? path.resolve('data')

type Entity = { id: string; createdAt: string; updatedAt: string }

/**
 * 一个 JSON 文件就是一个集合。读一次后缓存在内存里，
 * 写入串行化并先写临时文件再改名，避免并发写坏文件。
 */
export function createCollection<I extends object, T extends I & Entity>(file: string, schema: z.ZodType<T>) {
  const FILE = path.join(DATA_DIR, file)
  let cache: T[] | null = null
  let writing = Promise.resolve()

  async function list(): Promise<T[]> {
    if (cache) return cache
    try {
      const raw = JSON.parse(await readFile(FILE, 'utf8'))
      cache = (raw as unknown[]).map((r) => schema.parse(r))
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err
      cache = []
    }
    return cache
  }

  function persist(items: T[]) {
    cache = items
    writing = writing.then(async () => {
      await mkdir(DATA_DIR, { recursive: true })
      const tmp = `${FILE}.${process.pid}.tmp`
      await writeFile(tmp, JSON.stringify(items, null, 2), 'utf8')
      await rename(tmp, FILE)
    })
    return writing
  }

  return {
    list,
    async get(id: string) {
      return (await list()).find((x) => x.id === id) ?? null
    },
    async create(input: I) {
      const now = new Date().toISOString()
      const item = { ...input, id: randomUUID(), createdAt: now, updatedAt: now } as unknown as T
      await persist([...(await list()), item])
      return item
    },
    async update(id: string, input: I) {
      const items = await list()
      const old = items.find((x) => x.id === id)
      if (!old) return null
      const item = { ...old, ...input, id, updatedAt: new Date().toISOString() } as T
      await persist(items.map((x) => (x.id === id ? item : x)))
      return item
    },
    async remove(id: string) {
      const items = await list()
      if (!items.some((x) => x.id === id)) return false
      await persist(items.filter((x) => x.id !== id))
      return true
    },
  }
}
