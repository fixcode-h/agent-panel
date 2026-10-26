import { existsSync, mkdirSync, readdirSync, renameSync, cpSync } from 'node:fs'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
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
 * rename 之后刷新父目录，让目录项本身也落盘。
 * Windows 上打不开目录句柄（EPERM / EACCES / EBADF / EISDIR），做不到就跳过：
 * 数据已经在上一步 fsync 过，目录项丢失最坏是回到上一个版本的文件，不会出现内容全 0 的空洞文件。
 */
async function fsyncDir(dir: string) {
  if (process.platform === 'win32') return
  let fh
  try {
    fh = await open(dir, 'r')
    await fh.sync()
  } catch {
    // 有些文件系统（部分网络盘、容器挂载）不支持对目录 fsync，跳过
  } finally {
    await fh?.close().catch(() => {})
  }
}

/**
 * 原子写 JSON：先写唯一的临时文件、刷盘，再改名。
 * Windows 上杀毒软件、索引服务短暂占用文件时改名会报 EPERM / EBUSY，重试几次。
 * mode：含凭据、密钥的文件传 0o600，只让当前用户读（Windows 忽略这个参数）
 *
 * 每次都 fsync 临时文件，只有「rename 之后还要不要刷目录」按平台区分：
 * - fsync 不能省：省掉它就会出现「rename 生效了但数据没落盘」这个具体失败模式（重启后读到全 0 的文件）。
 * - 写性能上，消息文件有 task-store 的 400ms 合并窗口挡在前面，每秒最多几次，fsync 的代价被摊掉了。
 */
export async function writeJsonAtomic(file: string, data: unknown, compact = false, mode?: number) {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  // compact：大文件（任务的对话）不缩进，写得快、占地方小
  const text = compact ? JSON.stringify(data) : JSON.stringify(data, null, 2)
  // 同一个句柄写完直接 sync：数据落盘之后再 rename。rename 是原子的，但它只保证「名字换代」，
  // 不保证数据已经在盘上。刷不下去就抛出去（不 rename）：留着旧文件比换成一个可能全 0 的新文件安全
  const fh = await open(tmp, 'w', mode)
  try {
    await fh.writeFile(text, 'utf8')
    await fh.sync()
  } catch (err) {
    await fh.close().catch(() => {})
    await unlink(tmp).catch(() => {})
    throw err
  }
  // close 也放在保护里：fsync 成功但 close 失败时不能把 tmp 留下来（那一份之后没人清）
  try {
    await fh.close()
  } catch (err) {
    await unlink(tmp).catch(() => {})
    throw err
  }
  for (let i = 0; ; i++) {
    try {
      await rename(tmp, file)
      break
    } catch (err: any) {
      if (i >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(err?.code)) {
        await unlink(tmp).catch(() => {})
        throw err
      }
      await sleep(50 * 2 ** i)
    }
  }
  await fsyncDir(path.dirname(file))
}

/** 读 JSON 时文件坏了的说明 */
export type BrokenJson = {
  /** 原来的路径 */
  file: string
  /** 挪到缓存目录后的路径（留档） */
  backup: string
  /** 真的挪走并留档了没有：挪不动（文件被占用等）时为 false，文件还在原地，下次启动还会再试 */
  archived: boolean
  /** 为什么判成坏的（JSON 解析错误） */
  reason: string
  /** 坏文件原来的字节数：全 0 的空洞文件能从这里看出来 */
  size: number
}

/** 读 JSON 的结果：没有文件、正常读到、存在但坏了三种情况分开 */
export type JsonResult =
  | { state: 'missing'; value: undefined }
  | { state: 'ok'; value: unknown }
  | { state: 'broken'; value: undefined; broken: BrokenJson }

/**
 * 缓存目录里可用的备份路径：`<原文件名>.broken-<时间戳>` 已经存在时往后加序号。
 * 同一毫秒里归档同一个文件名两次时，不加序号就会 rename 到已有备份上（失败），也看不出先后。
 */
async function freeBackupPath(dir: string, name: string, stamp: number) {
  for (let i = 1; ; i++) {
    const backup = path.join(dir, i === 1 ? `${name}.broken-${stamp}` : `${name}.broken-${stamp}-${i}`)
    if (!existsSync(backup) && !existsSync(`${backup}.broken.json`)) return backup
  }
}

/**
 * 把损坏的文件挪进缓存目录留档，并写一份同名的 `.broken.json` 说明（原路径、时间、原因、字节数）。
 * 只挪不改：坏文件的原始字节原样保留，需要时能手工恢复。
 *
 * 反序列化过了、但内容根本用不了的（例如不是一个消息数组）也走这里：先留档再报，
 * 不然每次启动都要重读一遍同一个用不了的文件。
 *
 * 挪不动时（文件被别的进程占着）返回 `archived: false` 并把真实原因打进日志：
 * 不能让调用方以为已经留档、文件却还在原处，那一处下次启动还会被当成坏文件再处理一遍。
 *
 * 时间戳可以注入，只给测试用：要验证「同一毫秒里归档两次不撞名」，靠真实时钟碰运气不算验证。
 */
export async function archiveBrokenFile(
  file: string,
  reason: string,
  size: number,
  stamp = Date.now(),
): Promise<BrokenJson> {
  const dir = path.join(CACHE_DIR, 'broken')
  await mkdir(dir, { recursive: true }).catch(() => {})
  const backup = await freeBackupPath(dir, path.basename(file), stamp)
  let archived = true
  try {
    await rename(file, backup)
  } catch (err) {
    archived = false
    console.error(`损坏的数据文件没能挪进缓存目录（下次启动会再处理一遍）：${file}：${String(err)}`)
  }
  const broken: BrokenJson = { file, backup, archived, reason, size }
  if (!archived) return broken
  // 说明文件跟着备份一起放在缓存目录：清理缓存时会一起删掉，不会留在数据目录里
  await writeJsonAtomic(`${backup}.broken.json`, { ...broken, at: new Date().toISOString(), stamp }).catch(() => {})
  return broken
}

/**
 * 读 JSON 文件。文件损坏时挪进缓存目录留档，并告诉调用方「这里原本有个文件、它坏了」。
 *
 * 以前这里直接 return undefined，上层拿不到这个信号：任何一个「文件没了 = 这份数据不存在」的判断
 * 都会把损坏当成不存在（任务从列表里静默消失就是这个原因）。需要区分的时候用这个函数。
 */
export async function readJsonDetailed(file: string): Promise<JsonResult> {
  let buf: Buffer
  try {
    // 按字节读：坏文件要记的 size 是真实字节数（全 0 的空洞文件长度和原文件对得上，靠它认出来）
    buf = await readFile(file)
  } catch (err: any) {
    if (err?.code === 'ENOENT') return { state: 'missing', value: undefined }
    throw err
  }
  const text = buf.toString('utf8')
  try {
    return { state: 'ok', value: JSON.parse(text) }
  } catch (err: any) {
    const broken = await archiveBrokenFile(file, String(err?.message ?? err), buf.length)
    console.error(
      broken.archived
        ? `数据文件损坏，已备份为 ${broken.backup}（${broken.size} 字节）：${file}`
        : `数据文件损坏，读不出来（${broken.size} 字节）：${file}`,
    )
    return { state: 'broken', value: undefined, broken }
  }
}

/** 读 JSON 文件；文件损坏时改名备份，当作不存在，不让整个服务起不来 */
export async function readJson(file: string): Promise<unknown | undefined> {
  return (await readJsonDetailed(file)).value
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
