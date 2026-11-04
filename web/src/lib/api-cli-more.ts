import { request } from './api'

/**
 * CLI 的项目信任、插件市场、CLI 自己的配置项（ADR 0050）。单独一个文件：api.ts 到了行数上限
 */
export const cliMoreApi = {
  /** 项目里有哪些 CLI 只在信任后才读的文件（CLI id → 找到的），见 server/cli-trust-api.ts */
  projectTrust: (projectId: string) => request<Record<string, string[]>>(`/project-trust/${projectId}`),
}
