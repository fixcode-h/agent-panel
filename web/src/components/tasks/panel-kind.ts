import { Bell, Bot, GitMerge, Info, RotateCw, Terminal, Waypoints, Workflow } from 'lucide-react'
import { t } from '@shared/i18n'

// 从 Messages.tsx 拆出来：那个文件到了行数上限。面板行（PanelRow）按 panel 字段取图标和动词

/**
 * 面板推回给 CLI 的消息（后台命令、合并编译、计划催促、子任务的结果）和父子对话之间的往来（子对话状态、收尾请求）：
 * 都画成 AI 回复里的一行，像一次工具调用，点开看全文
 */
export const PANEL_KIND = {
  background: { icon: Terminal, verb: () => t('后台命令') },
  build: { icon: GitMerge, verb: () => t('合并编译') },
  // 计划催促是面板自己的提醒，不是合并编译：用铃铛和强调色浅底，一眼和真正的编译结果分开
  nudge: { icon: Bell, verb: () => t('面板提醒') },
  helpers: { icon: Bot, verb: () => t('子任务结果') },
  child: { icon: Workflow, verb: () => t('子对话状态') },
  wrapup: { icon: GitMerge, verb: () => t('子对话请求') },
  // 名下工作流运行的回信（等决定、待合回、完成、终止）：运行不是子对话，图标和子对话状态分开
  workflow: { icon: Waypoints, verb: () => t('工作流运行') },
  note: { icon: Info, verb: () => t('设置') },
  // 结束前钩子拦住它、在同一轮里接着做（ADR 0049）：普通过程行，不用提醒的强调色，点开看交给它的说明
  hook: { icon: RotateCw, verb: () => t('面板让它接着做') },
} as const

/** 正文开头的【面板】【子对话状态】这类标签是说给 AI 的，界面上第一行不重复它 */
export const LEAD_TAG = /^【[^】]{1,12}】/
