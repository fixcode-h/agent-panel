import { pluginSkillGuide } from './plugins/index.ts'
import { builtinGuide, skillBase } from './skills/catalog.ts'

/**
 * 技能名的整理和角色设定里那一行：「什么时候用」写在技能目录（shared/skills/catalog.ts 的 guide），
 * 插件带的写在插件清单里（skillGuide）；用户自己装的技能没有说明时只列名字。
 * 只列名字时模型常常不知道什么时候该读；写清触发条件才会在合适的时机用上
 */

/**
 * 下线的自带技能 → 接替它的技能（没有就是空串）：本机已装的角色副本里可能还点着旧名字（用户改过的副本不会被升级），
 * 拼提示词、补装技能时换成接替的那个，免得 CLI 去找一个已经不存在的 SKILL.md
 */
export const RETIRED_SKILL_MAP: Record<string, string> = {
  // UE 编译统一由父对话申请执行，资源锁和编译排队由面板管，不再需要这份协调规则
  'ue-multi-agent-coordination': '',
  // Lua 只做语法检查（luac -p），不编译成 .luac，不再单独带一份字节码编译技能
  'lua-luac-compiler': '',
  // 测试先行并进了 project-testing
  'test-driven-development': 'project-testing',
  // 太宽泛；编码时真正用得上的扩展点、配置化规则在 coding-standards 里
  'software-architecture-design': 'coding-standards',
  // Blender 插件（3.1.0-alpha.5 起）把这两个技能并进了 blender-modeling；插件建的「Blender 建模」角色副本不会自动升级
  blender: 'blender-modeling',
  'blender-model-animation-workflow': 'blender-modeling',
}
export const RETIRED_SKILLS = new Set(Object.keys(RETIRED_SKILL_MAP)) // 模块状态：常量，加载后不改

/**
 * 换掉下线的技能名、补上特化技能依赖的通用技能（技能目录的 base：特化的只补差异，用到它时通用的那份必须一起给，
 * 例如 UE 项目用 ue-project-structure，也要有 project-structure），去重后保持原顺序（通用的排在特化的前面）
 */
export function resolveSkills(names: string[]) {
  const out: string[] = []
  const add = (n: string) => {
    if (n && !out.includes(n)) out.push(n)
  }
  for (const raw of names) {
    const n = raw in RETIRED_SKILL_MAP ? RETIRED_SKILL_MAP[raw] : raw
    if (!n) continue
    const base = skillBase(n)
    if (base) add(base)
    add(n)
  }
  return out
}

/** 提示词里的一行：`- \`名字\`：什么时候用` */
export function skillLine(name: string) {
  const guide = builtinGuide(name) ?? pluginSkillGuide(name)
  return guide ? `- \`${name}\`：${guide}` : `- \`${name}\``
}

/**
 * 已下线、又没有接替者的技能名（去重保序）。
 * 这些技能拼提示词时要丢掉（CLI 去找一个不存在的 SKILL.md 只会报错），但报告是给人排查用的，
 * 静默丢掉会让人以为角色本来就没配这个技能，所以报告单独把它标成「已下线」。
 */
export function retiredWithoutSuccessor(names: string[]) {
  return [...new Set(names.filter((n) => n in RETIRED_SKILL_MAP && !RETIRED_SKILL_MAP[n]))]
}

/**
 * 角色设定里「要用的 Skill」那一节补上技能装在哪：角色自带的技能每轮放进这一轮的技能目录（server/skills/run-skills.ts），
 * 只写「~/.agents/skills」时模型会自己猜 ~ 是哪里——CLI 的用户目录和工作目录对不上时猜错，读到不存在的路径再弹权限卡卡住
 * （2026-11-03 真实 API 实测：「文档」子任务两次猜成 /home/user/... 和项目目录下的 .agents/skills）。没有这一节时原样返回
 */
export function withSkillDir(role: string, dir: string) {
  const head = '## 要用的 Skill\n'
  const at = role.indexOf(head)
  if (at < 0 || !dir) return role
  const end = role.indexOf('\n', at + head.length)
  const cut = end < 0 ? role.length : end
  const note = `\n这些 Skill 装在 \`${dir}\`，路径就是 \`${dir}/<名字>/SKILL.md\`：直接读这个路径，不要自己猜用户目录在哪。`
  return role.slice(0, cut) + note + role.slice(cut)
}
