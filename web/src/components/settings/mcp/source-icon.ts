import { Blocks, PanelsTopLeft, Puzzle, type LucideIcon } from 'lucide-react'

/** 面板自带两个来源的图标（插件的用清单里的 icon，见 plugins/icon.ts） */
export const sourceIcon = (kind: 'panel' | 'app' | 'plugin'): LucideIcon =>
  kind === 'panel' ? PanelsTopLeft : kind === 'app' ? Blocks : Puzzle
