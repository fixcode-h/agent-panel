import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { DATA_FILES, readJson, writeJsonAtomic } from '../store.ts'
import type { Migration } from './index.ts'

/**
 * 项目教训、经验默认改存面板数据目录（用户 2026-11-15 定，复查报告 B5，见 server/projects/knowledge-place.ts）。
 * 已经有项目把教训、经验写进了仓库：给它们记上 knowledgeInRepo: true，照旧读写仓库里的那份，
 * 不在升级时悄悄搬用户仓库里的文件；用户在项目设置里关掉「随仓库」时，面板把教训、经验写到数据目录（仓库里的不删）。
 * 仓库里没有的（新项目、从没记过的）不写这一项，按默认存数据目录。
 * P4、SVN 的教训放在共用文档根（要读角色设置、可能要问 p4 才算得出），这里不去算：看得出是 P4 / SVN 工作区就当作随仓库。
 * 重复跑只补还没写这一项的项目
 */
const P4_NAMES = ['.p4config', '.p4ignore', 'p4config.txt', '.p4config.txt', 'p4config', 'P4CONFIG']

async function hasFiles(dir: string) {
  if (!existsSync(dir)) return false
  const names = await readdir(dir).catch(() => [] as string[])
  return names.some((n) => n.endsWith('.md') && n !== 'README.md')
}

/** 往上找几层：是不是 P4 / SVN 的工作区（不起 p4 进程，迁移不能卡住启动） */
function p4OrSvn(dir: string) {
  let cur = dir
  for (let i = 0; i < 6; i++) {
    if (existsSync(path.join(cur, '.git'))) return false
    if (existsSync(path.join(cur, '.svn')) || P4_NAMES.some((n) => existsSync(path.join(cur, n)))) return true
    const up = path.dirname(cur)
    if (up === cur) break
    cur = up
  }
  return false
}

export async function knowledgeInRepoNow(dir: string): Promise<boolean> {
  if (p4OrSvn(dir)) return true
  return (
    (await hasFiles(path.join(dir, 'docs', 'lessons'))) ||
    existsSync(path.join(dir, 'docs', 'lessons.md')) ||
    (await hasFiles(path.join(dir, 'docs', 'agent-knowledge', 'experience')))
  )
}

export const knowledgePlace: Migration = {
  version: 7,
  name: 'knowledge-place',
  async run(ctx) {
    const file = path.join(ctx.dataDir, DATA_FILES['projects.json'])
    const list = (await readJson(file).catch(() => undefined)) as Record<string, unknown>[] | undefined
    if (!Array.isArray(list)) return
    const marks: Record<string, unknown>[] = []
    for (const p of list) {
      if (!p || typeof p !== 'object' || 'knowledgeInRepo' in p) continue
      const dir = typeof p.path === 'string' ? p.path.trim() : ''
      if (dir && (await knowledgeInRepoNow(dir).catch(() => false))) marks.push(p)
    }
    if (!marks.length) return
    await ctx.backup(file)
    for (const p of marks) p.knowledgeInRepo = true
    await writeJsonAtomic(file, list)
    ctx.log(`${marks.length} 个项目的教训、经验已经在仓库里，照旧随仓库存`)
  },
}
