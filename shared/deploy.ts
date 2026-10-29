/**
 * 部署：把全局说明（AGENTS.md）写进各个 CLI 的用户目录，把选中的自带 Skill 放到 ~/.agents/skills/<分类>/<名字>/。
 * 和 fixcode-h/Agent 原来的 deploy 脚本一样：Skill 按分类放一层子目录，CLI 启动时不会自动加载，
 * 全局说明末尾附上技能清单（名字、什么时候用、SKILL.md 的位置），任务需要时再去读。
 */
import { z } from 'zod'
import { BUILTIN_AGENTS } from './builtin/agents.ts'
import { DOC_MAX } from './docs.ts'
import { promptLangRules, promptLangWord } from './prompt-lang.ts'

/** Skill 部署到的目录（相对用户目录） */
export const SKILL_TARGET = '~/.agents/skills'

export const DeployConfig = z.object({
  /** 全局说明的正文；技能清单在部署时自动加在后面 */
  agentsMd: z.string().max(DOC_MAX).default(''),
  /** 要部署的自带 Skill；默认一个都不选 */
  skills: z.array(z.string()).default([]),
  /** 全局说明写进哪些 CLI；为空表示还没选过，按已安装的 CLI */
  clis: z.array(z.string()).default([]),
})
export type DeployConfig = z.infer<typeof DeployConfig>

export type DeployStatus = 'missing' | 'same' | 'changed'

export interface DeploySkill {
  name: string
  category: string
  description: string
  /** SKILL.md 以外的文件数 */
  files: number
  /** 在 ~/.agents/skills 里的状态 */
  status: DeployStatus
}

export interface DeployTarget {
  cli: string
  name: string
  /** 全局说明文件的完整路径 */
  path: string
  /** 和这次要写的内容比 */
  status: DeployStatus
}

export interface DeployState {
  /** 保存过的配置；没保存过时全局说明是 template */
  config: DeployConfig
  /** 默认的全局说明（内置的通用约束） */
  template: string
  /** ~/.agents/skills 的完整路径 */
  skillRoot: string
  skills: DeploySkill[]
  targets: DeployTarget[]
}

/**
 * 自带技能里要更新的：装过、但内容和这一版自带的不同（面板升级带来了新内容，或本机改过）。
 * 侧栏「Skills」和设置的「部署」据此亮提示点，告诉用户去哪里更新
 */
export interface SkillUpdates {
  /** 「Skills → 自带 Skill」装到 ~/.agents/skills/<名字> 的 */
  shared: string[]
  /** 「设置 → 部署」放到 ~/.agents/skills/<分类>/<名字> 的 */
  deployed: string[]
}

export interface DeployResult {
  /** 新装或更新的 Skill */
  skills: string[]
  /** 改过的 Skill（和自带的不同），没有勾「覆盖」时保留 */
  kept: string[]
  /** 取消勾选后移除的 Skill（只移除和自带的一样的） */
  removed: string[]
  docs: { cli: string; path: string; result: 'created' | 'updated' | 'same'; backup?: string }[]
}

export const DeployRun = DeployConfig.extend({
  /** 覆盖改过的 Skill */
  overwrite: z.boolean().default(false),
})
export type DeployRun = z.infer<typeof DeployRun>

/** 默认的全局说明：内置 Agent 都引入的「通用约束」 */
export const deployTemplate = () =>
  `# 全局约束\n\n${BUILTIN_AGENTS.find((a) => a.key === 'rules')?.agent.instructions ?? ''}\n`

/** 部署出去的全局说明：正文 + 技能清单 */
export function composeAgentsMd(body: string, skills: Pick<DeploySkill, 'name' | 'category' | 'description'>[]) {
  const text = body.trimEnd()
  if (!skills.length) return text ? `${text}\n` : ''
  const list = skills
    .map((s) => `- \`${s.name}\`（${SKILL_TARGET}/${s.category}/${s.name}/SKILL.md）：${s.description}`)
    .join('\n')
  return `${text ? `${text}\n\n` : ''}## 技能

下面的技能默认不加载。任务符合描述时，先读对应的 SKILL.md，再按里面的规则做。

${list}
`
}

export const GlobalDocOptimize = z.object({
  /** 编辑器里当前的内容（可能还没保存） */
  content: z.string().max(DOC_MAX),
  request: z.string().trim().max(4000).default(''),
  cli: z.string().min(1),
  model: z.string().trim().default(''),
  effort: z.string().trim().default(''),
})
export type GlobalDocOptimize = z.infer<typeof GlobalDocOptimize>

/** AI 生成或优化全局说明的提示词（回复语言跟随面板设置） */
export function globalDocPrompt(input: GlobalDocOptimize, clis: string[]) {
  const has = input.content.trim()
  return [
    `你在帮忙${has ? '优化' : '写'}一份全局说明文件 AGENTS.md。${clis.length ? `它会被部署到 ${clis.join('、')} 的用户目录，` : ''}在所有项目里每次启动时读入，作为通用的工作约定。`,
    // 语言规则接在第一段之后：识别这类提示的地方按第一句开头匹配
    promptLangRules(),
    '',
    '要求：',
    '- 只写跨项目都成立的常驻约束：语言、文件编码、提问方式、命令执行、执行纪律、安全边界等；不写某个项目的命令、目录和技术栈。',
    '- 写给编码助手看：简洁、具体、能照着做，不写空话；用二级标题分节。',
    // 文件里“语言”那一节的约定本身也要跟着设置走，否则英文界面下要求写中文会很奇怪
    has ? '- 保留原文里仍然正确、有用的内容和原来的语言。' : `- 用${promptLangWord()}写。`,
    '- 其中的「语言」一节写：回复正文和思考过程都用同一种语言，代码、标识符、命令、日志和报错原文保持原样不翻译。',
    '- 技能清单由部署时自动附在文件末尾，不要自己写技能列表，也不要写「先加载某个总路由技能」这类编排规则。',
    '- 不要修改任何文件，只在回答里给出结果。',
    input.request ? `- 用户的要求：${input.request}` : '',
    '',
    '回答的格式：先用一两句话说明写了或改了什么，然后把完整的文件内容放在一个 ```markdown 代码块里（只放一个代码块，内容是完整文件，不是片段）。',
    has ? '\n当前的内容：\n<<<文件开始\n' + input.content + '\n文件结束>>>' : '',
  ]
    .filter((l) => l !== '')
    .join('\n')
}
