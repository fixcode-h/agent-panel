/**
 * 代转调用的 MCP 工具：服务只露一个通用入口，真正执行的工具名写在参数里。
 * 例如 JetBrains IDE 的 MCP 服务开了「Router-only」后，别的工具都藏起来，只能经 `execute_tool` 调，
 * 参数 `command` 是「工具名 参数…」的一行命令。对话里的工具行如果只写 execute_tool，十行都一个样、看不出在做什么，
 * 所以按参数里的工具名显示（中文名照常查 toolTitle），标签显示真正的参数。
 */
const PROXY = /^(?:execute|call|invoke|run|use)_tool$/i
/** 一行命令开头的工具名 */
const HEAD = /^\s*([A-Za-z_][\w.-]*)(?:\s+([\s\S]*))?$/

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/** 参数里可能放子工具参数的几个键：对象取第一个字符串值，字符串原样 */
function innerArg(a: Record<string, unknown>): string | undefined {
  for (const k of ['arguments', 'args', 'params', 'input']) {
    const v = a[k]
    const s = str(v)
    if (s) return s
    if (v && typeof v === 'object') {
      const first = Object.values(v).find((x) => str(x))
      if (first) return str(first)
    }
  }
  return undefined
}

/**
 * 是代转工具就返回真正的工具名和要显示的参数；不是、或参数里认不出工具名返回 undefined（调用方照原样显示）
 */
export function proxiedTool(tool: string, args: Record<string, unknown>): { tool: string; arg?: string } | undefined {
  if (!PROXY.test(tool)) return undefined
  const cmd = str(args.command)
  if (cmd) {
    const m = HEAD.exec(cmd)
    if (m) return { tool: m[1], ...(str(m[2]) && { arg: str(m[2]) }) }
  }
  const name = str(args.tool_name) ?? str(args.toolName) ?? str(args.tool) ?? str(args.name)
  if (!name || !/^[A-Za-z_][\w.-]*$/.test(name)) return undefined
  const arg = innerArg(args)
  return { tool: name, ...(arg && { arg }) }
}
