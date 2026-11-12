import { Suspense, useRef, useState } from 'react'
import type { Route } from '@/lib/data'
import { ErrorBoundary } from '@/components/ui/error-boundary'
import { usePluginPages } from './registry'

const keyOf = (r: Route) => (r.page === 'plugin' ? `${r.id}/${r.sub}` : '')

/** 当前地址是不是一个要一直挂着的插件整页（PluginPage.keep）：是的话 App 不再按地址另挂一份 */
export function useKeptPageShown(route: Route) {
  const key = keyOf(route)
  return usePluginPages().some((p) => p.keep && `${p.plugin}/${p.id}` === key)
}

/**
 * 打开过就一直挂着的插件整页（PluginPage.keep，插件接口 6；原来面板自带表格页时是 App 里单独的一段）：
 * 第一次打开时挂上，切到别的页面只藏起来，切回来接着用；插件关掉后它的页面跟着卸载
 */
export function KeptPluginPages({ route }: { route: Route }) {
  const pages = usePluginPages().filter((p) => p.keep)
  const key = keyOf(route)
  const shown = pages.some((p) => `${p.plugin}/${p.id}` === key)
  const [kept, setKept] = useState<string[]>([])
  if (shown && !kept.includes(key)) setKept([...kept, key])
  // 藏起来的页面保留最后的子位置：切回来时地址会再带上，期间不按别的页面的地址重画
  const paths = useRef<Record<string, string>>({})
  if (shown) paths.current[key] = route.msg ?? ''
  return kept.map((k) => {
    const p = pages.find((x) => `${x.plugin}/${x.id}` === k)
    if (!p) return null
    const on = k === key
    return (
      <div key={k} className={on ? 'flex min-w-0 flex-1 flex-col md:flex-row md:overflow-hidden' : 'hidden'}>
        <ErrorBoundary resetKey={k}>
          <Suspense fallback={null}>
            <p.Page path={paths.current[k] ?? ''} active={on} />
          </Suspense>
        </ErrorBoundary>
      </div>
    )
  })
}
