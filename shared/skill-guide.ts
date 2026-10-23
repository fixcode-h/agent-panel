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
  'ue-project-structure': 'UE 项目的结构、模块与插件、UHT/UBT 编译、PIE 与自动化测试、Cook、资产规则',
  'project-testing': '需要跑测试、决定测什么、补回归、写验收证据时',
  brainstorming: '需求或方案还不清楚，要先澄清意图、比较方案、取得确认时',
  grilling: '要在动手前压测设计树、逐轮追问决策时',
  openspec: '按 OpenSpec 流程写 proposal / specs / design / tasks 和验收归档时',
  'task-records': '任务较大、需要 tasks / design / acceptance / handoff 记录和跨会话恢复时',
  'test-driven-development': '写新功能或修 Bug，要先写失败的测试再实现时',
  'systematic-debugging': '遇到 Bug、测试失败或意外行为，要先找根因再改时',
  'verification-before-completion': '准备宣布完成、提交或创建 PR 之前，要先跑验证拿新鲜证据时',
  'software-architecture-design': '设计或评审项目、子系统、框架架构时',
  'cpp-code-style': '写或改 C++ / UE C++ 代码时',
  'lua-code-style': '写或改 Lua 代码时',
  'lua-luac-compiler': '把 Lua 编译成 luac 或排查 Lua 字节码构建时',
  'ue-multi-agent-coordination': 'UE 项目里多个 Agent 并行、要避开编辑器、编译和缓存冲突时',
  blender: '用无头 Blender 建模、检查、多视角截图或导出 FBX 时',
  'blender-model-animation-workflow': '制作可拆分的 Blender 模型和循环动画时',
}

/** 提示词里的一行：`- \`名字\`：什么时候用` */
export function skillLine(name: string) {
  const guide = GUIDE[name]
  return guide ? `- \`${name}\`：${guide}` : `- \`${name}\``
}

/** 这个技能有没有写触发说明（界面提示用） */
export const hasSkillGuide = (name: string) => !!GUIDE[name]
