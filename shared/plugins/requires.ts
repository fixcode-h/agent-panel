import { t } from '../i18n.ts'
import { comparePluginVersions } from './version.ts'

/**
 * 插件之间的依赖（插件接口 10，用户 2026-11-15 定：装一个插件时把它依赖的插件一起装上）。
 * 清单的 requires 写 `{ "<插件 id>": ">=1.2.0" }`，值只认最低版本（写成 `1.2.0` 也按最低版本算）：
 * 插件之间靠开放模块和面板接口打交道，没有「不能太新」的情况，不做完整的 semver 范围。
 * 这里只按清单算，前后端共用；真正去市场下载、按顺序装的在 server/plugins/requires-install.ts
 */

export type Requires = Record<string, string>

/** `>=1.2.0`、`^1.2.0`、`1.2.0` 都取出 1.2.0；`*` 或空表示任何版本 */
export const minVersion = (range: string) =>
  range
    .trim()
    .replace(/^(>=|\^|~|=|v)\s*/, '')
    .replace(/^\*$/, '')

/** 装着的插件：id、版本，开没开 */
export interface HavePlugin {
  id: string
  version: string
  enabled?: boolean
}

/** 一条没满足的依赖：没装（current 为空）或版本太旧 */
export interface UnmetRequire {
  id: string
  min: string
  current: string
}

/** 这个插件还缺哪些依赖（自己依赖自己的不算） */
export function unmetRequires(self: string, requires: Requires | undefined, have: HavePlugin[]): UnmetRequire[] {
  const out: UnmetRequire[] = []
  for (const [id, range] of Object.entries(requires ?? {})) {
    if (id === self) continue
    const min = minVersion(range)
    const cur = have.find((p) => p.id === id)
    if (!cur) out.push({ id, min, current: '' })
    else if (min && comparePluginVersions(cur.version, min) < 0) out.push({ id, min, current: cur.version })
  }
  return out
}

/** 给用户看的一句：缺哪个插件、要什么版本 */
export const unmetText = (u: UnmetRequire[]) =>
  u
    .map((x) =>
      x.current
        ? t('依赖插件 {id} 版本太旧（要 {min} 或更新，现在是 {cur}）', { id: x.id, min: x.min, cur: x.current })
        : x.min
          ? t('缺少依赖插件 {id}（{min} 或更新）', { id: x.id, min: x.min })
          : t('缺少依赖插件 {id}', { id: x.id }),
    )
    .join('；')

/** 哪些装着的插件依赖 id（删、关之前提示用） */
export const dependentsOf = (id: string, list: { id: string; requires?: Requires }[]) =>
  list.filter((p) => p.id !== id && Object.hasOwn(p.requires ?? {}, id)).map((p) => p.id)

/**
 * 依赖不满足的插件不加载：反复筛到不再变化（A 依赖 B、B 又缺依赖时，A 也跟着不加载）。
 * 返回能加载的和不能加载的原因
 */
export function splitByRequires<T extends { id: string; version: string; requires?: Requires }>(list: T[]) {
  let ok = list
  const bad = new Map<string, string>()
  for (;;) {
    const next = ok.filter((p) => {
      const u = unmetRequires(p.id, p.requires, ok)
      if (u.length) bad.set(p.id, unmetText(u))
      return !u.length
    })
    if (next.length === ok.length) break
    ok = next
  }
  return { ok, bad }
}
