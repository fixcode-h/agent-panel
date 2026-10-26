import { useEffect, useSyncExternalStore } from 'react'
import type { SkillUpdates } from '@shared/deploy'
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
