/**
 * scripts/lib/demo-build-info.mjs 的类型声明：vite.config.ts 会 import 它（demo 构建结束时写构建标记），
 * 脚本本身是 .mjs（ui-check 直接由 node 跑），所以类型单独写这一份。
 */
export declare const BUILD_INFO_FILE: string

export interface DemoSourceInfo {
  /** 全量总指纹：源码（含增删文件）有任何变化都会变 */
  hash: string
  /** 每个参与构建的文件：相对仓库根的路径 → 内容短哈希 */
  files: Record<string, string>
}

export type DemoBuildReason = '' | 'missing-dist' | 'missing-info' | 'bad-info' | 'stale'

export interface DemoBuildCheck {
  ok: boolean
  reason: DemoBuildReason
  /** 变了的文件说明（「改动 / 新增 / 删除 + 路径」），ok=true 时为空 */
  changed: string[]
}

export declare function demoSources(root: string): string[]
export declare function demoSourceInfo(root: string): DemoSourceInfo
export declare function writeDemoBuildInfo(root: string, outDir: string): void
export declare function checkDemoBuild(root: string, outDir: string): DemoBuildCheck
export declare function describeDemoBuildProblem(root: string, outDir?: string): string | null
export declare function assertDemoBuildFresh(root: string): void
