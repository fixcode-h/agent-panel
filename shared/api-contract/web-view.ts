/**
 * 网页页签的接口契约（写法见 ./define.ts，设计稿「GitHub 项目一键变插件与网页页签」第 6 节）。
 *
 * - file：本机文件换成沙箱源上的地址（带短时令牌），只发对话目录、项目目录、插件目录、对话附件里的文件。
 * - probe：外部网址能不能嵌进 iframe（服务端看响应头，浏览器里的 JS 看不出被拒）。
 * - reader：嵌不进来的网页取正文给阅读模式，回的是 Markdown，界面用对话同一套渲染（不把对方的 HTML 塞进页面）。
 */
import { z } from 'zod'
import { endpoint } from './define.ts'

export const WebFileInput = z.object({
  /** 绝对路径，或相对对话工作目录的路径 */
  path: z.string().min(1),
  taskId: z.string().optional(),
  projectId: z.string().optional(),
})
export const WebFile = z.object({
  /** 沙箱源上的地址：令牌只认这个文件所在的目录，过期后要重新取 */
  url: z.string(),
  /** 文件名（HTML 的 <title> 由页面自己读不到，页签上先用文件名） */
  title: z.string(),
  size: z.number(),
})

export const WebProbeInput = z.object({ url: z.string().min(1) })
export const WebProbe = z.object({
  embeddable: z.boolean(),
  /** 不能嵌入时的原因，给被拒页显示（例如「对方设置了 X-Frame-Options: DENY」） */
  reason: z.string().optional(),
  /** 跟过跳转之后的地址：iframe 直接开它，少一次跳转 */
  finalUrl: z.string(),
})

export const WebReaderInput = z.object({ url: z.string().min(1) })
export const WebReader = z.object({
  title: z.string(),
  /** 站点名（域名） */
  site: z.string(),
  /** 正文转成的 Markdown */
  markdown: z.string(),
})

export const webViewContract = {
  file: endpoint({ method: 'POST', path: '/web-view/file', body: WebFileInput, res: WebFile }),
  probe: endpoint({ method: 'POST', path: '/web-view/probe', body: WebProbeInput, res: WebProbe }),
  reader: endpoint({ method: 'POST', path: '/web-view/reader', body: WebReaderInput, res: WebReader }),
}

export type WebFileRes = z.infer<typeof WebFile>
export type WebProbeRes = z.infer<typeof WebProbe>
export type WebReaderRes = z.infer<typeof WebReader>
