/**
 * 面板项目对应的 JetBrains IDE 项目路径：Agent 调 IDE 的 MCP 工具报「定不了项目」时，工具后提醒按工作目录从报错里的
 * 已开项目挑出来（shared/mcp-catalog/ide-project.ts），记在这里；之后每轮的「IDE 服务的调用规矩」直接写出这个路径，
 * Agent 第一次调就带上 projectPath，不用再失败一次。
 *
 * 只在内存里：丢了（面板重启）下一次报错时再挑一遍，不落盘。
 */

// 模块状态：缓存，面板项目 id + IDE 服务名 → IDE 项目路径，丢了下次报错再挑
const learned = new Map<string, string>()

const key = (projectId: string, server: string) => `${projectId}\n${server}`

export function rememberIdeProject(projectId: string, server: string, path: string) {
  if (projectId && server && path) learned.set(key(projectId, server), path)
}

export function ideProjectOf(projectId: string | undefined, server: string): string | undefined {
  return projectId ? learned.get(key(projectId, server)) : undefined
}

/** 挑过的路径 Agent 带上了还是对不上（IDE 关了那个项目）：忘掉，免得提示词里一直写着错的 */
export function forgetIdeProject(projectId: string, server: string) {
  learned.delete(key(projectId, server))
}
