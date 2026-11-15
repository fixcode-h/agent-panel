/**
 * 切换全局技能的生效方式（见 shared/skills/activation.ts）。
 *
 * 改成按项目：自带技能从用户目录撤掉（只撤和自带一模一样的），各 CLI 用户目录里同名的自己的技能挪进面板数据目录；
 * 改回全局：挪走的挪回原来的 CLI 用户目录，自带技能不自动装回去（照旧在「自带 Skill」页装，或者角色用到时补上）。
 * 只动这个名字的技能，挪不动的（目标已经有同名的）原样留下并告诉用户
 */
import { existsSync } from 'node:fs'
import { cp, mkdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { CLIS } from '../../shared/clis.ts'
import { t } from '../../shared/i18n.ts'
import { libraryName } from '../../shared/library.ts'
import type { SkillActivationInput, SkillActivationResult } from '../../shared/skills/activation.ts'
import { allPluginEntries, entries, removeCopies } from '../bundled-skills.ts'
import { log } from '../log.ts'
import { isProjectSkill, projectSkillStore, setProjectSkill, userSkillDir } from './config.ts'

/** 挪目录：同一个盘直接改名，跨盘（数据目录可能设在别的盘）复制完再删 */
async function move(from: string, to: string) {
  await mkdir(path.dirname(to), { recursive: true })
  try {
    await rename(from, to)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
    await cp(from, to, { recursive: true, verbatimSymlinks: true })
    await rm(from, { recursive: true, force: true })
  }
}

export async function setSkillActivation(input: SkillActivationInput): Promise<SkillActivationResult> {
  const { name, activation } = input
  if (!libraryName('skill', name)) throw new Error(t('名字只能用字母、数字、. _ -'))
  const toProject = activation === 'project'
  const out: SkillActivationResult = { name, activation, moved: [], removed: [], kept: [] }
  if (toProject === isProjectSkill(name)) return out
  const bundled = [...(await entries()), ...(await allPluginEntries())].filter((e) => e.name === name)
  // 停用的 CLI 也挪：用户目录里的技能和 CLI 开没开无关，留着的话以后重新打开 CLI 又变成全局
  const homes = CLIS.flatMap((d) => (userSkillDir(d) ? [{ id: d.id, dir: userSkillDir(d) }] : []))
  const found = homes.filter((h) =>
    existsSync(path.join(toProject ? h.dir : projectSkillStore(h.id), name, 'SKILL.md')),
  )
  if (!bundled.length && !found.length) throw new Error(t('没有这个技能：{name}', { name }))
  // 先记下生效方式再挪：挪到一半出错时，已经挪进数据目录的那几份照样按项目带，不会凭空消失
  await setProjectSkill(name, toProject)
  for (const h of found) {
    const user = path.join(h.dir, name)
    const store = path.join(projectSkillStore(h.id), name)
    const [from, to] = toProject ? [user, store] : [store, user]
    if (existsSync(to)) {
      out.kept.push(from)
      continue
    }
    await move(from, to)
    out.moved.push(h.id)
  }
  if (toProject && bundled.length) {
    const r = await removeCopies(bundled.slice(0, 1))
    out.removed.push(...r.removed)
    out.kept.push(...r.kept)
  }
  log.info('skills', `技能「${name}」改成${toProject ? '按项目' : '全局'}`, {
    moved: out.moved.length,
    removed: out.removed.length,
    kept: out.kept.length,
  })
  return out
}
