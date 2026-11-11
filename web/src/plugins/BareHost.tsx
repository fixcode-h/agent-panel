import { useEffect, useState } from 'react'
import { t } from '@shared/i18n'
import { loadPlugins, usePlugins } from './registry'

/**
 * 插件不带面板外壳的独立页（插件接口 4，#/pbare/<插件>/<页面>/<path>）：只加载插件、挂这一页，
 * 没有侧栏、数据和导航。给无头浏览器截图用，所以出错时只写一行字，不弹提示。
 */
export function PluginBareHost({ plugin, page, path }: { plugin: string; page: string; path: string }) {
  const { web, webErrors, loaded } = usePlugins()
  const [error, setError] = useState('')
  useEffect(() => {
    loadPlugins().catch((e: Error) => setError(e.message))
  }, [])
  const Page = web.get(plugin)?.barePages?.find((p) => p.id === page)?.Page
  if (Page) return <Page path={path} />
  const why = error || webErrors.get(plugin) || (loaded ? t('插件没有打开，或没有这一页') : '')
  return why ? <p className="p-4 text-body text-subtle">{why}</p> : null
}
