/**
 * 推技能时读正文（ADR 0083）：自带技能读面板数据目录里装的那份（用户在那里改过就推用户改的），没装的先装上；
 * 插件技能读插件包里的文件。子文件只列名字和目录，正文里写了什么时候读哪个。
 *
 * 读过的放进派生缓存（ADR 0074），一分钟后重读：一个对话里同一技能只推一次，缓存只是省掉并发对话重复读盘
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { skillBodyOf } from '../../shared/skills/push-text.ts'
import { bundledStore, ensureBundled, entries, readTree, writeSkill } from '../bundled-skills.ts'
import { createMemo } from '../memo/index.ts'
import { CACHE_DIR } from '../store.ts'

export interface SkillBody {
  name: string
  /** 技能目录：子文件在它下面 */
  dir: string
  /** SKILL.md 去掉 frontmatter 的正文 */
  body: string
  /** SKILL.md 以外的文件（相对技能目录） */
  files: string[]
}

async function fromDir(name: string, dir: string): Promise<SkillBody | null> {
  const tree = await readTree(dir)
  const md = tree.find(([rel]) => rel === 'SKILL.md')
  if (!md) return null
  return {
    name,
    dir: dir.replaceAll('\\', '/'),
    body: skillBodyOf(md[1].toString('utf8')),
    files: tree.map(([rel]) => rel).filter((rel) => rel !== 'SKILL.md'),
  }
}

async function load(name: string): Promise<SkillBody | null> {
  const e = (await entries()).find((x) => x.name === name)
  if (!e) return null
  // 插件技能：插件包里那份就是最新的
  if (e.plugin && e.dir) return fromDir(name, e.dir)
  const store = path.join(bundledStore(), name)
  if (!existsSync(path.join(store, 'SKILL.md'))) await ensureBundled([name])
  if (existsSync(path.join(store, 'SKILL.md'))) return fromDir(name, store)
  // 按项目的自带技能不进数据目录（每轮只给打开了它的项目带）：推的时候放一份在缓存目录，子文件也读得到
  const cache = path.join(CACHE_DIR, 'skill-push', name)
  if (!existsSync(path.join(cache, 'SKILL.md'))) await writeSkill(e, path.dirname(cache))
  return fromDir(name, cache)
}

const bodies = createMemo<string, SkillBody | null>({ name: 'skills.push-body', load, ttlMs: 60_000 })

/** 这个技能的正文；不是面板认得的技能（自带的、开着的插件的）时为空 */
export const skillBody = (name: string) => bodies.get(name)
