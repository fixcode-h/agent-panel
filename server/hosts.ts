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
