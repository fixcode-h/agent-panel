import type { ConfigFinding } from '@shared/config-scan'
import { json, request } from './api'

/** 配置安全扫描（server/config-scan.ts）：点「这条没问题」后不再出现；scope 是这条发现属于哪个插件、Skill、项目 */
export const configScanApi = {
  ignore: (f: Pick<ConfigFinding, 'rule' | 'file' | 'snippet'>, scope: string) =>
    request<{ ok: true }>(
      '/config-scan/ignore',
      json('POST', { rule: f.rule, file: f.file, snippet: f.snippet, scope }),
    ),
}
