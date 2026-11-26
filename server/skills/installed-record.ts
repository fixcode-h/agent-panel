/**
 * 面板往 ~/.agents/skills 装自带技能时记下装进去的那份长什么样（每个技能一条：目录里全部文件的指纹），
 * 存在 config/bundled-skills-installed.json。
 *
 * 为什么：自带技能更新后，已装的副本以前只能在「自带 Skill」页手动点更新，因为分不清「旧版」和「用户改过」（2026-11-26
 * 用户改了 lua-code-style 的日志标签规则，本机副本还是旧的）。有了这条记录，副本和面板当初装进去的一模一样就是没人动过，
 * 可以直接换成新版；对不上（用户改过）的照旧不动，等用户自己点更新。
 * 这条记录出现之前装的副本没有记录，第一次还要手动更新一次（或者它恰好和这一版一样，就从这里开始记）
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { dataPath, writeJsonAtomic } from '../store.ts'

const FILE = () => dataPath('config/bundled-skills-installed.json')
const InstalledRecord = z.record(z.string(), z.string())

let cache: Record<string, string> | null = null // 模块状态：配置副本，改的时候和磁盘一起更新，重启时重读

function load(): Record<string, string> {
  if (cache) return cache
  let raw: unknown = {}
  try {
    raw = JSON.parse(readFileSync(FILE(), 'utf8'))
  } catch {
    // 没有文件（还没记过）或者坏了：当全都没记过，最多是这次不自动更新
  }
  const p = InstalledRecord.safeParse(raw)
  cache = p.success ? p.data : {}
  return cache
}

/** 一个技能目录的指纹：按相对路径排序后，路径和内容一起算 sha256；多一个、少一个文件都会变 */
export function treeHash(files: Iterable<[string, Buffer]>) {
  const h = createHash('sha256')
  for (const [rel, buf] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    h.update(rel).update('\0').update(createHash('sha256').update(buf).digest('hex')).update('\n')
  }
  return h.digest('hex')
}

/** 面板装进去的那份的指纹；没记过为空串 */
export const installedHash = (name: string) => load()[name] ?? ''

export async function recordInstalled(name: string, hash: string) {
  const cur = load()
  if (cur[name] === hash) return
  const next = { ...cur, [name]: hash }
  await writeJsonAtomic(FILE(), next)
  cache = next
}

/** 测试用：换了数据目录后丢掉缓存 */
export function resetInstalledRecordCache() {
  cache = null
}
