import { useEffect, useState } from 'react'
import { getCli, type CliDefinition } from '@shared/clis'
import type { CliModels } from '@shared/schema'
import { t } from '@shared/i18n'
import { api } from './api'

/**
 * 本机 CLI 实际支持的模型：从服务端读一次，所有页面共用。
 * 读到之前（或读取失败时）用 shared/clis.ts 里的内置建议。
 */
const cache = new Map<string, CliModels>()
const pending = new Map<string, Promise<CliModels>>()
const listeners = new Set<() => void>()

/** 思考强度从低到高的顺序；CLI 返回的顺序不固定 */
const EFFORT_ORDER = ['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
export const sortEfforts = <T>(list: T[], id: (x: T) => string) =>
  [...list].sort((a, b) => {
    const i = EFFORT_ORDER.indexOf(id(a))
    const j = EFFORT_ORDER.indexOf(id(b))
    return (i < 0 ? 99 : i) - (j < 0 ? 99 : j)
  })

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
    apiMode: data.auth === 'api',
    models: data.models.map((m) => {
      // 下拉里第二行显示的说明：有展示名用展示名，没有用描述
      const label = (m.label !== m.id ? m.label : m.description) ?? ''
      return {
        id: m.id,
        // 看不到图片的模型在说明里写出来：附图给它也是白附
        label: m.images === false ? [label, t('只支持文字')].filter(Boolean).join(' · ') : label,
        isDefault: m.isDefault,
        defaultEffort: m.defaultEffort,
        efforts: m.efforts,
        origin: m.origin,
      }
    }),
    efforts: sortEfforts(
      data.efforts.length
        ? data.efforts.map((e) => ({ id: e, label: base.efforts.find((x) => x.id === e)?.label ?? e }))
        : base.efforts,
      (e) => e.id,
    ),
  }
}
