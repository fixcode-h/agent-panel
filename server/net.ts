/**
 * 访问外网（GitHub）的请求：Node 自带的 fetch 不走代理，国内访问 GitHub 常常连不上。
 * 设置里填了代理就用它，没填时看环境变量 HTTPS_PROXY / HTTP_PROXY。
 */
import { ProxyAgent, fetch as proxyFetch, type Dispatcher } from 'undici'
import { getSettings } from './settings.ts'
import { t } from '../shared/i18n.ts'

let agent: { key: string; dispatcher: Dispatcher } | undefined

const ENV_PROXY = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']

/** 环境变量 NO_PROXY 里列出的主机（或它的子域名）不走代理；* 表示都不走 */
function noProxy(url: string) {
  const host = new URL(url).hostname.toLowerCase()
  return (process.env.NO_PROXY ?? process.env.no_proxy ?? '')
    .split(',')
    .map((x) =>
      x
        .trim()
        .toLowerCase()
        .replace(/:\d+$/, '')
        .replace(/^\*?\./, ''),
    )
    .filter(Boolean)
    .some((x) => x === '*' || host === x || host.endsWith(`.${x}`))
}

/** 设置里的代理优先；没填时用环境变量（这时 NO_PROXY 也照常生效）。本机地址不走代理 */
async function proxyFor(url: string) {
  if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(url)) return undefined
  const set = (await getSettings()).proxy.trim()
  const env = ENV_PROXY.map((k) => process.env[k]).find(Boolean) ?? ''
  if (!set && (!env || noProxy(url))) return undefined
  // 不用 undici 的 EnvHttpProxyAgent：它还是实验功能，每次启动都会打一条警告
  const key = set || env
  if (agent?.key !== key) {
    void agent?.dispatcher.close()
    agent = { key, dispatcher: new ProxyAgent(key) }
  }
  // 报错里显示代理地址时去掉里面的账号密码
  return { shown: (set || env).replace(/\/\/[^/@]*@/, '//'), dispatcher: agent.dispatcher }
}

/** 和 fetch 一样用；有代理时经过代理 */
export async function netFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const proxy = await proxyFor(url)
  try {
    if (!proxy) return await fetch(url, init)
    return (await proxyFetch(url, { ...(init as object), dispatcher: proxy.dispatcher })) as unknown as Response
  } catch (e) {
    throw new Error(netError(e, proxy?.shown), { cause: e })
  }
}

/** 把「fetch failed」换成能看懂的原因：真正的原因在 cause 里（连不上、超时、DNS 解析失败…） */
export function netError(e: unknown, proxy = ''): string {
  const err = e as Error & { cause?: { code?: string; message?: string } }
  const code = err.cause?.code ?? (err as { code?: string }).code ?? ''
  const why =
    err.name === 'TimeoutError' || /TIMEOUT/i.test(code)
      ? t('连接超时')
      : code === 'ENOTFOUND' || code === 'EAI_AGAIN'
        ? t('域名解析失败')
        : code === 'ECONNREFUSED'
          ? t('连接被拒绝')
          : code === 'ECONNRESET'
            ? t('连接被重置')
            : /certificate|CERT/i.test(code + (err.cause?.message ?? ''))
              ? t('证书校验失败')
              : ''
  const detail = [why, code, err.cause?.message && err.cause.message !== err.message ? err.cause.message : '']
    .filter(Boolean)
    .join(' · ')
  const base = detail ? `${err.message}（${detail}）` : err.message
  return proxy
    ? t('{error}。当前使用代理 {proxy}，请确认代理能访问 GitHub。', { error: base, proxy })
    : t('{error}。访问不了 GitHub 时，可以在「设置 · 常规 · 网络代理」里填写本机代理。', { error: base })
}
