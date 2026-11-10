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

/** 外网专用端口（见 remote.ts 的 startExternal）收到的请求在 env 上带这个标记 */
export const EXTERNAL_ENV = 'agentPanelExternal'

/** 这个请求是不是从外网专用端口进来的：是的话一律当外网，必须有登录会话（见 guard/gate.ts） */
export const isExternalRequest = (env: unknown) =>
  !!env && typeof env === 'object' && (env as Record<string, unknown>)[EXTERNAL_ENV] === true

/**
 * 外网专用端口前面是不是用户自己的反向代理（custom 方式）：只有这时转发头（X-Forwarded-For 等）才是反代写的。
 * frp 是 TCP 直通，frpc 在本机连进来，对端永远是 127.0.0.1，请求头全由外网访问者自己写，不能信
 */
export const FORWARDED_ENV = 'agentPanelForwarded'

export const trustsForwarded = (env: unknown) =>
  !!env && typeof env === 'object' && (env as Record<string, unknown>)[FORWARDED_ENV] === true

/**
 * 主端口（只给本机用）的请求带的 Origin 能不能放行：只认本机页面。
 * 外网专用端口的来源检查见 guard/gate.ts 的 sameSite（反代常改写 Host，要按访问地址比）
 */
export function originAllowed(origin: string) {
  try {
    return isLocalHost(new URL(origin).hostname)
  } catch {
    return false
  }
}
