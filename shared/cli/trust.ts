import { z } from 'zod'
import type { CliDefinition } from '../clis.ts'

/**
 * 项目信任（ADR 0050）：有的 CLI 只在用户信任过这个项目之后才读项目里的配置、扩展和 Skill（Pi 1.3 起），
 * 无界面运行时又没法弹窗问，默认按不信任跳过。项目设置里按 CLI 选「跟随 / 信任 / 不信任」，
 * 参数规则里用条件 trust=approve、trust=deny 加参数（Pi：--approve / --no-approve），不按 CLI 名字写分支
 */
export const CliTrust = z.object({
  /** 只在信任后才读的项目文件和目录（相对项目目录），找到了而用户没选过时提示 */
  markers: z.array(z.string().min(1)).min(1),
  /** 同上，但上级目录里的也读（到仓库根目录为止，例如 Pi 的 .agents/skills） */
  upMarkers: z.array(z.string().min(1)).default([]),
  /** 依据（给维护者看，不显示） */
  why: z.string().default(''),
})
export type CliTrust = z.infer<typeof CliTrust>

/** 项目里对某个 CLI 的选择；没写就是跟随 CLI 自己保存的决定 */
export const TrustChoice = z.enum(['approve', 'deny'])
export type TrustChoice = z.infer<typeof TrustChoice>

/** 项目设置里存的：CLI id → 选择（可选：旧数据和直接拼 Project 字面量的地方不用补） */
export const ProjectCliTrust = z.record(z.string(), TrustChoice).optional()

/** 这次执行带不带信任参数：CLI 定义里没写 trust 的一律不带 */
export function trustFor(
  def: Pick<CliDefinition, 'id' | 'trust'>,
  project?: { cliTrust?: Record<string, TrustChoice> },
) {
  return def.trust ? project?.cliTrust?.[def.id] : undefined
}

/**
 * 项目目录和它的各级上级目录，到根目录为止（调用方再按仓库根目录截断）。
 * 纯函数，路径分隔符按传进来的写法认（Windows 的反斜杠也行）
 */
export function trustDirs(dir: string): string[] {
  const out: string[] = []
  let cur = dir.replace(/[\\/]+$/, '')
  while (cur && !out.includes(cur)) {
    out.push(cur)
    const i = Math.max(cur.lastIndexOf('/'), cur.lastIndexOf('\\'))
    if (i <= 0) break
    const up = cur.slice(0, i)
    // Windows 盘符根目录：C: 之后不再往上
    if (/^[a-zA-Z]:$/.test(up)) {
      out.push(`${up}\\`)
      break
    }
    cur = up
  }
  return out
}
