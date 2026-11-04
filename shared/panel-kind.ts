import { z } from 'zod'

/**
 * 对话消息的 panel 字段：面板推回给 CLI 的消息（后台命令结果、合并编译结果、计划催促、子任务结果）不是用户说的话，
 * 对话里显示成 AI 回复里的一行，点开看全文。child 是子对话交回父对话的回报：
 * 只交给父对话的 AI，界面上不显示（子对话自己的状态图标已经说明做完了，汇报在子对话自己的对话里看）。
 * ask 是子对话请父对话决定的问题：父对话里显示成一张可以直接回答的卡片；
 * note 是执行中用户改设置这类说明，画成回复里的一行，不把回复截成两段；
 * hook 是结束前钩子拦住它、让它在同一轮里接着做的记录（ADR 0049）：只给人看，不交给 CLI（CLI 已经从钩子拿到了）。
 * 从 schema.ts 拆出来：那个文件到了行数上限
 */
export const PanelKind = z.enum(['background', 'build', 'nudge', 'helpers', 'child', 'ask', 'note', 'wrapup', 'hook'])
export type PanelKind = z.infer<typeof PanelKind>
