/**
 * scripts/lib/source-loc.mjs 的类型声明：vite.config.ts 会 import 它（给原生标签写源码位置），
 * 脚本本身是 .mjs（单元测试直接由 node 跑），所以类型单独写这一份。
 */
import type { Plugin } from 'vite'

export declare function addSourceLoc(code: string, rel: string, filename?: string): string | null
export declare function sourceLoc(srcDir: string): Plugin
