/**
 * 需求原话对照表的一条（2026-11-26 复盘 §5-1）：识别需求的节点把用户原话拆成一条条，
 * 后面设计、实现、评审、测试各节点逐条标「落地 / 延期 / 不做」，界面上看得出哪条还没落地。
 * 只放结构（schema.ts 的 TaskRun 引用它），读写和提示词在 ./needs.ts
 */
import { z } from 'zod'

export const NEED_STATES = ['open', 'done', 'deferred', 'dropped'] as const
export const NeedState = z.enum(NEED_STATES)
export type NeedState = z.infer<typeof NeedState>

/** 某个节点对这条需求的一次标记：最后一次就是现在的状态 */
export const NeedMark = z.object({
  /** 标记的节点标题（界面上直接显示） */
  by: z.string().default(''),
  state: NeedState,
  /** 落地写在哪 / 证据；延期、不做写理由 */
  note: z.string().default(''),
  at: z.string().default(''),
})
export type NeedMark = z.infer<typeof NeedMark>

export const NeedItem = z.object({
  /** N1、N2…，各节点按它引用 */
  id: z.string(),
  /** 用户的说法，一句话 */
  text: z.string(),
  /** 拆出这条的节点 */
  by: z.string().default(''),
  marks: z.array(NeedMark).default([]),
})
export type NeedItem = z.infer<typeof NeedItem>
