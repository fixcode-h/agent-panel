/**
 * 一次性迁移（ADR 0083）：以前面板把自带技能装在 ~/.agents/skills/<名字>，Codex、Pi、Command Code 会自己把那里的全部读进去，
 * 启动时就看到所有技能。现在装在面板数据目录（server/bundled-skills.ts 的 bundledStore），每轮只放角色自带的。
 *
 * 第一次用到自带技能时（补齐、列出、安装）把旧副本搬过来，做完记一个标记文件，之后不再看：
 * - 和面板装进去的一模一样（和这一版一样，或者和安装记录的指纹一样）：复制进数据目录，再从 ~/.agents/skills 删掉；
 * - 用户改过的：复制进数据目录（面板之后用用户改的这份），~/.agents/skills 里那份是用户的内容，原样留着，日志里写一笔；
 * - 数据目录里已经有了：只按上面的规则清掉没改过的旧副本。
 * 「部署」放在 ~/.agents/skills/<分类>/<名字> 的是用户自己选的全局部署，不动。下线技能的旧副本照旧按指纹清（retireBundled）
 */
import { existsSync } from 'node:fs'
import { cp, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { log } from '../log.ts'
import { dataPath, writeJsonAtomic } from '../store.ts'
import { bundledStore, legacySharedRoot, readTree, retireBundled, type Entry } from '../bundled-skills.ts'
import { treeHash, untouchedHash } from './installed-record.ts'

const MARK = () => dataPath('config/bundled-skills-moved.json')

/** 旧副本没被人改过：和这一版完全一样，或者和面板当初装进去的那份（或登记过的发布版）指纹一样 */
async function untouched(e: Entry, dir: string) {
  const found = await readTree(dir)
  const same = found.length === e.files.size && found.every(([rel, buf]) => e.files.get(rel)?.equals(buf))
  if (same) return true
  return untouchedHash(e.name, treeHash(found))
}

export async function moveFromLegacyRoot(list: Entry[]) {
  if (existsSync(MARK())) return
  const legacy = legacySharedRoot()
  const store = bundledStore()
  const moved: string[] = []
  const kept: string[] = []
  try {
    await retireBundled(legacy)
    for (const e of list) {
      const from = path.join(legacy, e.name)
      if (!existsSync(path.join(from, 'SKILL.md'))) continue
      const to = path.join(store, e.name)
      const clean = await untouched(e, from)
      if (!existsSync(path.join(to, 'SKILL.md'))) {
        await mkdir(store, { recursive: true })
        await cp(from, to, { recursive: true, verbatimSymlinks: true })
      }
      if (clean) {
        await rm(from, { recursive: true, force: true })
        moved.push(e.name)
      } else kept.push(e.name)
    }
    await writeJsonAtomic(MARK(), { at: new Date().toISOString(), moved, kept })
    if (moved.length || kept.length)
      log.info('skills', '自带 Skill 从 ~/.agents/skills 搬到面板数据目录', { moved, kept })
  } catch (err) {
    // 搬不动（权限、占用）下次再试：不写标记，执行照常（推送读随包的那份）
    log.warn('skills', `自带 Skill 搬到数据目录失败：${(err as Error).message}`)
  }
}
