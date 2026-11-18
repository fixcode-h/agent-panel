/**
 * 每轮带上按项目的技能（工作包 W4）：项目能力里打开了的、角色点名要用的，只要标成按项目，
 * 就放进数据目录 run-skills/<项目>/<CLI>/ 里，再按 CLI 定义的 runSkills 交给 CLI（参数或协议请求）。
 * 不读 ~/.agents/skills 的 CLI（Claude Code，runSkills.shared）连那里装着的全局技能一起带：
 * 面板的自带技能统一装在那里，不带的话 Claude Code 一个也看不到（2026-11-15 用户看到 Skill 是 0）。
 * CLI 定义里没写 runSkills 的，改成在提示里列出技能和路径（同「部署」写进全局说明的那份清单）。
 *
 * 每轮按这一轮要带的重建：关掉的技能下一轮就不在了。同一个项目同时跑的几个对话共用这个目录，
 * 先在旁边写好再换上，不会读到写了一半的技能
 *
 * 开着的插件带的技能也每轮带上（server/skills/plugin-skills.ts），提示里另列一节写明用法和路径
 */
import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import type { CliDefinition } from '../../shared/clis.ts'
import { frontField } from '../../shared/library.ts'
import { pluginSkillsNote, roleSkillDirNote, runSkillNames, runSkillsNote } from '../../shared/skills/activation.ts'
import { entries, sharedRoot, writeSkill } from '../bundled-skills.ts'
import { log } from '../log.ts'
import { isProjectSkill, projectSkills, projectSkillStore, runSkillsRoot } from './config.ts'
import type { PluginSkill } from './plugin-skills.ts'

export interface RunSkills {
  /** 这一轮带上的技能名 */
  names: string[]
  /** 加在启动参数后面的 */
  args: string[]
  /** 走协议的 CLI 开会话前发的请求（Codex 的 skills/extraRoots/set） */
  rpc?: { method: string; params: unknown }
  /** 补进角色设定的说明：角色点名的按项目技能放在哪；CLI 不能按会话加载时还有技能清单 */
  note: string
}

const EMPTY: RunSkills = { names: [], args: [], note: '' }

/** 把 {root}、{dir} 换成实际路径（字符串、数组、对象里的都换） */
function fill(v: unknown, root: string, dir: string): unknown {
  if (typeof v === 'string') return v.replaceAll('{root}', root).replaceAll('{dir}', dir)
  if (Array.isArray(v)) return v.map((x) => fill(x, root, dir))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, root, dir)]))
  return v
}

/** 往 dir 里放一个技能：这个 CLI 自己挪进数据目录的那份优先，其次是自带的（含插件带的） */
async function place(name: string, cli: string, dir: string, bundled: Awaited<ReturnType<typeof entries>>) {
  const own = path.join(projectSkillStore(cli), name)
  if (existsSync(path.join(own, 'SKILL.md'))) {
    await cp(own, path.join(dir, name), { recursive: true, verbatimSymlinks: true })
    return frontField(await readFile(path.join(own, 'SKILL.md'), 'utf8'), 'description')
  }
  const e = bundled.find((x) => x.name === name)
  if (!e) return null
  await writeSkill(e, dir)
  return frontField(e.files.get('SKILL.md')!.toString('utf8'), 'description')
}

/** ~/.agents/skills 下装着的全局技能（<名字>/SKILL.md；「部署」放的分类目录下一层不算，它们靠全局说明里的清单） */
async function sharedSkills(skip: string[]) {
  const root = sharedRoot()
  const list = await readdir(root, { withFileTypes: true }).catch(() => [])
  return list
    .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && existsSync(path.join(root, e.name, 'SKILL.md')))
    .map((e) => e.name)
    .filter((n) => !isProjectSkill(n) && !skip.includes(n))
    .sort()
}

