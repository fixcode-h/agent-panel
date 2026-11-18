import { z } from 'zod'

/**
 * 补排查（设计稿「Bug 模式子对话体验」第 1 节，用户 2026-11-18 定：先不做断点观察）：报告出来以后随时加日志、调试绘制、
 * 其他临时代码，报告不重出、阶段不变。每一次补排查记成一条 BugProbe，存在 task.bug.probes：
 * 不修了、修完收尾、单条撤掉都靠这张清单找到要删的地方，所以要存盘。
 * 加之前和撤之前的文件快照存在对话数据目录（server/tasks/bug-probe.ts），不进任务数据
 */

/** log 补日志；draw 调试绘制；code 其他临时代码（临时改常量、跳过一步，也只能新增带标记的行） */
export const ProbeKind = z.enum(['log', 'draw', 'code'])
export type ProbeKind = z.infer<typeof ProbeKind>

/**
 * adding 窗口开着、这一轮在加；added 加好了、核对通过；bad 核对没过（有没带标记的新行、改了原有的行）；
 * removing 在撤；removed 撤掉了；stuck 撤的时候核对没过
 */
export const ProbeState = z.enum(['adding', 'added', 'bad', 'removing', 'removed', 'stuck'])
export type ProbeState = z.infer<typeof ProbeState>

/** 加在哪：文件、第一行带标记的行号（从 1 起）、加了几行 */
export const ProbeSpot = z.object({
  file: z.string().max(500),
  line: z.number().int().nonnegative(),
  lines: z.number().int().nonnegative(),
})
export type ProbeSpot = z.infer<typeof ProbeSpot>

/**
 * 核对没过的一行：unmarked 新加的行不带标记；changed 改了 / 删了原有的行；left 撤的时候还留着；
 * extra 撤的时候多出来的行；empty 这一轮什么都没加（或没用改文件工具改，面板没拍到快照）
 */
export const ProbeProblem = z.object({
  file: z.string().max(500),
  line: z.number().int().nonnegative(),
  text: z.string().max(300),
  why: z.enum(['unmarked', 'changed', 'left', 'extra', 'empty']),
})
export type ProbeProblem = z.infer<typeof ProbeProblem>

export const BugProbe = z.object({
  /** P1、P2…（论证时的日志是 L1、L2…，在报告的日志计划里） */
  id: z.string().max(10),
  kind: ProbeKind,
  /** 用户写的那句：想看什么 */
  ask: z.string().max(2000),
  at: z.string(),
  /** 用户从调用栈里点选的位置（「S1 CartPage.onDelete（src/CartPage.tsx:90）」）；没点就让它自己定 */
  targets: z.array(z.string().max(300)).max(20).default([]),
  /** 加好后放到用户的工作区（只对开了独立分支的 Git 项目） */
  workspace: z.boolean().default(false),
  /** 要重新编译 / 热重载时提醒用户 */
  remind: z.boolean().default(false),
  state: ProbeState,
  /** 在第几版报告时加的（只用来显示） */
  rev: z.number().int().optional(),
  spots: z.array(ProbeSpot).default([]),
  problems: z.array(ProbeProblem).default([]),
  /** 加好 / 撤掉的时间 */
  doneAt: z.string().optional(),
})
export type BugProbe = z.infer<typeof BugProbe>

/**
 * 复现记录（设计稿 N3）：每次「开始复现 → 取日志」记一条：取的哪个日志文件、新增的是第几行到第几行、
 * 打出来了哪几处（日志里认出的 [排查-…] 标记）。报告和清单都按它显示「打出来了 / 该打没打」
 */
export const BugRepro = z.object({
  id: z.string().max(10),
  at: z.string(),
  path: z.string().max(1000),
  startLine: z.number().int().nonnegative(),
  endLine: z.number().int().nonnegative(),
  related: z.number().int().nonnegative(),
  /** 日志里出现的标记：P3、L1，或论证日志的主题 */
  hits: z.array(z.string().max(60)).max(100).default([]),
})
export type BugRepro = z.infer<typeof BugRepro>

/** 「马上加」的接口参数（POST /tasks/:id/bug-probe） */
export const ProbeStart = z.object({
  kind: ProbeKind,
  ask: z.string().trim().min(1).max(2000),
  targets: z.array(z.string().max(300)).max(20).default([]),
  workspace: z.boolean().default(false),
  remind: z.boolean().default(false),
})
export type ProbeStart = z.input<typeof ProbeStart>

/** 清单上的动作（POST /tasks/:id/bug-probe-action）：remove 撤掉（ids 为空是全部能撤的）；retry 没按规则加的让它照核对结果改 */
export const ProbeAction = z.object({
  action: z.enum(['remove', 'retry']),
  ids: z.array(z.string().max(10)).max(50).default([]),
})
export type ProbeAction = z.input<typeof ProbeAction>
