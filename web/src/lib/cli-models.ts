import { useEffect, useState } from 'react'
import { getCli, type CliDefinition } from '@shared/clis'
import type { CliModels, Settings } from '@shared/schema'
import { t } from '@shared/i18n'
import { api } from './api'

/**
 * 本机 CLI 实际支持的模型：从服务端读一次，所有页面共用。
 * 读到之前（或读取失败时）用 shared/clis.ts 里的内置建议。
 * 账号和 API 方式能用的模型不一样，按「CLI + 登录方式 + 选的 API」分开缓存：
 * 切换方式时直接换成那种方式的列表，不会先显示另一种方式的模型，读过的切回来也不用再等。
 */
export type CliMode = { authMode: 'account' | 'api'; apiId?: string }
const cache = new Map<string, CliModels>()
const pending = new Map<string, Promise<CliModels>>()
const listeners = new Set<() => void>()
/** 每个 CLI 现在用的登录方式：已保存的设置，设置页里改了还没保存时用正在编辑的 */
const modes = new Map<string, CliMode>()

// 设置还没读到时不知道是哪种方式，按服务端已保存的读，单独存一份
const keyOf = (id: string, mode = modes.get(id)) =>
  !mode ? `${id}|saved` : mode.authMode === 'api' ? `${id}|api|${mode.apiId ?? ''}` : `${id}|account`

/** 记下 CLI 现在的登录方式；变了时用到模型列表的地方跟着换 */
export function setCliMode(id: string, mode: CliMode) {
  if (keyOf(id) === keyOf(id, mode)) return
  modes.set(id, mode)
  listeners.forEach((f) => f())
}

/** 设置读到或保存后：所有 CLI 的登录方式按设置更新 */
export function setCliModes(settings: Settings) {
  for (const [id, cs] of Object.entries(settings.clis))
    setCliMode(id, { authMode: cs.authMode ?? 'account', apiId: cs.apiId })
}

/** 思考强度从低到高的顺序；CLI 返回的顺序不固定 */
const EFFORT_ORDER = ['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
export const sortEfforts = <T>(list: T[], id: (x: T) => string) =>
  [...list].sort((a, b) => {
    const i = EFFORT_ORDER.indexOf(id(a))
    const j = EFFORT_ORDER.indexOf(id(b))
    return (i < 0 ? 99 : i) - (j < 0 ? 99 : j)
  })

/** 读模型列表；mode 不给时按 CLI 现在的登录方式 */
export function loadCliModels(id: string, refresh = false, mode = modes.get(id)) {
  const key = keyOf(id, mode)
  if (!refresh && pending.has(key)) return pending.get(key)!
  const p = api
    .cliModels(id, refresh, mode)
    .then((m) => {
      // 要 API 方式的列表、服务端却按账号读的（这个 API 还没保存）：不记，保存后再读
      if (mode?.authMode === 'api' && m.auth !== 'api') return m
      cache.set(key, m)
      listeners.forEach((f) => f())
      return m
    })
    .finally(() => pending.delete(key))
  pending.set(key, p)
  return p
}

/** 提前读好另一种登录方式的列表，切换时不用等（已经读过的不重读） */
export function preloadCliModels(id: string, mode: CliMode) {
  if (!cache.has(keyOf(id, mode))) loadCliModels(id, false, mode).catch(() => {})
}

export function useCliModels(id: string | undefined) {
  const [, tick] = useState(0)
  const key = id ? keyOf(id) : ''
  useEffect(() => {
    const f = () => tick((n) => n + 1)
    listeners.add(f)
    return () => void listeners.delete(f)
  }, [])
  useEffect(() => {
    if (id && !cache.has(key)) loadCliModels(id).catch(() => {})
  }, [id, key])
  return id ? cache.get(key) : undefined
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
