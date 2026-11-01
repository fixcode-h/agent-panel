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
 * 主端口上带了转发头：说明前面有反向代理。nginx 默认把 Host 改成 127.0.0.1:8787，
 * 只看 Host 会把外网请求当成本机、绕过访问令牌，所以带这些头的一律不算本机
 */
export const isForwarded = (header: (name: string) => string | undefined) =>
  ['x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'forwarded', 'cf-connecting-ip'].some((h) => !!header(h))
