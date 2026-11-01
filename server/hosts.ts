import { isRemoteHostAllowed } from './remote.ts'

/** 本机访问用的主机名 */
export const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/** 去掉端口；IPv6 只留方括号里的部分，没有方括号的裸地址原样返回 */
export const hostOf = (h: string) => {
  const s = h.trim().toLowerCase()
  if (s.startsWith('[')) return s.slice(0, s.indexOf(']') + 1)
  if ((s.match(/:/g) ?? []).length > 1) return s
  return s.split(':')[0]
}

export const isLocalHost = (h: string) => LOCAL_HOSTS.has(hostOf(h))

/**
 * 允许访问的主机名：本机，或者当前外网访问的隧道 / 反向代理地址。
 * 外网访问默认关闭，这时只有本机能用（挡住 DNS 重绑定）。
 */
export const isAllowedHost = (h: string) => isLocalHost(h) || isRemoteHostAllowed(hostOf(h))

/** 外网专用端口（见 remote.ts 的 startExternal）收到的请求在 env 上带这个标记 */
export const EXTERNAL_ENV = 'agentPanelExternal'

/** 这个请求是不是从外网专用端口进来的：是的话一律当外网，必须带访问令牌 */
export const isExternalRequest = (env: unknown) =>
  !!env && typeof env === 'object' && (env as Record<string, unknown>)[EXTERNAL_ENV] === true

/**
 * 请求带的 Origin 能不能放行。外网页面：Origin 必须是本机、当前外网地址，或者和请求的 Host 同源；
 * 外网专用端口进来的只认和 Host 完全同源（含端口），不认本机地址
 */
export function originAllowed(origin: string, host: string, external: boolean) {
  try {
    const from = new URL(origin)
    if (external) return from.host.toLowerCase() === host.trim().toLowerCase()
    return isLocalHost(from.hostname) || from.hostname.toLowerCase() === hostOf(host) || isAllowedHost(from.hostname)
  } catch {
    return false
  }
}
