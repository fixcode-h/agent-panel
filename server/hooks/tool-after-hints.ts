/**
 * 工具后的两条内置提醒（只补一句说明，不拦）：
 * - 原地打转（loop-hint）：同一条命令连续失败到设置的次数；
 * - 参数传错（arg-table-hint，A2）：MCP 工具报参数错时，把这个工具真实的参数表补给模型。
 *
 * 从 dispatch.ts 的 hookOptions 挪出来：那个函数已经很长，新提醒写成独立函数、入参写清楚要什么（docs/lessons/structure.md）。
 * 只看工具调用的事实（工具名、参数、输出、是不是失败），不看模型回复的文字（ADR 0041、0049）。
 */
import type { HookFacts } from '../../shared/hooks/index.ts'
import { argErrorIn } from '../../shared/tool-failures.ts'
import {
  paramTableText,
  resolveMcpTool,
  type KnownServer,
  type ParamBrief,
} from '../../shared/mcp-catalog/tool-params.ts'
import { taskMap } from '../runtime/task-state.ts'

/** 原地打转提醒：每个对话里每条命令连续失败了几次（成功一次就清零） */
const fails = taskMap<Map<string, number>>('hooks.tool-after-hints 命令连续失败') // 运行时（task-state 登记，对话删掉时跟着清）：「说过一次」的记录，重启后最多再提醒一次
/** 参数传错提醒：每个对话里推过参数表的工具（服务/工具），同一个工具一个对话只推一次 */
const argHinted = taskMap<Set<string>>('hooks.tool-after-hints 参数表推过') // 运行时（task-state 登记，对话删掉时跟着清）：「说过一次」的记录，重启后最多再提醒一次

/** 原地打转：同一条 shell 命令连续失败到 times 次时补一句；CLI 报不出失败（failed 为 undefined）的不算 */
export function loopHint(taskId: string, facts: HookFacts, times: number): string {
  const tool = facts.tool
  if (!tool || tool.kind !== 'shell' || tool.result?.failed === undefined) return ''
  const key = String(tool.input.command ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!key) return ''
  const mine = fails.get(taskId) ?? new Map<string, number>()
  fails.set(taskId, mine)
  if (!tool.result.failed) {
    mine.delete(key)
    return ''
  }
  const n = (mine.get(key) ?? 0) + 1
  mine.set(key, n)
  if (n !== Math.max(1, times)) return ''
  return `【面板】这条命令已经连续失败 ${n} 次了：${key.slice(0, 120)}。先停下来想清楚原因，换个思路（看报错原文、查配置、缩小范围）；确实卡住了就说明卡在哪、需要什么。`
}

/** 参数传错提醒要的外部数据：缓存里问过的服务，和某个工具的参数表（都从 mcp-catalog/external-titles.ts 来） */
export interface ArgHintDeps {
  servers: () => Promise<KnownServer[]>
  params: (server: string, tool: string) => Promise<ParamBrief[] | undefined>
}

/**
 * 参数传错：别家 MCP 工具（不是面板自己的、不是读写跑命令）的结果按报错匹配表（shared/tool-failures.ts 的 ARG_ERROR_RULES）
 * 认出是参数错时，把缓存里这个工具真实的参数表补给模型，让它照表改、不要换个值原样再试。
 * 缓存里没有参数表（还没问过这个服务）时也提醒，改成让它照报错列出的参数改、先加载工具说明。
 * CLI 报得出成功的（failed === false）不看：成功结果里出现「unknown parameter」这类字样多半是查到的内容
 */
export async function argHint(taskId: string, facts: HookFacts, deps: ArgHintDeps): Promise<string> {
  const tool = facts.tool
  if (!tool || tool.kind !== 'any' || tool.panel || !tool.result || tool.result.failed === false) return ''
  if (!argErrorIn(tool.result.output)) return ''
  const hit = resolveMcpTool(tool.name, tool.input, await deps.servers())
  const key = hit ? `${hit.server}/${hit.tool}` : tool.name
  const done = argHinted.get(taskId) ?? new Set<string>()
  argHinted.set(taskId, done)
  if (done.has(key)) return ''
  done.add(key)
  const params = hit && (await deps.params(hit.server, hit.tool))
  const name = hit ? `${hit.server} 服务的 \`${hit.tool}\`` : `\`${tool.name}\``
  const keep = '照它改参数再调，不要换个值原样再试，也不要把别的工具的参数（比如 IDE 自带工具的 projectPath）照搬过来。'
  if (params)
    return `【面板】${name} 报参数不对。它真实的参数表（服务自己报的）：${paramTableText(params)}。${keep}${hit?.tool !== tool.name && hit?.tool ? `经 execute_tool 转调时 command 写成「${hit.tool} --参数名 值」。` : ''}`
  return `【面板】${name} 报参数不对：照报错里列出的可用参数改；看不到它的参数表的，先加载这个工具的说明再调。${keep}`
}
