/**
 * 技能重复读取守卫（2026-11-26 复盘 §5-6「技能读取去重」）：同一个会话里，已经完整读过的技能文件内容没变、
 * 也没压缩过上下文时再整份读一遍，拒绝一次并说明内容还在上下文里。
 *
 * 实跑里设计、实现节点各把 openspec 的 SKILL.md 读了两遍：一遍读项目里的 skills/openspec/，一遍读装进 CLI 的
 * skills/workflow/openspec/，路径不同、内容一样。所以按内容（哈希）认，不按路径认。
 * 只管技能文件（SKILL.md 和技能目录下的 .md）：普通源码改了又读是正常的，不拦。
 * 不同节点、子任务是各自的会话，各自要读，不算重复：记录挂在这一次调用的钩子上（dispatch 每次启动 CLI 建一份），
 * 跟着会话走；续接到新进程时重新记，最多放过一次重复。模型坚持要再读（被拦后又读同一份）就放行
 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import type { HookFacts } from '../../shared/hooks/index.ts'

/** 太大的不算技能文件，也不值得为它读盘算哈希 */
const MAX_BYTES = 256 * 1024

/** 技能文件：SKILL.md，或某个 skills 目录下的 Markdown */
export function isSkillFile(p: string): boolean {
  const f = p.replaceAll('\\', '/')
  return /(^|\/)SKILL\.md$/i.test(f) || (/(^|\/)skills\//i.test(f) && /\.md$/i.test(f))
}

function digest(abs: string): string {
  try {
    if (statSync(abs).size > MAX_BYTES) return ''
    return createHash('sha1').update(readFileSync(abs)).digest('hex')
  } catch {
    return ''
  }
}

export interface SkillRereadGuard {
  /** 工具前：要拦时返回交给模型的原因，放行返回空串 */
  before: (cwd: string, facts: HookFacts) => string
  /** 上下文压缩了：之前读进来的已经不在了，记录清空 */
  restored: () => void
}

export function skillRereadGuard(): SkillRereadGuard {
  /** 内容哈希 → 第一次读的路径 */
  const seen = new Map<string, string>()
  /** 拦过一次的内容：再读就放行 */
  const denied = new Set<string>()
  return {
    before(cwd, facts) {
      const tool = facts.tool
      // 带了分段参数的是只读一段，不算整份重复
      if (!tool || tool.kind !== 'read' || tool.ranged || !tool.path || !isSkillFile(tool.path)) return ''
      const abs = path.resolve(cwd, tool.path)
      const h = digest(abs)
      if (!h || denied.has(h)) return ''
      const first = seen.get(h)
      if (!first) {
        seen.set(h, abs)
        return ''
      }
      denied.add(h)
      const rel = (p: string) => {
        const r = path.relative(cwd, p)
        return (r.startsWith('..') || path.isAbsolute(r) ? p : r).replaceAll('\\', '/')
      }
      const where = first === abs ? '这个文件' : `${rel(first)}（和 ${rel(abs)} 内容一样，是同一份技能的另一处副本）`
      return `【面板】${where}这一会话已经完整读过，之后没改过、也没压缩上下文，内容还在上面，不用再读。要找某一条就在上面翻；只想看其中一段就带 offset / limit 读。确实要整份重读就再读一次，面板不再拦。`
    },
    restored() {
      seen.clear()
      denied.clear()
    },
  }
}