export async function prepareRunSkills(a: {
  def: Pick<CliDefinition, 'id' | 'runSkills'>
  projectId: string
  opened: string[] | undefined
  roleSkills: string[]
  /** 开着的插件带的技能（server/skills/plugin-skills.ts）：每轮都带，提示里列出用法 */
  plugins?: PluginSkill[]
}): Promise<RunSkills> {
  const want = runSkillNames(projectSkills(), a.opened, a.roleSkills)
  // 插件技能：按项目的那些已经在 want 里；已经装进 ~/.agents/skills 的由 CLI 自己读（或下面随全局技能一起带），不再放一份
  const plugins = (a.plugins ?? []).filter((p) => !want.includes(p.entry.name))
  const pluginPut = plugins.filter((p) => !p.shared)
  // 不读 ~/.agents/skills 的 CLI（runSkills.shared）：那里装着的全局技能也一起带上
  const shared = a.def.runSkills?.shared ? await sharedSkills([...want, ...pluginPut.map((p) => p.entry.name)]) : []
  const root = runSkillsRoot(a.projectId, a.def.id)
  const dir = path.join(root, a.def.runSkills?.subdir ?? '')
  // 插件技能这一轮在哪：放进这一轮目录的、随全局技能带进来的在 dir 下，其余就是 ~/.agents/skills 里那份
  const pluginNote = pluginSkillsNote(
    plugins.map((p) => ({
      name: p.entry.name,
      plugin: p.pluginName,
      description: frontField(p.entry.files.get('SKILL.md')!.toString('utf8'), 'description'),
      file: `${!p.shared || a.def.runSkills?.shared ? dir : sharedRoot()}/${p.entry.name}/SKILL.md`,
    })),
  )
  if (!want.length && !shared.length && !pluginPut.length) return pluginNote ? { ...EMPTY, note: pluginNote } : EMPTY
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
    for (const p of pluginPut) await writeSkill(p.entry, stagingDir)
    for (const name of shared) {
      const from = path.join(sharedRoot(), name)
      await cp(from, path.join(stagingDir, name), { recursive: true, verbatimSymlinks: true })
      placed.push({ name, description: frontField(await readFile(path.join(from, 'SKILL.md'), 'utf8'), 'description') })
    }
    // 换上：先挪开旧的再改名，旧的删掉。同时开跑的另一个对话这时读到的是旧的或新的完整一份
    const old = `${root}.old-${process.pid}-${Date.now()}`
    try {
      if (existsSync(root)) await rename(root, old)
      await rename(staging, root)
    } catch (e) {
      // 同一个项目的另一个对话恰好同时换上了它的那份：用它的（要带的技能一样），自己这份丢掉
      if (!existsSync(root)) throw e
      await rm(staging, { recursive: true, force: true })
    }
    await rm(old, { recursive: true, force: true })
    const names = [...placed.map((x) => x.name), ...pluginPut.map((p) => p.entry.name)]
    if (!names.length) return EMPTY
    const roleNames = placed.map((x) => x.name).filter((n) => want.includes(n) && a.roleSkills.includes(n))
    // 插件技能另有一节说明，不在「这个项目打开的技能」清单里重复列
    const listed = placed.filter((x) => !plugins.some((p) => p.entry.name === x.name))
    const spec = a.def.runSkills
    if (!spec)
      return {
        names,
        args: [],
        note: [runSkillsNote(dir, listed), pluginNote, roleSkillDirNote(dir, roleNames)].filter(Boolean).join('\n\n'),
      }
    return {
      names,
      args: spec.args.map((x) => fill(x, root, dir) as string),
      ...(spec.rpc && { rpc: fill(spec.rpc, root, dir) as RunSkills['rpc'] }),
      note: [pluginNote, roleSkillDirNote(dir, roleNames)].filter(Boolean).join('\n\n'),
    }
  } catch (err) {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
    log.warn('skills', `准备这一轮的按项目技能失败：${(err as Error).message}`)
    throw err
  }
}
