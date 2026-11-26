/**
 * 技能目录（设计稿《技能由面板推送》第 3 节，ADR 0083）：一个技能一行，写清「什么时候用」（guide，拼角色设定时给模型看）、
 * 扩展的通用技能（base）、面板什么时候把正文推给 Agent（when）和默认开不开（autoPush）。
 *
 * 以前这些散在三张表里（shared/skill-guide.ts 的 GUIDE、SKILL_BASE，shared/skills/code-style.ts 的 CODE_STYLE_SKILLS），
 * 只有说明没有机器能判断的条件，弱模型不读技能正文就等于没有（2026-11-26 子对话 118 次调用没读过 lua-code-style）。
 * 现在启动时只带角色自带的技能，其余由面板按这里的条件在需要的那一刻推正文（server/hooks/situational.ts）。
 *
 * 来源用注册表接进来（SkillSource）：自带的在这里，插件带的由服务端按装着的插件生成（说明取插件清单的 skillGuide），
 * 用户在设置「Agent 工具 → 技能」里改的开关和条件是覆盖（SkillOverride，存在 config/hooks.json 的 skills）。
 * 意图类的技能（brainstorming、grilling、openspec、task-records）面板看不出什么时候要用，不自动推（设计稿 13.1），
 * 只靠角色自带或用户「/名字」点名。guide 是提示词，不翻译
 */
import { t } from '../i18n.ts'
import type { SkillOverride, SkillWhen } from './schema.ts'

export { SkillOverride } from './schema.ts'

export type SkillSourceId = 'builtin' | 'plugin'

export interface SkillEntry {
  name: string
  source: SkillSourceId
  /** 插件带的：插件 id 和显示名 */
  plugin?: string
  pluginName?: string
  /** 什么时候用（一句话，给模型看） */
  guide: string
  /** 特化技能扩展的通用技能：推它、带它时通用的那份一起给 */
  base?: string
  /** 默认的触发条件 */
  when: SkillWhen[]
  /** 默认开不开自动推（意图类的不开） */
  autoPush: boolean
}

/** 一个来源：自带的、插件的……加新来源只加一个 */
export interface SkillSource {
  id: SkillSourceId
  label: () => string
  entries: () => SkillEntry[]
}

const w = (kind: SkillWhen['kind'], value: string): SkillWhen => ({ kind, value })
/** 代码文件：「第一次改代码文件」推 coding-standards */
const CODE_GLOB = '**/*.{ts,tsx,js,jsx,mjs,cjs,py,lua,c,cc,cpp,h,hpp,inl,cs,go,rs,java,kt,swift,rb,php}'

const core = (e: Omit<SkillEntry, 'source' | 'autoPush'> & { autoPush?: boolean }): SkillEntry => ({
  source: 'builtin',
  autoPush: e.when.length > 0,
  ...e,
})

/** 面板自带的技能（skills/ 下的目录名）。新加技能在这里加一行；默认条件按设计稿 3.3 逐个核对过 */
export const BUILTIN_SKILLS: SkillEntry[] = [
  core({
    name: 'lua-code-style',
    guide: '写或改 Lua 代码时',
    when: [w('edit', '**/*.lua'), w('message', '**/*.lua'), w('params', 'lang=lua')],
  }),
  core({
    name: 'cpp-code-style',
    guide: '写或改 C++ / UE C++ 代码时',
    when: [w('edit', '**/*.{h,hpp,cpp,cc,inl}'), w('message', '**/*.{h,hpp,cpp,cc,inl}'), w('params', 'lang=cpp')],
  }),
  core({
    name: 'coding-standards',
    guide: '写或改代码、搭新模块时：跟随已有写法、数值和配置不写死、按真实变化留扩展点、交付前自查差异',
    when: [w('edit', CODE_GLOB)],
  }),
  core({
    name: 'project-testing',
    guide: '写新功能或修 Bug 要先写失败的测试、写或改测试、决定跑哪些测试、写验收证据时',
    when: [
      w('edit', '**/{test,tests,__tests__,spec}/**|**/*.{test,spec}.*|**/*_test.*|**/test_*.py'),
      w('command', 'test'),
    ],
  }),
  core({
    name: 'systematic-debugging',
    guide: '遇到 Bug、测试失败或意外行为，要先找根因再改时',
    when: [w('failed', 'test'), w('phase', 'bug')],
  }),
  core({
    name: 'verification-before-completion',
    guide: '准备宣布完成、提交或创建 PR 之前，要先跑验证拿新鲜证据时',
    when: [w('phase', 'finishing')],
  }),
  core({
    name: 'project-vcs',
    guide: '任务开始时识别 Git / P4 / SVN / 无版本控制，保护已有改动；改完文件后做收尾、合并与工作区清理',
    when: [w('command', 'vcs-write'), w('phase', 'finishing-edited')],
  }),
  core({
    name: 'project-documentation',
    guide: '读写项目文档、维护模块 README 和 bugs.md、确定文档根目录时',
    when: [w('edit', '**/docs/**/*.md|**/AGENTS.md|**/README.md')],
  }),
  // 通用的那份只在用到特化技能（ue-project-structure）时一起给；单独的触发是「第一次接触这个项目」，属于意图，不自动推
  core({
    name: 'project-structure',
    guide: '第一次接触这个项目、需要弄清目录结构、构建命令、测试命令、运行方式时',
    when: [],
  }),
  core({
    name: 'ue-project-structure',
    guide:
      'UE 项目在 project-structure 之外的引擎规则：模块与插件、UHT/UBT 编译、自动化测试、Gameplay 框架、资产与 Cook',
    base: 'project-structure',
    when: [w('project', '*.uproject')],
  }),
  core({ name: 'brainstorming', guide: '需求或方案还不清楚，要先澄清意图、比较方案、取得确认时', when: [] }),
  core({ name: 'grilling', guide: '要在动手前压测设计树、逐轮追问决策时', when: [] }),
  core({ name: 'openspec', guide: '按 OpenSpec 流程写 proposal / specs / design / tasks 和验收归档时', when: [] }),
  core({
    name: 'task-records',
    guide: '任务较大、需要 tasks / design / acceptance / handoff 记录和跨会话恢复时',
    when: [],
  }),
]

