/**
 * 直接调的自建工具（ADR 0082 第 9 节，用户 2026-11-28「自建工具就是期望像 Agent 内置工具一样调用」）：
 * 每个能用的自建工具在清单里各出一项 tool_<id>，参数 schema 来自工具定义（shared/custom-tools/direct.ts）。
 * 清单随这一轮开始时算好的 o.customTools.tools 走；执行和 custom_tool action=run 是同一条路（callCustom）
 */
import { directId } from '../../shared/custom-tools/direct.ts'
import { callCustom, obj } from './custom-tool.ts'
import type { DynamicTools } from './types.ts'

export const CUSTOM_TOOL_DIRECT: DynamicTools = {
  defs: (o) => o.customTools?.tools ?? [],
  owns: (name) => !!directId(name),
  // 和 custom_tool 一样可能等授权卡和两分钟内的执行
  waits: true,
  call: (o, name, a, signal) => callCustom(o, { action: 'run', id: directId(name), args: obj(a) ?? {} }, signal),
}
