import { CLIS } from './clis.ts'
import { t } from './i18n.ts'
import { frontField, libraryName } from './library.ts'

/**
 * 项目里的 Skill：项目目录下各 Agent 的 skills.repo（`.agents/skills`、`.claude/skills`……）里
 * 一个文件夹一个 Skill。项目设置里列出来、改 SKILL.md、AI 修复 / 优化，都按这里的目录走。
 *
 * 和 Skills 库（server/library.ts，管用户目录）分开：这里的文件属于项目，跟着项目提交。
 */
export interface ProjectSkill {
  /** 文件夹名，也是 front matter 里 name 该写的值 */
  name: string
  description: string
  /** SKILL.md 的绝对路径 */
  path: string
  /** 相对项目根的文件夹，例如 .agents/skills/release-notes */
  dir: string
  /** 来自哪个项目级目录（相对项目根），列表按它分组 */
  source: string
  /** 哪些 Agent 会读这个目录 */
  clis: string[]
  /** 解析出来的问题，空数组表示格式没问题 */
  issues: string[]
}

/** 技能列表：能放技能的目录（现在存不存在）+ 各目录下的技能 */
export interface ProjectSkillsView {
  /** 项目目录，没填或不存在时为空 */
  path: string
  repos: { dir: string; clis: string[]; exists: boolean }[]
  skills: ProjectSkill[]
}

/** 项目里收 Skill 的目录：各 Agent 定义里的 skills.repo，同一个目录被几个 Agent 共用时合成一项 */
export function projectSkillRepos(): { dir: string; clis: string[] }[] {
  const m = new Map<string, string[]>()
  for (const d of CLIS)
    for (const dir of d.skills.repo) {
      const key = dir.replaceAll('\\', '/')
      m.set(key, [...(m.get(key) ?? []), d.id])
    }
  return [...m].map(([dir, clis]) => ({ dir, clis }))
}

/** 新建技能时默认放这里：多个 Agent 共用，写一份就都能用 */
export const DEFAULT_SKILL_REPO = '.agents/skills'

/** 文件夹名规则和 Skills 库一致（字母数字开头，只含字母数字和 . _ -） */
export const projectSkillName = (name: string) => libraryName('skill', name)

/**
 * SKILL.md 的问题：解析不了、Agent 认不出什么时候该用它，都在这里报出来。
 * 有问题时列表上给「AI 修复」，把下面这些说法连同原文一起交给 AI。
 */
export function skillIssues(name: string, content: string): string[] {
  const out: string[] = []
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1]
  if (!fm) {
    out.push(t('开头缺少 --- 包起来的 front matter（里面要写 name 和 description）'))
    return out
  }
  const fmName = frontField(content, 'name')
  if (!fmName) out.push(t('front matter 里缺少 name'))
  else if (fmName !== name)
    out.push(t('front matter 的 name 是「{name}」，和文件夹名「{dir}」不一致', { name: fmName, dir: name }))
  const desc = frontField(content, 'description')
  if (!desc) out.push(t('front matter 里缺少 description：Agent 靠它判断什么时候用这个技能'))
  else if (desc.length < 10) out.push(t('description 只有 {n} 个字，说不清什么时候该用它', { n: desc.length }))
  const body = content.slice(content.indexOf('---', 3) + 3).trim()
  if (!body) out.push(t('只有 front matter，没有写具体怎么做'))
  return out
}

/** 新建技能的骨架：front matter 先写好，正文留提示 */
export function skillTemplate(name: string, description = '') {
  return [
    '---',
    `name: ${name}`,
    `description: ${description || t('一句话说明什么时候该用它')}`,
    '---',
    '',
    t('在这里写步骤和注意事项：先做什么、看哪些文件、要遵守什么约定。'),
    '',
  ].join('\n')
}
