import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { DATA_FILES, readJson, writeJsonAtomic } from '../store.ts'
import type { Migration } from './index.ts'

/**
 * 项目教训、经验默认改回随仓库存（用户 2026-11-20 定：默认写进项目 docs，设置里可以切到面板数据目录）。
 * schema 的默认值从 false 改成 true 之后，没写这一项的旧项目会被读成「随仓库」，原来存在数据目录里的教训、经验就读不到了，
 * 所以这里给每个项目写上明确的值：
 * - 数据目录 knowledge/<项目 id>/ 里已经有教训或经验的，记 false，照旧读写那一份（不在升级时悄悄往用户仓库里搬文件）；
 * - 数据目录里什么都没有的（新项目、从没记过的），记 true，按新的默认存仓库。
 * 已经是 true 的不动。重复跑时已经写了明确值的项目只会按同样的规则得到同样的结果
 */
async function hasMd(dir: string) {
  if (!existsSync(dir)) return false
  const names = await readdir(dir).catch(() => [] as string[])
  return names.some((n) => n.endsWith('.md') && n !== 'README.md')
}

/** 和 server/projects/knowledge-place.ts 的 dataKnowledgeDir 同一个规则；迁移不引运行时模块，免得以后改了那边影响旧迁移 */
const knowledgeDir = (dataDir: string, id: string) =>
  path.join(dataDir, 'knowledge', id.replace(/[^A-Za-z0-9_-]/g, '_'))

export async function hasDataKnowledge(dataDir: string, id: string) {
  const base = knowledgeDir(dataDir, id)
  return (await hasMd(path.join(base, 'lessons'))) || (await hasMd(path.join(base, 'experience')))
}

export const knowledgeInRepoDefault: Migration = {
  version: 13,
  name: 'knowledge-in-repo-default',
  async run(ctx) {
    const file = path.join(ctx.dataDir, DATA_FILES['projects.json'])
    const list = (await readJson(file).catch(() => undefined)) as Record<string, unknown>[] | undefined
    if (!Array.isArray(list)) return
    const next: [Record<string, unknown>, boolean][] = []
    for (const p of list) {
      if (!p || typeof p !== 'object' || p.knowledgeInRepo === true) continue
      const id = typeof p.id === 'string' ? p.id : ''
      const keep = !!id && (await hasDataKnowledge(ctx.dataDir, id))
      if (p.knowledgeInRepo !== !keep) next.push([p, !keep])
    }
    if (!next.length) return
    await ctx.backup(file)
    for (const [p, v] of next) p.knowledgeInRepo = v
    await writeJsonAtomic(file, list)
    const kept = next.filter(([, v]) => !v).length
    ctx.log(`${next.length - kept} 个项目的教训、经验改为随仓库存；${kept} 个项目数据目录里已经有，照旧存数据目录`)
  },
}
