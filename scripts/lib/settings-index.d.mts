/**
 * scripts/lib/settings-index.mjs 的类型声明：vite.config.ts 会 import 它（生成设置页搜索的索引），
 * 脚本本身是 .mjs（单元测试直接由 node 跑），所以类型单独写这一份。
 */
import type { Plugin } from 'vite'
import type { SettingsEntry } from '../../web/src/lib/settings-search'

export declare function settingsSourceFiles(root: string): string[]
export declare function extractSettingsIndex(files: Record<string, string>): SettingsEntry[]
export declare function buildSettingsIndex(root: string): SettingsEntry[]
export declare function settingsIndex(root: string): Plugin
