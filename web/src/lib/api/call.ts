/**
 * 按契约调接口（shared/api-contract/）：地址、方法、请求体类型和返回类型都从契约来，
 * 改了服务端的契约，这里的调用方在编译期就会报错，不用等截图碰巧看出来。
 * 演示版照样经 request() 交给浏览器里的模拟后端。
 */
import type { BodyOf, Endpoint, PathParams, Query, ResOf } from '@shared/api-contract/define'
import { urlOf } from '@shared/api-contract/define'
import { json, request } from '../api'

type ParamsPart<E extends Endpoint> = keyof PathParams<E['path']> extends never
  ? { params?: undefined }
  : { params: PathParams<E['path']> }
type BodyPart<E extends Endpoint> = E['body'] extends object ? { body: BodyOf<E> } : { body?: undefined }
type Opts<E extends Endpoint> = ParamsPart<E> & BodyPart<E> & { query?: Query }
/** 没有路径参数和请求体的接口可以只传契约 */
type Args<E extends Endpoint> = Record<never, never> extends Opts<E> ? [opts?: Opts<E>] : [opts: Opts<E>]

export function call<E extends Endpoint>(ep: E, ...[opts]: Args<E>): Promise<ResOf<E>> {
  const o = (opts ?? {}) as { params?: Record<string, string>; body?: unknown; query?: Query }
  const url = urlOf(ep.path, o.params, o.query)
  if (ep.method === 'GET') return request<ResOf<E>>(url)
  // 有请求体的接口总是发 JSON；DELETE 这类没有请求体的只带方法
  return request<ResOf<E>>(url, ep.body ? json(ep.method, o.body ?? {}) : { method: ep.method })
}
