import { useEffect, useState } from 'react'
import type { ApiProtocol } from '@shared/accounts'
import type { ModelCatalogInfo, ModelLookupJob } from '@shared/model-catalog'
import { t } from '@shared/i18n'
import { api } from './api'

/**
 * 模型目录（内置 + 用户补充）：设置页和模型下拉共用，读一次后缓存。
 * AI 补全写进用户补充目录后调 refresh 重新读。
 */
let cache: ModelCatalogInfo | undefined
let pending: Promise<ModelCatalogInfo> | undefined
const listeners = new Set<() => void>()

const notify = () => listeners.forEach((f) => f())

export function loadModelCatalog(refresh = false) {
  if (!refresh && cache) return Promise.resolve(cache)
  if (!refresh && pending) return pending
  pending = api
    .modelCatalog()
    .then((info) => {
      cache = info
      notify()
      return info
    })
    .finally(() => (pending = undefined))
  return pending
}

export function refreshModelCatalog() {
  cache = undefined
  return loadModelCatalog(true)
}

export function useModelCatalog() {
  const [, tick] = useState(0)
  useEffect(() => {
    const f = () => tick((n) => n + 1)
    listeners.add(f)
    if (!cache) loadModelCatalog().catch(() => {})
    return () => void listeners.delete(f)
  }, [])
  return cache
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** 等一次 AI 补全结束（最长 5 分钟），返回最终结果 */
export async function lookupModel(model: string, protocol?: ApiProtocol): Promise<ModelLookupJob> {
  let job = await api.lookupModel({ model, protocol })
  const end = Date.now() + 5 * 60_000
  while (job.status === 'running' && Date.now() < end) {
    await wait(1500)
    job = await api.modelLookup(job.id)
  }
  if (job.status === 'running') throw new Error(t('查询超时，请稍后再试'))
  return job
}
