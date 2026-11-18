import { useEffect, useState } from 'react'
import type { ApiProtocol } from '@shared/accounts'
import type { ModelCatalogInfo, ModelLookupJob } from '@shared/models/catalog'
import { t } from '@shared/i18n'
import { modelCatalogContract as M } from '@shared/api-contract/model-catalog'
import type { ModelCatalogEntry } from '@shared/models/catalog'
import type { ModelDiscoverJob } from '@shared/models/discover'
import { api } from './api'
import { call } from './api/call'

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

/**
 * 联网检查新模型：等 Agent 查完（最长 15 分钟），过程中把最近的输出交给 onProgress 显示。
 * 只在用户点按钮时调；查到的只是候选，要用户勾选后 addCatalogModels 才写进补充目录
 */
export async function discoverModels(onProgress: (job: ModelDiscoverJob) => void): Promise<ModelDiscoverJob> {
  let job = await call(M.discover, { body: {} })
  const end = Date.now() + 15 * 60_000
  while (job.status === 'running' && Date.now() < end) {
    onProgress(job)
    await wait(2000)
    job = await call(M.discoverJob, { params: { id: job.id } })
  }
  if (job.status === 'running') throw new Error(t('查询超时，请稍后再试'))
  return job
}

/** 停掉正在跑的检查；discoverModels 下一次取进度时拿到「已停止」 */
export const stopDiscoverModels = (id: string) => call(M.stopDiscover, { params: { id }, body: {} })

/** 把勾选的候选写进补充目录，然后重新读目录（三档模型的自动值跟着变） */
export async function addCatalogModels(entries: ModelCatalogEntry[]) {
  await call(M.addEntries, { body: { entries } })
  return refreshModelCatalog()
}

/** 删一条补充记录：同名的内置记录重新生效 */
export async function removeCatalogModel(vendor: string, id: string) {
  await call(M.removeEntry, { body: { vendor, id } })
  return refreshModelCatalog()
}
