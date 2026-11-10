import { Box, Gamepad2, Puzzle, type LucideIcon } from 'lucide-react'
import { AGENT_ICONS } from '@/lib/agent-icons'

/** 清单里的 icon：角色图标之外再认几个插件常用的；不认识的用拼图（设置左栏和插件页共用，单独成文件免得左栏拖进插件页的依赖） */
const EXTRA_ICONS: Record<string, LucideIcon> = { box: Box, gamepad: Gamepad2, puzzle: Puzzle }
export const pluginIcon = (name: string) => EXTRA_ICONS[name] ?? AGENT_ICONS.find((i) => i.id === name)?.icon ?? Puzzle
