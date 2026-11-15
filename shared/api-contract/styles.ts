/**
 * 风格库和浏览器扩展的接口契约（写法见 ./define.ts；服务端 server/styles.ts、server/browser-ext-routes.ts，
 * 演示 web/src/lib/demo/demo-styles.ts）。浏览器扩展的地址还是以前挂在设计接口下的 /designs/browser，扩展和旧版本认这个地址
 */
import { z } from 'zod'
import type { BrowserStatus } from '../browser-ext.ts'
import { SavedStyle, SavedStyleInput } from '../style-types.ts'
import { endpoint, shaped } from './define.ts'

const Browser = z.object({ browser: z.string().optional() })

export const stylesContract = {
  /** 自己存的在前，内置的（程序自带、只读）在后 */
  list: endpoint({ method: 'GET', path: '/styles', res: z.array(SavedStyle) }),
  /** 请求体的 kind、summary 这些可以不传，服务端按 SavedStyleInput 补默认值 */
  create: endpoint({ method: 'POST', path: '/styles', body: SavedStyleInput, res: SavedStyle }),
  /** 只传要改的字段 */
  update: endpoint({ method: 'PUT', path: '/styles/:id', body: SavedStyleInput.partial(), res: SavedStyle }),
  remove: endpoint({ method: 'DELETE', path: '/styles/:id', res: z.void() }),
}

export const browserExtContract = {
  status: endpoint({
    method: 'GET',
    path: '/designs/browser',
    res: shaped<BrowserStatus>(
      z.looseObject({
        connected: z.boolean(),
        version: z.string(),
        latestVersion: z.string(),
        tabs: z.array(z.unknown()),
        extensionDir: z.string(),
        browsers: z.array(z.object({ id: z.string(), name: z.string() })),
      }),
    ),
  }),
  /** 打开浏览器的扩展页面和扩展所在的文件夹 */
  install: endpoint({
    method: 'POST',
    path: '/designs/browser/install',
    body: Browser,
    res: z.object({ dir: z.string() }),
  }),
  /** auto：扩展自己重新加载了（1.3 起）；false 时打开了扩展页面让用户点刷新 */
  reload: endpoint({
    method: 'POST',
    path: '/designs/browser/reload',
    body: Browser,
    res: z.object({ auto: z.boolean() }),
  }),
  reveal: endpoint({
    method: 'POST',
    path: '/designs/browser/reveal',
    body: z.object({}),
    res: z.object({ ok: z.boolean() }),
  }),
}
