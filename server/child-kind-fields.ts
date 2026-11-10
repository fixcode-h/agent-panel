import type { BugLevel } from '../shared/bug-diagnosis-schema.ts'

/**
 * create_conversation 里说「这个子对话是什么、怎么开」的几个参数：kind、Bug 的级别初判、要不要先开独立分支、
 * 父对话目录里没提交的改动怎么办。从 orch-mcp.ts 拆出来（那个文件到了行数上限），定义和解析放在一起
 */
export const childKindFields = {
  // 必填、二选一：以前只有写了 "bug" 才算，父对话常常漏写，派出去的 Bug 子对话没有交诊断报告的工具，
  // 用户也就看不到审阅弹窗（用户报过）。服务端没写时仍按 task 处理，老的调用照常能用
  kind: {
    type: 'string',
    enum: ['task', 'bug'],
    description:
      '这个子对话是什么：用户报的 Bug（程序哪里坏了、行为不对要修）写 "bug"，子对话修之前先交诊断报告，用户确认了方案才改；其余（新功能、改进、评审或测试里发现的问题）写 "task"',
  },
  level: {
    type: 'string',
    enum: ['quick', 'standard', 'deep'],
    description:
      'kind 是 "bug" 时写级别初判（见「Bug 怎么交」）：quick 快速（报错直指出错行、必现、像是改一个文件，根因和方案合成一次确认）/ standard 标准 / deep 深入。子对话按它走，查下来不符可以改',
  },
  edits: {
    type: 'boolean',
    description:
      '这个子对话一定要改代码（实现、修改、修 Bug）时写 true：面板先开好独立分支再让它开工，省掉它中途换目录重开、重读文件。只调研、评审、回答问题的不写',
  },
  ignore_uncommitted: {
    type: 'boolean',
    description:
      '独立分支从当前提交开出，看不到你目录里没提交的改动，有这类改动时面板会先不开、把清单交回给你。确定子对话不需要它们时写 true；要用到的先提交再派，不要写这个',
  },
}

const LEVELS: BugLevel[] = ['quick', 'standard', 'deep']

/** 把这几个参数换成 createConversation 的 extra：没写、写错的不带 */
export function childKindArgs(a: Record<string, unknown> | undefined) {
  const level = LEVELS.find((x) => x === a?.level)
  return {
    bug: a?.kind === 'bug',
    ...(level && { level }),
    ...(a?.edits === true && { edits: true }),
    ...(a?.ignore_uncommitted === true && { ignoreDirty: true }),
  }
}

/**
 * send_to_conversation 的 kind / level：用户要把已有子对话正在修的问题改走完整 Bug 流程时写 "bug"（ADR 0057）。
 * 不写或写别的照常交消息，不会把已经是 Bug 的子对话降回去
 */
export const upgradeBugFields = {
  kind: {
    type: 'string',
    enum: ['bug'],
    description:
      '用户要把这个子对话正在处理的问题改按完整 Bug 流程修（分阶段交诊断报告、用户确认后才改）时写 "bug"：面板把它标成用户报的 Bug。只是普通交代不写',
  },
  level: {
    ...childKindFields.level,
    description: 'kind 写 "bug" 时可以带级别初判，含义同 create_conversation 的 level',
  },
}

/** send_to_conversation 写了 kind: "bug" 才返回升级参数 */
export function upgradeBugArg(a: Record<string, unknown> | undefined) {
  if (a?.kind !== 'bug') return undefined
  const level = LEVELS.find((x) => x === a?.level)
  return level ? { level } : {}
}
