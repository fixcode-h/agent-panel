/** 外部访问：状态、重新连接、frp 一键配置和连接测试、Tailscale 检测、访问密码和登录的设备。从 api.ts 拆出（api.ts 到了行数上限），api 里展开引入 */
import type { Settings } from '@shared/schema'
import type { FrpTestStep, GuardState, RemoteAccessStatus } from '@shared/remote'
import { json, request } from './api'

export const remoteApi = {
  remoteStatus: () => request<RemoteAccessStatus>('/remote/status'),
  remoteRestart: () => request<RemoteAccessStatus>('/remote/restart', { method: 'POST' }),
  /** 一键配置云服务器（frp）：密码只随这次请求发给本机服务，不保存 */
  remoteDeploy: (body: {
    server: string
    sshPort: number
    sshUser: string
    password: string
    bindPort: number
    remotePort: number
    rangeStart: number
    rangeEnd: number
  }) =>
    request<{ remoteAccess: Settings['remoteAccess']; status: RemoteAccessStatus }>(
      '/remote/frp/deploy',
      json('POST', body),
    ),

  /** frp 连接测试：从本机逐段试到「经云服务器打开面板」 */
  remoteFrpTest: () => request<FrpTestStep[]>('/remote/frp/test', { method: 'POST' }),
  remoteTailscaleCheck: () => request<RemoteAccessStatus>('/remote/tailscale/check', { method: 'POST' }),
  /** 外网访问密码和登录的设备 */
  guardState: () => request<GuardState>('/remote/guard/state'),
  guardPassword: (next: string, current = '') =>
    request<{ ok: true }>('/remote/guard/password', json('POST', { current, next })),
  guardKick: (id: string) => request<{ ok: true }>(`/remote/guard/sessions/${id}`, { method: 'DELETE' }),
  guardLogoutAll: () => request<{ ok: true }>('/remote/guard/logout-all', json('POST', {})),
}
