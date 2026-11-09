/**
 * Agent 面板改动（不在上游）：上游的工具定义交给 DSH 宿主的 @deepseek-ai/dsh-tools.defineTool 校验后注册。
 * 面板不是 DSH 宿主，工具由面板自己的 MCP 服务暴露（server/plugins/blender/dsh-host.ts），
 * 所以这里原样返回定义，由面板读取 name / description / parameters / execute。
 */
export function defineTool<T>(options: T): T {
  return options
}
