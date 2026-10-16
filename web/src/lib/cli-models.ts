import { useEffect, useState } from 'react'
import { getCli, type CliDefinition } from '@shared/clis'
import type { CliModels } from '@shared/schema'
import { api } from './api'

/**
 * 本机 CLI 实际支持的模型：从服务端读一次，所有页面共用。
 * 读到之前（或读取失败时）用 shared/clis.ts 里的内置建议。
 */
const cache = new Map<string, CliModels>()
const pending = new Map<string, Promise<CliModels>>()
const listeners = new Set<() => void>()

/** 思考强度从低到高的顺序；CLI 返回的顺序不固定 */
const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
export const sortEfforts = <T>(list: T[], id: (x: T) => string) =>
  [...list].sort((a, b) => {
    const i = EFFORT_ORDER.indexOf(id(a))
    const j = EFFORT_ORDER.indexOf(id(b))
    return (i < 0 ? 99 : i) - (j < 0 ? 99 : j)
  })

/** CLI 新出的思考强度没有中文名时，直接显示原值 */
const EFFORT_LABELS: Record<string, string> = {
  none: '不思考',
  minimal: '最低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '很高',
  max: '最高',
  ultra: '极限',
}

export function loadCliModels(id: string, refresh = false) {
  if (!refresh && pending.has(id)) return pending.get(id)!
  const p = api
    .cliModels(id, refresh)
    .then((m) => {
      cache.set(id, m)
      listeners.forEach((f) => f())
      return m
    })
    .finally(() => pending.delete(id))
  pending.set(id, p)
  return p
}

export function useCliModels(id: string | undefined) {
  const [, tick] = useState(0)
  useEffect(() => {
    const f = () => tick((n) => n + 1)
    listeners.add(f)
    if (id && !cache.has(id)) loadCliModels(id).catch(() => {})
    return () => void listeners.delete(f)
  }, [id])
  return id ? cache.get(id) : undefined
}

/** 用读到的模型和思考强度替换内置列表，其余配置不变 */
export function useCliDef(id: string | undefined): CliDefinition | undefined {
  const base = id ? getCli(id) : undefined
  const data = useCliModels(base?.id)
  if (!base || !data) return base
  return {
    ...base,
    models: data.models.map((m) => {
      // 下拉里第二行显示的说明：有展示名用展示名，没有用描述
      const label = (m.label !== m.id ? m.label : m.description) ?? ''
      return { id: m.id, label, isDefault: m.isDefault, defaultEffort: m.defaultEffort, origin: m.origin }
    }),
    efforts: sortEfforts(
      data.efforts.length
        ? data.efforts.map((e) => ({
            id: e,
            label: EFFORT_LABELS[e] ?? base.efforts.find((x) => x.id === e)?.label ?? e,
          }))
        : base.efforts,
      (e) => e.id,
    ),
  }
}
