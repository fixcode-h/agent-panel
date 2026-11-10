import { Suspense } from 'react'
import { Puzzle } from 'lucide-react'
import { t } from '@shared/i18n'
import { useNav } from '@/lib/data'
import { usePluginPages, usePlugins } from './registry'

/**
 * 插件的整页（#/plugin/<插件>/<页面>/<path>，插件接口 2）：整页交给插件自己画，path 是它自己的子位置。
 * 插件没开、已删除或这一页不在了时说明情况，不报错（删掉插件不影响面板）
 */
export function PluginPageView() {
  const { route } = useNav()
  const { loaded } = usePlugins()
  const page = usePluginPages().find((p) => p.plugin === route.id && p.id === route.sub)
  if (page)
    return (
      <Suspense fallback={null}>
        <page.Page path={route.msg ?? ''} />
      </Suspense>
    )
  return (
    <main className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <Puzzle className="h-7 w-7 text-subtle" strokeWidth={1.9} />
      <h1 className="text-subtitle font-semibold">{loaded ? t('插件没有打开') : t('读取中…')}</h1>
      <p className="max-w-md text-body leading-relaxed text-subtle">
        {loaded ? t('这一页来自插件，插件关掉或删除后就没有了。到设置 →「插件」里打开。') : ''}
      </p>
    </main>
  )
}
