import { z } from 'zod'

/**
 * 诊断报告的「功能结构」（设计稿 2026-11-18「Bug 模式子对话体验」第 2 节）：调用栈、时序图、类图、架构页四个页签。
 * 调用栈就是档案的 stack；这里只放另外三种和 Agent 选的默认页签。图是 Mermaid 源码（报告里画成图），
 * nodes 把图上的节点对到代码位置，面板交报告时按工作区核对（shared/bug/views.ts）；架构页是 Archify 画的单页 HTML。
 * 单独一个文件：diagnosis-schema.ts 只引用这一个字段，别的功能改那边不碰这里
 */
const str = (max: number) => z.string().max(max).catch('').default('')

/** 四个页签 */
export const VIEW_KINDS = ['stack', 'sequence', 'class', 'page'] as const
export type ViewKind = (typeof VIEW_KINDS)[number]

/** 图上的一个节点对到代码的哪里（参与者、类、消息的发起处）；check 由面板写 */
export const ViewNode = z.object({
  /** 图里的名字：时序图的参与者、类图的类名，要在源码里出现 */
  id: str(80),
  file: str(500),
  line: z.coerce.number().int().positive().optional().catch(undefined),
  /** 那一行附近要找得到的函数名或类名；不写按 id 找 */
  fn: str(200),
  check: z
    .object({ ok: z.boolean().catch(true), why: str(300) })
    .optional()
    .catch(undefined),
})
export type ViewNode = z.infer<typeof ViewNode>

export const ViewDiagram = z.object({
  kind: z.enum(['sequence', 'class']).catch('sequence'),
  title: str(200),
  /** Mermaid 源码：时序图以 sequenceDiagram 开头，类图以 classDiagram 开头 */
  source: str(12000),
  nodes: z.array(ViewNode).max(40).catch([]).default([]),
})
export type ViewDiagram = z.infer<typeof ViewDiagram>

export const BugViews = z.object({
  /** 默认打开哪个页签 */
  pick: z.enum(VIEW_KINDS).catch('stack'),
  /** 为什么选它（报告上「它选的：……」） */
  why: str(300),
  diagrams: z.array(ViewDiagram).max(2).catch([]).default([]),
  /** 架构页：Archify 画好的 HTML 文件（相对项目根），报告上显示成 HTML 卡片 */
  page: z
    .object({ file: str(500), title: str(200) })
    .optional()
    .catch(undefined),
})
export type BugViews = z.infer<typeof BugViews>
