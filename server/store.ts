import { existsSync, mkdirSync, readdirSync, renameSync, cpSync } from 'node:fs'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'
import type { z } from 'zod'

/**
 * 用户数据目录，和 ~/.codex、~/.claude 一样放在用户目录下，升级、换安装位置都不影响：
 *
 *   ~/.agent-panel/
 *     settings.json        设置
 *     config/              Agent、Agent 分类、工作流、项目分类
 *     projects/            添加的项目
 *     tasks/               任务记录（执行过的工作流和对话）
 *     uploads/             任务里附上的文件和图片
 *     cache/               可以随时删的缓存（下载的更新包、损坏文件的备份）
 *
 * AGENT_PANEL_DATA 可以换成别的目录（测试、便携使用）。
 */
export const DATA_DIR = process.env.AGENT_PANEL_DATA ?? path.join(homedir(), '.agent-panel')
export const CACHE_DIR = path.join(DATA_DIR, 'cache')
/** Chat 模式的聊天各自的工作目录（不属于任何项目） */
export const CHATS_DIR = path.join(DATA_DIR, 'chats')
/** 节点之间交接的完整结果（太长时提示里只放开头），按任务分目录 */
export const HANDOFF_DIR = path.join(DATA_DIR, 'tasks', 'handoff')

/** 每个数据文件在数据目录里的位置；左边是旧版本平铺在 data/ 下的文件名 */
export const DATA_FILES: Record<string, string> = {
  'settings.json': 'settings.json',
  'agents.json': 'config/agents.json',
  'categories.json': 'config/categories.json',
  'tags.json': 'config/tags.json',
  'workflows.json': 'config/workflows.json',
  'project-categories.json': 'config/project-categories.json',
  'schedules.json': 'config/schedules.json',
  'projects.json': 'projects/projects.json',
  'tasks.json': 'tasks/tasks.json',
}
export const dataPath = (name: string) => path.join(DATA_DIR, DATA_FILES[name] ?? name)

/**
 * 旧版本把数据平铺在程序目录的 data/ 下。启动时搬到新结构：
 * 数据目录里的平铺文件直接移到子目录；用户目录还没有数据时，从程序目录的 data/ 复制过来（原来的不删，可以手动回退）。
 */
export function migrateDataDir() {
  mkdirSync(DATA_DIR, { recursive: true })
  const empty = !Object.values(DATA_FILES).some((f) => existsSync(path.join(DATA_DIR, f)))
  // 用 AGENT_PANEL_DATA 指定了目录的（测试、便携使用），数据本来就在那里，不从程序目录复制
  const legacy = [path.resolve('data'), path.join(path.dirname(process.argv[1] ?? '.'), 'data')].find(
    (d) => existsSync(d) && path.resolve(d) !== path.resolve(DATA_DIR),
  )
  if (empty && !process.env.AGENT_PANEL_DATA && legacy) {
    const names = readdirSync(legacy)
    if (names.some((n) => n in DATA_FILES)) {
      for (const n of names) {
        if (n in DATA_FILES) cpSync(path.join(legacy, n), dataPath(n))
        else if (n === 'uploads') cpSync(path.join(legacy, n), path.join(DATA_DIR, 'uploads'), { recursive: true })
      }
      console.log(`已把 ${legacy} 里的数据复制到 ${DATA_DIR}`)
    }
  }
  for (const [old, now] of Object.entries(DATA_FILES)) {
    const from = path.join(DATA_DIR, old)
    const to = path.join(DATA_DIR, now)
    if (old === now || !existsSync(from) || existsSync(to)) continue
    mkdirSync(path.dirname(to), { recursive: true })
    renameSync(from, to)
  }
}

/** 导入数据后让所有集合重新从文件读 */
const resets = new Set<() => void>()
export const onReset = (fn: () => void) => resets.add(fn)
export const resetCaches = () => resets.forEach((fn) => fn())

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * 原子写 JSON：先写唯一的临时文件再改名。Windows 上杀毒软件、索引服务短暂占用文件时改名会报 EPERM / EBUSY，重试几次。
 * mode：含凭据、密钥的文件传 0o600，只让当前用户读（Windows 忽略这个参数）
 */
