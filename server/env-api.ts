/**
 * 设置页的本机环境检测：命令行环境（设置「常规」里选）、本机代理和 GitHub 下载来源（「网络与代理」的两个「检测」按钮）。
 * 单独一个文件：server/index.ts 到了行数上限。
 */
import { Hono } from 'hono'
import { t } from '../shared/i18n.ts'
import { detectProxies, netFetchDirect, netReason } from './net.ts'
import { testSources } from './github-sources/index.ts'
import { SAMPLE_RAW_URL } from '../shared/github-sources/registry.ts'
import { netContract as N } from '../shared/api-contract/net.ts'
import { currentShell, detectShells } from './shells.ts'

export function envApi(detect = detectProxies) {
  const app = new Hono()
  // 启动时先探一次当前命令行环境，第一次打开设置不用等
  void currentShell().catch(() => {})
  // fresh=1 重新检测
  app.get('/shells', async (c) => c.json(await detectShells(c.req.query('fresh') === '1')))
  app.get('/net/proxy/detect', async (c) => c.json({ proxies: await detect() }))
  app.post(N.testGithubSources.path, async (c) => {
    const body = N.testGithubSources.body.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: t('检测下载来源的参数不对') }, 400)
    const reason = (e: unknown) => netReason((e as Error)?.cause ?? e)
    return c.json({ results: await testSources({ fetch: netFetchDirect, reason }, body.data.sources, SAMPLE_RAW_URL) })
  })
  return app
}
