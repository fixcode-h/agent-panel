/**
 * 设置页的本机环境检测：命令行环境（设置「常规」里选）和本机代理（「网络与代理」的「检测」按钮）。
 * 单独一个文件：server/index.ts 到了行数上限。
 */
import { Hono } from 'hono'
import { detectProxies } from './net.ts'
import { currentShell, detectShells } from './shells.ts'

export function envApi(detect = detectProxies) {
  const app = new Hono()
  // 启动时先探一次当前命令行环境，第一次打开设置不用等
  void currentShell().catch(() => {})
  // fresh=1 重新检测
  app.get('/shells', async (c) => c.json(await detectShells(c.req.query('fresh') === '1')))
  app.get('/net/proxy/detect', async (c) => c.json({ proxies: await detect() }))
  return app
}
