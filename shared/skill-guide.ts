/**
 * 技能的触发说明：交给 CLI 的提示词里，每个技能写一句「什么时候用」。
 * 只列名字时模型常常不知道什么时候该读；写清触发条件才会在合适的时机用上。
 *
 * 这里的是内置技能；用户自己装的技能没有说明时只列名字。
 */
const GUIDE: Record<string, string> = {
  'project-vcs': '任务开始时识别 Git / P4 / SVN / 无版本控制，保护已有改动；改完文件后做收尾、合并与工作区清理',
  'project-documentation': '读写项目文档、维护模块 README 和 bugs.md、确定文档根目录时',
  'project-structure': '第一次接触这个项目、需要弄清目录结构、构建命令、测试命令、运行方式时',
  'ue-project-structure':
    'UE 项目在 project-structure 之外的引擎规则：模块与插件、UHT/UBT 编译、自动化测试、Gameplay 框架、资产与 Cook',
  'project-testing': '写新功能或修 Bug 要先写失败的测试、写或改测试、决定跑哪些测试、写验收证据时',
  'coding-standards': '写或改代码、搭新模块时：跟随已有写法、数值和配置不写死、按真实变化留扩展点、交付前自查差异',
  brainstorming: '需求或方案还不清楚，要先澄清意图、比较方案、取得确认时',
  grilling: '要在动手前压测设计树、逐轮追问决策时',
  openspec: '按 OpenSpec 流程写 proposal / specs / design / tasks 和验收归档时',
  'task-records': '任务较大、需要 tasks / design / acceptance / handoff 记录和跨会话恢复时',
  'systematic-debugging': '遇到 Bug、测试失败或意外行为，要先找根因再改时',
  'verification-before-completion': '准备宣布完成、提交或创建 PR 之前，要先跑验证拿新鲜证据时',
  'cpp-code-style': '写或改 C++ / UE C++ 代码时',
  'lua-code-style': '写或改 Lua 代码时',
  blender: '用无头 Blender 建模、检查、多视角截图或导出 FBX 时',
  'blender-model-animation-workflow': '制作可拆分的 Blender 模型和循环动画时',
}

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
}
export const RETIRED_SKILLS = new Set(Object.keys(RETIRED_SKILL_MAP))

/**
 * 特化技能 → 它扩展的通用技能：特化的只补差异，用到它时通用的那份必须一起给，
 * 例如 UE 项目用 ue-project-structure，也要有 project-structure
 */
export const SKILL_BASE: Record<string, string> = {
  'ue-project-structure': 'project-structure',
}

/** 换掉下线的技能名、补上特化技能依赖的通用技能，去重后保持原顺序（通用的排在特化的前面） */
export function resolveSkills(names: string[]) {
  const out: string[] = []
  const add = (n: string) => {
    if (n && !out.includes(n)) out.push(n)
  }
  for (const raw of names) {
    const n = raw in RETIRED_SKILL_MAP ? RETIRED_SKILL_MAP[raw] : raw
    if (!n) continue
    if (SKILL_BASE[n]) add(SKILL_BASE[n])
    add(n)
  }
  return out
}

/** 提示词里的一行：`- \`名字\`：什么时候用` */
export function skillLine(name: string) {
  const guide = GUIDE[name]
  return guide ? `- \`${name}\`：${guide}` : `- \`${name}\``
}

/** 这个技能有没有写触发说明（界面提示用） */
export const hasSkillGuide = (name: string) => !!GUIDE[name]

/**
 * 已下线、又没有接替者的技能名（去重保序）。
 * 这些技能拼提示词时要丢掉（CLI 去找一个不存在的 SKILL.md 只会报错），但报告是给人排查用的，
 * 静默丢掉会让人以为角色本来就没配这个技能，所以报告单独把它标成「已下线」。
 */
export function retiredWithoutSuccessor(names: string[]) {
  return [...new Set(names.filter((n) => n in RETIRED_SKILL_MAP && !RETIRED_SKILL_MAP[n]))]
}
