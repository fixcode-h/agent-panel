import type { TaskMessage } from '../schema.ts'

/**
 * 对话里的放行记录怎么显示（用户 2026-11-26 选的方案 A，B 兜底）：
 * - 已经挂到工具卡片上的（某个 ToolUse.grant.note 指向它）：不再单独显示，看卡片上的小标；
 * - 没挂上的（CLI 没报出工具行、旧版本记的）：同一来源、同一规则、中间只隔着 Agent 回复的连续几条合成一行，放在第一条的位置。
 * 用户自己点的允许 / 拒绝（via user）不合并、不藏，画成「你允许了」那一行。只看结构化字段 grant，不解析文案
 */
export interface GrantNotes {
  /** 不单独显示的放行记录：挂到卡片上的，和被合并进前面那一行的 */
  hidden: Set<string>
  /** 其中挂到卡片上的：对话分段时直接跳过（合并掉的还要留在同一段里，合并行才数得全） */
  tagged: Set<string>
  /** 合并行：第一条的 id → 这一串（含第一条），只有一条的也在里面 */
  runs: Map<string, TaskMessage[]>
}

const memo = new WeakMap<readonly TaskMessage[], GrantNotes>() // 模块状态：按消息数组缓存，数组换了自动失效

const auto = (m: TaskMessage) => m.role === 'system' && !!m.grant && m.grant.via !== 'user'
const sameKind = (a: TaskMessage, b: TaskMessage) =>
  a.grant!.via === b.grant!.via &&
  (a.grant!.rule ?? a.grant!.label) === (b.grant!.rule ?? b.grant!.label) &&
  a.step === b.step

export function grantNotes(msgs: readonly TaskMessage[]): GrantNotes {
  const hit = memo.get(msgs)
  if (hit) return hit
  const tagged = new Set<string>()
  for (const m of msgs) for (const tool of m.tools) if (tool.grant?.note) tagged.add(tool.grant.note)
  const hidden = new Set(tagged)
  const runs = new Map<string, TaskMessage[]>()
  let run: TaskMessage[] | undefined
  for (const m of msgs) {
    if (auto(m) && !tagged.has(m.id)) {
      if (run && sameKind(run[0], m)) {
        run.push(m)
        hidden.add(m.id)
      } else {
        run = [m]
        runs.set(m.id, run)
      }
      continue
    }
    // 中间只隔着 Agent 的回复、挂到卡片上的放行记录时还算连续；用户发话、别的系统消息就断开
    if (m.role === 'agent' || tagged.has(m.id)) continue
    run = undefined
  }
  const out = { hidden, tagged, runs }
  memo.set(msgs, out)
  return out
}

/** 对话里这条放行记录对应的消息（卡片点开时显示规则来源和完整命令） */
export const grantNote = (msgs: readonly TaskMessage[], id: string) => msgs.find((m) => m.id === id && m.grant)
