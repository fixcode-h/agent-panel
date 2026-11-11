import { Hono, type Context } from 'hono'
import { extensionSelfReload } from '../shared/browser-ext.ts'
import { t } from '../shared/i18n.ts'
import { askExtensionReload, browserStatus, extensionDir, openExtensionsPage } from './bridge.ts'
import { revealDir, revealItem } from './open.ts'

/**
 * 浏览器扩展（extension/）的接口：连接状态、打开扩展目录、刷新、安装（从 server/index.ts 拆出）。
 * 扩展是面板的（借网页版图片模型出图、抓页面），以前挂在设计接口下，地址 /api/designs/browser 不变。
 */
const bad = (c: Context, error: string) => c.json({ error }, 400)

export const browserExtApi = () =>
  new Hono()
    .get('/', (c) => c.json(browserStatus()))
    .post('/reveal', async (c) => {
      const dir = extensionDir()
      if (!dir) return bad(c, t('没有找到扩展目录'))
      try {
        await revealDir(dir)
      } catch (e) {
        return bad(c, (e as Error).message)
      }
      return c.json({ ok: true, dir })
    })
    // 刷新扩展：1.3 起的扩展自己重新加载；更早的版本做不到，只能打开扩展页面让用户点刷新
    .post('/reload', async (c) => {
      const { browser } = (await c.req.json().catch(() => ({}))) as { browser?: string }
      if (extensionSelfReload(browserStatus().version)) {
        askExtensionReload()
        return c.json({ auto: true })
      }
      try {
        openExtensionsPage(String(browser ?? ''))
      } catch (e) {
        return bad(c, (e as Error).message)
      }
      return c.json({ auto: false })
    })
    // 安装扩展：打开浏览器的扩展页面和扩展所在的文件夹
    .post('/install', async (c) => {
      const { browser } = (await c.req.json().catch(() => ({}))) as { browser?: string }
      const dir = extensionDir()
      if (!dir) return bad(c, t('没有找到扩展目录'))
      try {
        openExtensionsPage(String(browser ?? ''))
        await revealItem(dir)
      } catch (e) {
        return bad(c, (e as Error).message)
      }
      return c.json({ dir })
    })