export const builtinSkillSource: SkillSource = {
  id: 'builtin',
  label: () => t('自带'),
  entries: () => BUILTIN_SKILLS,
}

/**
 * 插件带的技能：说明取插件清单的 skillGuide（设计稿的 skillWhen 要等插件接口 22，第一期先只接说明）。
 * 默认条件：插件的 MCP 工具名按约定带插件 id 前缀（ue_、blender_），调它的工具时推；只带技能的插件没有工具，
 * 只能靠角色自带、用户「/名字」点名或在设置里加条件
 */
export function pluginSkillSource(list: { name: string; plugin: string; pluginName: string; guide: string }[]) {
  return {
    id: 'plugin',
    label: () => t('插件'),
    entries: () =>
      list.map((p): SkillEntry => ({
        name: p.name,
        source: 'plugin',
        plugin: p.plugin,
        pluginName: p.pluginName,
        guide: p.guide,
        when: [w('tool', `${p.plugin.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_*`)],
        autoPush: true,
      })),
  } satisfies SkillSource
}

/** 套上用户改动之后的一行 */
export interface EffectiveSkill extends SkillEntry {
  /** 自动推开着 */
  on: boolean
  always: boolean
  /** 和默认不一样（界面写「已改，恢复默认」） */
  changed: boolean
  /** 默认的条件和开关（恢复默认、对比用） */
  defaults: { when: SkillWhen[]; on: boolean }
}

export function applyOverride(e: SkillEntry, o: SkillOverride | undefined): EffectiveSkill {
  const on = o?.on ?? e.autoPush
  const when = o?.when ?? e.when
  return {
    ...e,
    when,
    on,
    always: !!o?.always,
    changed: !!o && (o.on !== undefined || o.always !== undefined || o.when !== undefined),
    defaults: { when: e.when, on: e.autoPush },
  }
}

/**
 * 全部来源合成一张表、套上用户改动：同名的以先来的为准（自带的在前），免得插件带一个同名技能把自带的顶掉
 */
export function skillCatalog(sources: SkillSource[], overrides: Record<string, SkillOverride> = {}): EffectiveSkill[] {
  const seen = new Set<string>()
  const out: EffectiveSkill[] = []
  for (const s of sources)
    for (const e of s.entries()) {
      if (seen.has(e.name)) continue
      seen.add(e.name)
      out.push(applyOverride(e, overrides[e.name]))
    }
  return out
}

/** 自带技能的「什么时候用」（拼角色设定时用；插件的由调用方另查） */
export const builtinGuide = (name: string) => BUILTIN_SKILLS.find((s) => s.name === name)?.guide

/** 特化技能扩展的通用技能 */
export const skillBase = (name: string) => BUILTIN_SKILLS.find((s) => s.name === name)?.base

/** 用户设成「每个对话都带」的技能名：当成所有角色的自带技能，每轮放进技能目录 */
export const alwaysSkills = (data: { skills: Record<string, SkillOverride> }) =>
  Object.entries(data.skills)
    .filter(([, o]) => o.always)
    .map(([n]) => n)
    .sort()
