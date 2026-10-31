import type { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { t } from '../shared/i18n.ts'

/** 所有响应都要有的防护：防嵌套、请求体上限。从 index.ts 拆出来，那边只留路由装配 */
export function installHttpGuards(app: Hono) {
  // 不许被别的网页用 iframe 嵌进去：令牌默认关着时，任意网页都能嵌入面板诱导用户点「运行」「删除」（点击劫持）
  app.use('*', async (c, next) => {
    await next()
    c.header('X-Frame-Options', 'DENY')
    c.header('Content-Security-Policy', "frame-ancestors 'none'")
    c.header('X-Content-Type-Options', 'nosniff')
  })
  // 请求体上限：以前整段读进内存再检查，超大的请求能把面板内存吃光。
  // 附件上传 base64 后最大约 67MB；数据备份、对话导入可能很大，单独放宽；扩展和 MCP 只传图片和短文本
  const MB = 1024 * 1024
  const limitFor = (p: string) =>
    p === '/api/data/import' || p === '/api/tasks/import'
      ? 2048 * MB
      : p.startsWith('/api/bridge/')
        ? 40 * MB
        : p.startsWith('/api/mcp/') || p.startsWith('/api/web-search/')
          ? 16 * MB
          : 100 * MB
  app.use('/api/*', (c, next) =>
    bodyLimit({
      maxSize: limitFor(c.req.path),
      onError: (cc) =>
        cc.json({ error: t('请求太大，超过了 {mb} MB', { mb: Math.round(limitFor(cc.req.path) / MB) }) }, 413),
    })(c, next),
  )
}
