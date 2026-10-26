/**
 * 本机代理的默认值：设置页的占位符 / 说明、CLI 的环境变量示例、自动探测的端口顺序都从这里取。
 * 要换默认端口只改这一处；改完同时检查 `npm run lint`（rules-check 会拦住别处再写的字面量）。
 *
 * 为什么选它：v2rayN 的默认入站端口就是它，而它默认的入站协议是 socks；mixed 入站会落到 10814。
 * 本机只跑纯 socks 的 10808 时，`ProxyAgent` 用不了（它只支持 http/https），探测也会失败，
 * 只能靠用户在设置里填 http 入站端口。国内用 V2Ray / Xray 一类代理软件的人多，Clash 的 7890 仍排在更前。
 */

/** 默认本地代理端口 */
export const DEFAULT_PROXY_PORT = 10808

/** 默认本地代理地址：设置页「网络代理」的占位符、说明里的举例都用它 */
export const DEFAULT_PROXY_URL = `http://127.0.0.1:${DEFAULT_PROXY_PORT}`

/** CLI 设置里环境变量的示例（只是示例，用户按需改） */
export const PROXY_ENV_EXAMPLE = `HTTPS_PROXY=${DEFAULT_PROXY_URL}`

/**
 * 自动探测的本地端口，按常见程度排：Clash / mihomo 的混合端口、v2rayN 的默认入站（上面那个默认端口）、
 * 老版 v2rayN 的 http 入站、Clash 的 socks 口（7891，历史兼容：socks 服务不认 HTTP CONNECT，
 * 探测大概率失败）、Clash Verge Rev 的混合端口（7897，能走 http），以及通用的 1080。
 * 只有前 MAX_LOCAL_PROXIES 个会真正拿来发请求，所以默认端口必须排在前面。
 */
export const LOCAL_PROXY_PORTS = [7890, DEFAULT_PROXY_PORT, 10809, 7891, 7897, 1080]

/** 真正尝试时最多用几个本地端口：再多也只是让没有代理的更新等更久 */
export const MAX_LOCAL_PROXIES = 3
