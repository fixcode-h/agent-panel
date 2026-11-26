/**
 * 全局技能的生效方式存在 config/skill-activation.json（只记按项目的技能名，见 shared/skills/activation.ts）。
 * 库、自带技能、部署、每轮带技能都要同步地问「这个技能是不是按项目」（library.ts 的 target 是同步的），
 * 所以读一次放在内存里，改的时候一起写盘
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { CliDefinition } from '../../shared/clis.ts'
import { SkillActivationConfig } from '../../shared/skills/activation.ts'
import { expandHome } from '../cli/extras.ts'
import { dataPath, writeJsonAtomic } from '../store.ts'

const FILE = () => dataPath('config/skill-activation.json')

let cache: Set<string> | null = null // 模块状态：配置副本，改的时候和磁盘一起更新，重启时重读

function load(): Set<string> {
  if (cache) return cache
  let raw: unknown = {}
  try {
    raw = JSON.parse(readFileSync(FILE(), 'utf8'))
  } catch {
    // 没有文件（从没切过）或者坏了：当全都是全局，和升级前一样
  }
  const p = SkillActivationConfig.safeParse(raw)
  cache = new Set(p.success ? p.data.project : [])
  return cache
}

/** 标成按项目的技能名 */
export const projectSkills = (): ReadonlySet<string> => load()

export const isProjectSkill = (name: string) => load().has(name)

export async function setProjectSkill(name: string, on: boolean) {
  const next = new Set(load())
  if (on) next.add(name)
  else next.delete(name)
  await writeJsonAtomic(FILE(), { project: [...next].sort() })
  cache = next
}

/** 测试用：换了数据目录后丢掉缓存 */
export function resetSkillActivationCache() {
  cache = null
}

/** CLI 用户级技能目录（技能库按它读写）：定义里 skills.user 的第一个，走协议列技能的用 rpc.skillsDir */
export const userSkillDir = (d: CliDefinition) => {
  const dir = d.skills.user[0] ?? d.rpc?.skillsDir ?? ''
  return dir && expandHome(dir)
}

/** 按项目的自己的技能挪到这里：数据目录 project-skills/<CLI>/<名字>/ */
export const projectSkillStore = (cli: string) => path.join(dataPath('project-skills'), cli)

/**
 * 每轮带技能的目录：数据目录 run-skills/<项目>/<CLI>-<这组技能的指纹>/，每轮开始时按这一轮要带的重建。
 * 按要带的那组技能分开：同一个项目里不同角色的对话同时在跑，不会互相把对方的技能换掉
 */
export const runSkillsRoot = (projectId: string, cli: string, key = '') =>
  path.join(dataPath('run-skills'), projectId || '_', key ? `${cli}-${key}` : cli)
