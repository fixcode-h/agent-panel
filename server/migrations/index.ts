import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { DATA_DIR, readJson, writeJsonAtomic } from '../store.ts'
import { taskLayout } from './0001-task-layout.ts'
import { taskMetaCleanup } from './0002-task-meta-cleanup.ts'
import { messagesJsonl } from './0003-messages-jsonl.ts'
import { taskBug } from './0004-task-bug.ts'
import { projectTables } from './0005-project-tables.ts'

/**
 * 数据目录的一次性迁移（重构文档第 6 条，ADR 见 docs/adr）。
 *
 * 数据目录里的 `data-version.json` 记着数据已经是第几版。启动时（拿到单实例锁之后、读任何数据之前）
 * 按版本号依次跑还没跑过的迁移，每跑完一个就把版本号写回去；迁移过的数据之后读的时候不用再转换。
 *
 * 规矩：
 * - 迁移按 `NNNN-名字.ts` 放在这个目录，在下面的 MIGRATIONS 里按顺序登记，版本号只增不改。
 * - 每个迁移必须幂等：跑到一半失败（文件被占用、断电）下次启动从头再跑一遍这个版本，导入旧备份后也会从 0 重跑一遍。
 * - 改任何文件之前先 `ctx.backup(file)`（整份复制）或 `ctx.moveToBackup(file)`（挪走原文件），
 *   备份在 `backup/<NNNN>-<名字>/` 下、保持原来的相对路径。只留最近 BACKUP_KEEP 个版本的备份。
 * - 只保留最近 MIGRATIONS_KEEP 个迁移：更老的删掉后，数据还停在更早版本的安装拒绝直接升级，
 *   提示先装一个中间版本（见 runMigrations 的 tooOld）。
 */
export interface MigrationCtx {
  dataDir: string
  /** 改一个文件之前把原样复制一份到这个版本的备份目录（同一个文件只备份第一次的样子） */
  backup(file: string): Promise<void>
  /** 把原文件整个挪进备份目录（转换成新文件后旧文件就不要了时用，不占双份空间） */
  moveToBackup(file: string): Promise<void>
  /** 写进启动日志 */
  log(msg: string): void
}

export interface Migration {
  version: number
  name: string
  run(ctx: MigrationCtx): Promise<void>
}

export const MIGRATIONS: Migration[] = [taskLayout, taskMetaCleanup, messagesJsonl, taskBug, projectTables]
/** 当前代码认识的数据版本 */
export const DATA_VERSION = MIGRATIONS.at(-1)!.version
/** 最多保留多少个迁移（超过就删最老的，见上面的规矩）；只是约定，lint 不拦 */
export const MIGRATIONS_KEEP = 20
/** 备份目录只留最近几个版本的 */
const BACKUP_KEEP = 3

const VERSION_FILE = 'data-version.json'
export const BACKUP_ROOT = 'backup'

type VersionFile = { version: number; history: { version: number; name: string; at: string }[] }

export async function readDataVersion(dataDir = DATA_DIR): Promise<VersionFile> {
  const raw = (await readJson(path.join(dataDir, VERSION_FILE))) as Partial<VersionFile> | undefined
  // 没有这个文件：早于版本号的安装（或者新装），从 0 开始跑；迁移幂等，新装时什么都不会改
  const version = typeof raw?.version === 'number' && raw.version >= 0 ? Math.floor(raw.version) : 0
  return { version, history: Array.isArray(raw?.history) ? raw.history : [] }
}

export type MigrationResult = {
  from: number
  to: number
  ran: string[]
  /** 数据是更新版本写的（降级了）：没动任何东西 */
  newer?: boolean
  /** 数据版本太老，这一版已经没有能接上的迁移：调用方应该拒绝启动 */
  tooOld?: boolean
  /** 哪个迁移失败了：版本号停在它之前，下次启动再试 */
  failed?: { version: number; name: string; error: string }
}

const pad = (n: number) => String(n).padStart(4, '0')

/**
 * 依次跑还没跑过的迁移。from 给了就从这个版本重跑（导入旧备份后传 0）。
 * 一个迁移失败就停下、不再跑后面的，版本号停在它之前；不抛错：读数据的地方对没迁完的旧格式还有兜底，
 * 面板照样能起来，下次启动再试
 */
export async function runMigrations(
  opts: { dataDir?: string; from?: number; migrations?: Migration[]; log?: (msg: string) => void } = {},
): Promise<MigrationResult> {
  const dataDir = opts.dataDir ?? DATA_DIR
  const list = opts.migrations ?? MIGRATIONS
  const say = opts.log ?? ((msg: string) => console.log(msg))
  const latest = list.at(-1)?.version ?? 0
  const file = await readDataVersion(dataDir)
  const from = opts.from ?? file.version
  const res: MigrationResult = { from, to: from, ran: [] }
  if (from > latest) {
    console.error(
      `数据目录 ${dataDir} 是更新版本的面板写的（数据版本 ${from}，这个版本只认识到 ${latest}）：不做迁移。` +
        '旧版本读新格式可能看不到部分对话，建议升级回新版本',
    )
    return { ...res, newer: true }
  }
  const oldest = list[0]?.version ?? 1
  if (from < oldest - 1) return { ...res, tooOld: true }
  for (const m of list) {
    if (m.version <= from) continue
    const dir = path.join(dataDir, BACKUP_ROOT, `${pad(m.version)}-${m.name}`)
    const rel = (f: string) => path.relative(dataDir, f)
    const ctx: MigrationCtx = {
      dataDir,
      async backup(f) {
        const dest = path.join(dir, rel(f))
        if (existsSync(dest) || !existsSync(f)) return
        await mkdir(path.dirname(dest), { recursive: true })
        await copyFile(f, dest)
      },
      async moveToBackup(f) {
        if (!existsSync(f)) return
        let dest = path.join(dir, rel(f))
        // 同一个文件挪过一次了（导入旧备份后又出现）：换个名字，不能盖掉第一次的备份
        for (let i = 2; existsSync(dest); i++) dest = path.join(dir, `${rel(f)}.${i}`)
        await mkdir(path.dirname(dest), { recursive: true })
        await rename(f, dest)
      },
      log: (msg) => say(`[数据迁移 ${pad(m.version)}] ${msg}`),
    }
    try {
      await m.run(ctx)
    } catch (e) {
      const error = String((e as Error)?.message ?? e)
      console.error(`数据迁移 ${pad(m.version)}-${m.name} 失败，停在版本 ${res.to}，下次启动再试：${error}`)
      return { ...res, failed: { version: m.version, name: m.name, error } }
    }
    file.version = m.version
    file.history.push({ version: m.version, name: m.name, at: new Date().toISOString() })
    await writeJsonAtomic(path.join(dataDir, VERSION_FILE), file)
    res.to = m.version
    res.ran.push(`${pad(m.version)}-${m.name}`)
  }
  if (res.ran.length) await pruneBackups(dataDir)
  return res
}

/** 备份目录只留最近 BACKUP_KEEP 个版本的（目录名开头是版本号） */
async function pruneBackups(dataDir: string) {
  const root = path.join(dataDir, BACKUP_ROOT)
  const dirs = (await readdir(root).catch(() => [] as string[])).filter((d) => /^\d{4}-/.test(d)).sort()
  for (const d of dirs.slice(0, Math.max(0, dirs.length - BACKUP_KEEP)))
    await rm(path.join(root, d), { recursive: true, force: true }).catch(() => {})
}
