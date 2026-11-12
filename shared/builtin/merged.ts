import type { ParamValue } from '../schema.ts'

/**
 * 已经合并进其他 Agent 的内置 Agent：本机副本仍然可用（用户的工作流可能还在引用它），
 * 但不再出现在「内置 Agent」里。description 后面会补一句说明，让用户知道去哪找新的。
 */
export const MERGED_AGENTS: Record<string, MergedAgent> = {
  verifier: { into: 'tester', note: '已合并到「测试与验收」' },
  projecttest: { into: 'tester', note: '已合并到「测试与验收」' },
  ueintegrator: { into: 'tester', note: '编译已并入「测试与验收」的项目测试步骤' },
  docs: { into: 'docsync', note: '已合并到「文档同步」，ADR 和 Bug 记录改由参数控制' },
  deliver: { into: 'vcs', note: '已合并到「版本控制」（原「交付员」），推送授权说明也并了进去' },
  // 只读的定位、影响面、UE 侦察、查资料是同一个能力块「调研」，按方向和技术栈区分
  researcher: { into: 'explorer', note: '已合并到「调研」（方向选外部资料）', params: { target: '外部资料' } },
  impact: { into: 'explorer', note: '已合并到「调研」（方向选影响面）', params: { target: '影响面' } },
  uescout: {
    into: 'explorer',
    note: '已合并到「调研」（技术栈选 ue）',
    params: { target: '影响面', stack: 'ue' },
  },
  // 评审改动和复核结论都是「独立找错」，按评审对象区分
  second: { into: 'reviewer', note: '已合并到「评审」（评审对象选方案或结论）', params: { target: '方案或结论' } },
  architect: {
    into: 'analyst',
    note: '已合并到「方案设计」（规模选 architectural）',
    params: { scale: 'architectural' },
  },
  // 修 Bug、查性能和实现都是写代码，按任务区分；原来的「排查方向」换算成任务
  debugger: {
    into: 'developer',
    note: '已合并到「开发」（任务选修 Bug 或性能问题）',
    params: (old) => {
      const { focus, ...rest } = old
      return { ...rest, task: focus === '性能问题' ? '性能问题' : '修 Bug' }
    },
  },
  blenderqa: { into: 'blender', note: '已合并到「Blender 建模」（阶段选质检）', params: { stage: '质检' } },
}

/**
 * 合并掉的 Agent：into 是合并目标的 key；params 是重定向节点时参数怎么换算——
 * 写对象时在原参数上补这几项（覆盖同名的），写函数时按原参数算出新的。
 */
export interface MergedAgent {
  into: string
  note: string
  params?: Record<string, ParamValue> | ((old: Record<string, ParamValue>) => Record<string, ParamValue>)
}

/** 重定向到合并目标时，节点参数换算成目标 Agent 的 */
export function mergedParams(m: MergedAgent, old: Record<string, ParamValue>) {
  if (!m.params) return old
  return typeof m.params === 'function' ? m.params(old) : { ...old, ...m.params }
}
