import { useSyncExternalStore } from 'react'
import { pluginApi, type MarketResult } from './api'
import { checkUpdates } from './updates'

/**
 * 插件市场（设置 →「插件」下半部分）：服务端缓存着上次读到的 plugins.json，打开插件页先直接显示缓存，
 * 缓存超过一小时才在后台重读一次；点「刷新」同时重读市场和检查更新。换仓库由服务端记住。
 */
interface State {
  result?: MarketResult
  /** 读取失败且没有缓存可给（换了个读不到的仓库、第一次打开就断网） */
  error: string
  loading: boolean
}
let state: State = { error: '', loading: false }
const subs = new Set<() => void>()
const emit = (next: Partial<State>) => {
  state = { ...state, ...next }
  subs.forEach((f) => f())
}
const subscribe = (f: () => void) => {
  subs.add(f)
  return () => subs.delete(f)
}
export const useMarket = () => useSyncExternalStore(subscribe, () => state)
/** 上一次读取有没有失败（换仓库后决定弹层关不关） */
export const marketError = () => state.error

/** 缓存多旧就在后台重读 */
const STALE_MS = 60 * 60_000

export async function loadMarket(opts: { repo?: string; refresh?: boolean } = {}) {
  if (state.loading) return
  emit({ loading: true })
  try {
    emit({ result: await pluginApi.market(opts), error: '' })
  } catch (e) {
    emit({ error: (e as Error).message })
  } finally {
    emit({ loading: false })
  }
}

/** 打开插件页：先拿缓存，太旧就接着在后台重读（列表先显示着，读完替换） */
export async function openMarket() {
  if (!state.result) await loadMarket()
  const at = Date.parse(state.result?.fetchedAt ?? '')
  if (state.result && !state.result.error && Date.now() - at > STALE_MS) await loadMarket({ refresh: true })
}

/** 「刷新」：重读当前市场，再检查更新（插件目录用刚读到的缓存，不重复请求） */
export async function refreshMarket() {
  await loadMarket({ repo: state.result?.repo, refresh: true })
  await checkUpdates()
}

/** 换市场仓库：读这个仓库（有缓存先给缓存），服务端记成最后用的 */
export const switchMarket = (repo: string) => loadMarket({ repo })
