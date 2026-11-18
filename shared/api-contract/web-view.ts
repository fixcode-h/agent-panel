/**
 * 网页页签的接口契约（写法见 ./define.ts，设计稿「GitHub 项目一键变插件与网页页签」第 6 节）。
 *
 * - file：本机文件换成沙箱源上的地址（带短时令牌）。对话目录、项目目录、文档根、插件目录、对话附件里的文件，
 *   和这个对话的 Agent 在项目外写出的文件直接发；别处的先回 confirm，用户点「仍要打开」再带 force 取。
 * - probe：外部网址能不能嵌进 iframe（服务端看响应头，浏览器里的 JS 看不出被拒）。
 * - reader：嵌不进来的网页取正文给阅读模式，回的是 Markdown，界面用对话同一套渲染（不把对方的 HTML 塞进页面）。
 */
import { z } from 'zod'
import { endpoint } from './define.ts'

export const WebFileInput = z.object({
  /** 绝对路径，或相对对话工作目录的路径；给了 plugin 时是相对插件目录（或托管进程根地址）的路径 */
  path: z.string(),
  taskId: z.string().optional(),
  projectId: z.string().optional(),
  /** 插件包里的文件、插件托管进程的页面（插件接口 11 的 webPages） */
  plugin: z.string().optional(),
  /** 给了就是插件的托管进程：没起就起，回它在本机的地址 */
  service: z.string().optional(),
  /** 用户点了「仍要打开」：不在常用目录里的文件也按它所在的目录发 */
  force: z.boolean().optional(),
})
export const WebFile = z.object({
  /** 沙箱源上的地址：令牌只认这个文件所在的目录，过期后要重新取。托管进程是它自己的本机地址 */
  url: z.string(),
  /** 网页的 <title>（服务端读文件开头），没有时是文件名 */
  title: z.string(),
  size: z.number(),
  /** 文件不在对话、项目、文档、插件目录里，也不是这个对话写出的：url 为空，界面显示这句话和「仍要打开」 */
  confirm: z.string().optional(),
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
