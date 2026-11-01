/**
 * shared 能用的全局：浏览器和 Node 20+ 都有的 Web 标准 API，只声明 shared 实际用到的成员。
 *
 * shared 的代码前端、服务端和在线演示都会跑，所以 shared/tsconfig.json 既不带 DOM 也不带 @types/node；
 * 少了这份声明，连 setTimeout、AbortController 都用不了。这里声明的东西两边都必须真的有，
 * 只在一边有的（Buffer、process、node:*、document、window、Element…）不要加进来——
 * 要用就放到 server/ 或 web/，或者像 shared/anim.ts、shared/i18n.ts 那样按结构声明并在运行时判断有没有。
 *
 * 只有 shared 自己的检查会读这个文件；web / server 检查时 shared 的代码用的是它们自己的 DOM / Node 类型。
 */

declare function structuredClone<T>(value: T): T

// 定时器句柄两边类型不同（Node 是 Timeout 对象，浏览器是数字），shared 里只能原样交回 clearTimeout
declare function setTimeout(callback: (...args: never[]) => unknown, ms?: number): unknown
declare function clearTimeout(timer: unknown): void

interface AbortSignal {
  readonly aborted: boolean
  readonly reason: unknown
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void
  removeEventListener(type: 'abort', listener: () => void): void
}
declare class AbortController {
  readonly signal: AbortSignal
  abort(reason?: unknown): void
}

declare class URL {
  constructor(url: string, base?: string)
  readonly protocol: string
  readonly username: string
  readonly password: string
  readonly hostname: string
  readonly pathname: string
}

declare class TextEncoder {
  encode(input?: string): Uint8Array
}

/** fetch 的请求参数：shared 只拼请求、不发，发请求的是服务端和在线演示 */
interface RequestInit {
  method?: string
  headers?: Record<string, string>
  body?: string
}
/** fetch 的响应：shared 只读响应头 */
interface Response {
  readonly headers: { get(name: string): string | null }
}
