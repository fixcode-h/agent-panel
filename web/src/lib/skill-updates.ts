import { useEffect, useSyncExternalStore } from 'react'
import type { SkillUpdates } from '@shared/deploy'
import { t } from '@shared/i18n'
import { api } from './api'

/**
 * 自带技能要不要更新：侧栏「Skills 与命令」、设置里的「部署」和「自带 Skill」分页共用一份。
 * 打开页面、窗口切回来时各读一次；装完、部署完由那里调 refreshSkillUpdates 立刻刷新，提示点跟着消失
 */
let state: SkillUpdates = { shared: [], deployed: [] }
const listeners = new Set<() => void>()
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

export async function refreshSkillUpdates() {
  try {
    state = await api.skillUpdates()
  } catch {
    // 读不到就不提示：这只是个提示点，出错不打扰用户，页面里的列表会显示真正的错误
    return
  }
  for (const l of listeners) l()
}

/**
 * 提示点的数量和文案只在这里判定：侧栏「Skills 与命令」、侧栏「设置」和设置页的
 * 「Agent」「部署」两项都读这几个函数，不各自再算一遍（一个状态只允许一处判定）
 */

/** 两份更新合起来的技能数（同一名字两边都有时只算一次） */
export function skillUpdateCount(updates: SkillUpdates): number {
  return new Set([...updates.shared, ...updates.deployed]).size
}

export function skillUpdateHint(updates: SkillUpdates): string | undefined {
  const n = skillUpdateCount(updates)
  return n ? t('{n} 个自带技能可以更新', { n }) : undefined
}

/**
 * 「设置 → 部署」那份和这一版自带不同的项数：没差异时是 0，提示点不显示。
 * 按条数算而不是按名字去重：服务端的 skillUpdates 是拿 entries() 的 category/name 逐个推出 name，
 * 同名技能装在不同分类下就是两条（部署页也列两条），去重会让点上的数字和页面对不上
 */
export function deployedUpdateCount(updates: SkillUpdates): number {
  return updates.deployed.length
}

export function deployedUpdateHint(updates: SkillUpdates): string | undefined {
  const n = deployedUpdateCount(updates)
  return n ? t('{n} 项部署内容有更新，需要重新部署', { n }) : undefined
}

let started = false
export function useSkillUpdates() {
  const s = useSyncExternalStore(subscribe, () => state)
  useEffect(() => {
    if (started) return
    started = true
    void refreshSkillUpdates()
    // 面板升级或用户在外面改了技能目录后切回来，提示点要跟上
    window.addEventListener('focus', () => void refreshSkillUpdates())
  }, [])
  return s
}
