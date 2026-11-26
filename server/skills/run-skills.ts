/**
 * 每轮只带角色自带的技能（ADR 0083）：角色点名的（含引入的角色、就地用的挂载能力）、用户设成「每个对话都带」的、
 * 项目能力里打开了的按项目技能，放进数据目录 run-skills/<项目>/<CLI>/，再按 CLI 定义的 runSkills 交给 CLI（参数或协议请求）。
 * 其余技能（自带、插件、用户自己的）启动时不带，CLI 的技能列表里也没有，由面板按情境推正文（server/hooks/situational.ts）。
 * 以前 Claude Code 每轮连 ~/.agents/skills 整个带上、插件技能也每轮全带，弱模型看到一长串却一个不读；现在都不带了。
 * CLI 定义里没写 runSkills 的，改成在提示里列出这几个技能和路径（只列这一轮带的）。
 *
 * 每轮按这一轮要带的重建：关掉的技能下一轮就不在了。目录按要带的那组技能分开（角色不同、要带的不同就不共用），
 * 要带的一样的几个对话共用一份，先在旁边写好再换上，不会读到写了一半的技能
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import type { CliDefinition } from '../../shared/clis.ts'
import { frontField } from '../../shared/library.ts'
import { alwaysSkillsNote, runSkillNames, runSkillsNote } from '../../shared/skills/activation.ts'
import { bundledStore, entries, legacySharedRoot, writeSkill } from '../bundled-skills.ts'
import { moveDir, retryBusy } from '../disk/busy-retry.ts'
import { log } from '../log.ts'
import { projectSkills, projectSkillStore, runSkillsRoot } from './config.ts'

export interface RunSkills {
  /** 这一轮带上的技能名 */
  names: string[]
  /** 加在启动参数后面的 */
  args: string[]
  /** 走协议的 CLI 开会话前发的请求（Codex 的 skills/extraRoots/set） */
  rpc?: { method: string; params: unknown }
  /** 补进角色设定的说明：CLI 不能按会话加载时的技能清单、每个对话都带的技能 */
  note: string
  /** 这一轮的技能目录（<名字>/SKILL.md 在它下面，/ 分隔）：角色设定里「要用的 Skill」写明在这里；没带技能为空 */
  dir: string
}

const EMPTY: RunSkills = { names: [], args: [], note: '', dir: '' }

/** 把 {root}、{dir} 换成实际路径（字符串、数组、对象里的都换） */
function fill(v: unknown, root: string, dir: string): unknown {
  if (typeof v === 'string') return v.replaceAll('{root}', root).replaceAll('{dir}', dir)
  if (Array.isArray(v)) return v.map((x) => fill(x, root, dir))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, root, dir)]))
  return v
}

/**
 * 往 dir 里放一个技能，按这个顺序找：这个 CLI 自己挪进数据目录的按项目技能 → 面板数据目录里装的自带技能（用户改过就是改过的）→
 * 随包的自带技能、开着的插件带的 → ~/.agents/skills 里用户自己放的同名技能（角色点名了它，Claude Code 又不读那里）
 */
async function place(name: string, cli: string, dir: string, bundled: Awaited<ReturnType<typeof entries>>) {
  for (const from of [path.join(projectSkillStore(cli), name), path.join(bundledStore(), name)]) {
    if (!existsSync(path.join(from, 'SKILL.md'))) continue
    await cp(from, path.join(dir, name), { recursive: true, verbatimSymlinks: true })
    return frontField(await readFile(path.join(from, 'SKILL.md'), 'utf8'), 'description')
  }
  const e = bundled.find((x) => x.name === name)
  if (e) {
    await writeSkill(e, dir)
    return frontField(e.files.get('SKILL.md')!.toString('utf8'), 'description')
  }
  const legacy = path.join(legacySharedRoot(), name)
  if (!existsSync(path.join(legacy, 'SKILL.md'))) return null
  await cp(legacy, path.join(dir, name), { recursive: true, verbatimSymlinks: true })
  return frontField(await readFile(path.join(legacy, 'SKILL.md'), 'utf8'), 'description')
}

/**
 * 把写好的 staging 换成 root：先挪开旧的再改名，旧的删掉。同时开跑的另一个对话这时读到的是旧的或新的完整一份。
 * Windows 上刚写好的文件常被杀毒软件、索引服务短暂占着，改名会报 EPERM（2026-11-19 用户看到「技能这一轮没能带上」）：
 * 等一会儿重试，一直改不了就复制过去；实在换不上时把旧的挪回来，不留下一个没有技能目录、只剩 .old 的项目
 */
async function swapIn(staging: string, root: string) {
  const old = `${root}.old-${process.pid}-${Date.now()}`
  let moved = false
  try {
    if (existsSync(root)) {
      await retryBusy(() => rename(root, old), 8)
      moved = true
    }
    await moveDir(staging, root)
  } catch (e) {
    // 同一个项目的另一个对话恰好同时换上了它的那份：用它的（要带的技能一样），自己这份丢掉
    if (!existsSync(root)) {
      if (moved) await rename(old, root).catch(() => {})
      throw e
    }
    await rm(staging, { recursive: true, force: true })
  }
  await rm(old, { recursive: true, force: true, maxRetries: 5 }).catch(() => {})
}

export async function prepareRunSkills(a: {
  def: Pick<CliDefinition, 'id' | 'runSkills'>
  projectId: string
  opened: string[] | undefined
  roleSkills: string[]
  /** 用户设成「每个对话都带」的技能（设置「Agent 工具 → 技能」）：当成所有角色的自带技能 */
  always?: string[]
}): Promise<RunSkills> {
  const always = (a.always ?? []).filter((n) => !a.roleSkills.includes(n))
  const want = runSkillNames(projectSkills(), a.opened, [...a.roleSkills, ...always])
  if (!want.length) return EMPTY
  // 按要带的这组技能分目录：同一个项目里不同角色的对话同时在跑时各用各的，不会把别人正在用的那份换掉
  const key = createHash('sha1').update(want.join('\n')).digest('hex').slice(0, 10)
  const root = runSkillsRoot(a.projectId, a.def.id, key)
  const dir = path.join(root, a.def.runSkills?.subdir ?? '')
  const staging = `${root}.next-${process.pid}-${Date.now()}`
  const stagingDir = path.join(staging, a.def.runSkills?.subdir ?? '')
  try {
    await rm(staging, { recursive: true, force: true })
    await mkdir(stagingDir, { recursive: true })
    const bundled = await entries()
    const placed: { name: string; description: string }[] = []
    for (const name of want) {
      const description = await place(name, a.def.id, stagingDir, bundled)
      if (description !== null) placed.push({ name, description })
    }
    await swapIn(staging, root)
    if (!placed.length) return EMPTY
    const names = placed.map((x) => x.name)
    const slash = dir.replaceAll('\\', '/')
    const alwaysNote = alwaysSkillsNote(
      slash,
      always.filter((n) => names.includes(n)),
    )
    const spec = a.def.runSkills
    if (!spec)
      return {
        names,
        args: [],
        note: [runSkillsNote(slash, placed), alwaysNote].filter(Boolean).join('\n\n'),
        dir: slash,
      }
    return {
      names,
      args: spec.args.map((x) => fill(x, root, dir) as string),
      ...(spec.rpc && { rpc: fill(spec.rpc, root, dir) as RunSkills['rpc'] }),
      note: alwaysNote,
      dir: slash,
    }
  } catch (err) {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
    log.warn('skills', `准备这一轮的技能失败：${(err as Error).message}`)
    throw err
  }
}