export async function writeJsonAtomic(file: string, data: unknown, compact = false, mode?: number) {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  // compact：大文件（任务的对话）不缩进，写得快、占地方小
  const text = compact ? JSON.stringify(data) : JSON.stringify(data, null, 2)
  await writeFile(tmp, text, mode === undefined ? 'utf8' : { encoding: 'utf8', mode })
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
    // 损坏的文件放进缓存目录，设置里清理缓存时一起删掉
    const backup = path.join(CACHE_DIR, 'broken', `${path.basename(file)}.broken-${Date.now()}`)
    await mkdir(path.dirname(backup), { recursive: true }).catch(() => {})
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
export function createCollection<I extends object, T extends I & Entity>(
  file: string,
  schema: z.ZodType<T>,
  /** 必须存在的条目（例如自带的默认 Agent）：读到的数据里没有就补上，清理、导入后也一样 */
  builtin: () => T[] = () => [],
) {
  const FILE = dataPath(file)
  let cache: T[] | null = null
  /**
   * 第一次从文件读的进行中任务。启动时的后台任务（安装内置工作流、迁移旧项目）和第一个请求
   * 会同时第一次用同一个集合，必须共用这一次：各自读一遍时，后返回的那次会拿读到的旧快照覆盖 cache
   */
  let loading: Promise<void> | null = null
  /** 数据被整体替换（导入、清理）的次数：读盘期间变过，读到的就是旧内容，不能再写回缓存 */
  let generation = 0
  let writing = Promise.resolve()
  // 「读快照 → 改 → 写盘」整体串行：只串行写盘的话，两个并发的保存会各自基于旧快照写，后写的那次覆盖掉先写的改动
  let mutating: Promise<unknown> = Promise.resolve()
  onReset(() => {
    cache = null
    loading = null
    generation++
  })

  function mutate<R>(fn: () => Promise<R>): Promise<R> {
    const run = mutating.catch(() => {}).then(fn)
    mutating = run
    return run
  }

  async function load(gen: number): Promise<void> {
    const raw = await readJson(FILE)
    // 读盘期间数据被整体替换过：这次读到的是替换前的内容，作废
    if (gen !== generation) return
    // 读盘期间已经有 create / update 写进 cache：以内存里的为准。
    // 覆盖回去会丢掉刚创建的项目（表现为 POST /tasks 报 404「项目不存在」），任务记录也一样
    if (cache) return
    const items = Array.isArray(raw) ? raw.map((r) => schema.parse(r)) : []
    const missing = builtin().filter((b) => !items.some((x) => x.id === b.id))
    cache = [...missing, ...items]
    if (missing.length) void persist(cache)
  }

  async function list(): Promise<T[]> {
    if (!cache) {
      if (!loading) {
        const p = load(generation).finally(() => {
          if (loading === p) loading = null
        })
        loading = p
      }
      await loading
    }
    return cache!
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
    create(input: I) {
      return mutate(async () => {
        const now = new Date().toISOString()
        const item = { ...input, id: randomUUID(), createdAt: now, updatedAt: now } as unknown as T
        await persist([...(await list()), item])
        return item
      })
    },
    update(id: string, input: I) {
      return mutate(async () => {
        const items = await list()
        const old = items.find((x) => x.id === id)
        if (!old) return null
        const item = { ...old, ...input, id, updatedAt: new Date().toISOString() } as T
        await persist(items.map((x) => (x.id === id ? item : x)))
        return item
      })
    },
    remove(id: string) {
      return mutate(async () => {
        const items = await list()
        if (!items.some((x) => x.id === id)) return false
        await persist(items.filter((x) => x.id !== id))
        return true
      })
    },
    /** 整体替换：重排这类操作要一次写成，不会出现只改了一半的顺序 */
    setAll(items: T[]) {
      return mutate(() => persist(items))
    },
  }
}
