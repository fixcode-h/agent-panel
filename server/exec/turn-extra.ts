import path from 'node:path'
import type { TurnExtra } from '../../shared/done-evidence.ts'
import { inputIndex } from '../../shared/end-turn.ts'
import type { Task } from '../../shared/schema.ts'
import { pluginExtra } from '../plugins/effects.ts'
import { peekTurnFiles } from '../turn/changes.ts'

/**
 * end_turn(done) 时现取的完成依据补充材料（shared/done-evidence.ts 的 TurnExtra），工具调用记录之外的两份：
 * - 插件工具按声明报的改动和验证（server/plugins/effects.ts），一直取：完成依据卡片上要看得见；
 * - 打开了验证门禁时，再取这一轮的工作区快照差（server/turn/changes.ts）：用 sed、脚本、代码生成改的文件调用里看不出来，
 *   不补的话门禁以为没改代码直接放行。拍快照有开销，没开门禁时只记工具调用点名的
 */
export async function turnExtra(task: Pick<Task, 'id' | 'messages'>, cwd: string, gate: boolean): Promise<TurnExtra> {
  const msgs = task.messages ?? []
  const i = inputIndex(msgs)
  const since = i >= 0 ? msgs[i].at : ''
  const plugin = pluginExtra(task.id, since)
  if (!gate) return plugin
  const shell = await peekTurnFiles(task.id).catch(() => [])
  // 工具调用点名过的文件（可能写成绝对路径）不重复列
  const named = new Set<string>()
  for (const m of msgs.slice(i + 1))
    for (const x of m.tools ?? []) if (x.kind === 'edit' && x.label.trim()) named.add(path.resolve(cwd, x.label.trim()))
  const files = [...(plugin.files ?? [])]
  for (const f of shell) if (!named.has(path.resolve(cwd, f)) && !files.includes(f)) files.push(f)
  return { ...plugin, files }
}
