import type { WebTarget } from '@/lib/web-view/tabs'

/** 清单里的 url 换成网页框的目标：service:<进程>/<路径>、file:<包里的路径>、外部网址 */
export function webPageTarget(plugin: string, url: string): WebTarget {
  const sv = /^service:([a-z][a-z0-9-]*)\/(.*)$/.exec(url)
  if (sv) return { kind: 'plugin-service', plugin, service: sv[1], path: `/${sv[2]}` }
  if (url.startsWith('file:')) return { kind: 'plugin-file', plugin, path: url.slice(5) }
  return { kind: 'url', url }
}
