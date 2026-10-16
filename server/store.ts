import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { z } from 'zod'

export const DATA_DIR = process.env.AGENT_PANEL_DATA ?? path.resolve('data')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * 原子写 JSON：先写唯一的临时文件再改名。Windows 上杀毒软件、索引服务短暂占用文件时改名会报 EPERM / EBUSY，重试几次。
 */
export async function writeJsonAtomic(file: string, data: unknown) {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  for (let i = 0; ; i++) {
    try {
      return await rename(tmp, file)
    } catch (err: any) {
      if (i >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(err?.code)) {
        await unlink(tmp).catch(() => {})
        throw err
      }
      await sleep(50 * 2 ** i)
    }
  }
}

/** 读 JSON 文件；文件损坏时改名备份，当作不存在，不让整个服务起不来 */
export async function readJson(file: string): Promise<unknown | undefined> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (err: any) {
    if (err?.code === 'ENOENT') return undefined
    throw err
  }
  try {
    return JSON.parse(text)
  } catch {
    const backup = `${file}.broken-${Date.now()}`
    await rename(file, backup).catch(() => {})
    console.error(`数据文件损坏，已备份为 ${backup}，按空数据处理`)
    return undefined
  }
}

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
    const raw = await readJson(FILE)
    cache = Array.isArray(raw) ? raw.map((r) => schema.parse(r)) : []
    return cache
  }

  function persist(items: T[]) {
    cache = items
    // 前一次写失败不能拖垮后面的写入：每次都接在「无论成败」之后
    const next = writing.catch(() => {}).then(() => writeJsonAtomic(FILE, items))
    writing = next
    return next
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
