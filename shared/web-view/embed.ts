/**
 * 外部网页能不能嵌进面板的 iframe：只看对方的响应头。
 * 浏览器里的 JS 看不出 iframe 被拒（被拒的子框架照样触发 load），所以由服务端预检、演示后端用同一份判断。
 */
import { t } from '../i18n.ts'

export interface HeaderBag {
  get(name: string): string | null
}

export interface EmbedVerdict {
  embeddable: boolean
  reason?: string
}

/**
 * CSP 的 frame-ancestors：只有写了 * 才放面板嵌（面板的源是 127.0.0.1 或外网访问的域名，对方不会列出来）。
 * 多条 CSP 头逗号拼在一起时任何一条拒绝就算拒绝
 */
function frameAncestors(csp: string): string | null {
  for (const policy of csp.split(',')) {
    for (const part of policy.split(';')) {
      const [name, ...values] = part.trim().split(/\s+/)
      if (name?.toLowerCase() !== 'frame-ancestors') continue
      const list = values.map((v) => v.toLowerCase())
      if (!list.includes('*')) return list.join(' ') || "'none'"
    }
  }
  return null
}

export function embedVerdict(headers: HeaderBag): EmbedVerdict {
  const xfo = (headers.get('x-frame-options') ?? '').trim().toUpperCase()
  if (xfo === 'DENY' || xfo === 'SAMEORIGIN')
    return { embeddable: false, reason: t('对方设置了 X-Frame-Options: {v}，不允许被别的网页嵌入', { v: xfo }) }
  const fa = frameAncestors(headers.get('content-security-policy') ?? '')
  if (fa) return { embeddable: false, reason: t('对方的内容安全策略只允许 {v} 嵌入', { v: fa }) }
  return { embeddable: true }
}

/** 只开 http / https：javascript:、file:、data: 这类不进 iframe */
export function webUrlOf(raw: string): URL | null {
  const text = raw.trim()
  if (!text) return null
  // 地址栏里只写了域名（example.com/a）时补上 https://；本机地址（localhost:5173）多半是开发服务，补 http://。
  // 「localhost:5173」本身也长得像「协议:」，所以只认带 // 的和几个明确的伪协议
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(text)
  const withScheme =
    /^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^(javascript|data|file|blob|vbscript|about|mailto):/i.test(text)
      ? text
      : `${local ? 'http' : 'https'}://${text}`
  try {
    const u = new URL(withScheme)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null
  } catch {
    return null
  }
}
