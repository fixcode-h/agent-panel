import { useEffect, useSyncExternalStore } from 'react'
import type { AppReleases, AppUpdateJob } from '@shared/version'
import { api } from './api'
import { t } from '@shared/i18n'

/**
 * 面板版本更新的全局状态：打开页面时检查一次（服务端缓存 10 分钟），侧栏的「设置」和设置里的「版本更新」共用；
 * 安装进度也放在这里，关掉设置再打开不会丢。
 */
interface State {
  data?: AppReleases
  loading: boolean
  job?: AppUpdateJob
  /** 安装完成，正在等新版本的服务起来 */
  restarting?: string
}

let state: State = { loading: false }
const listeners = new Set<() => void>()
const set = (s: Partial<State>) => {
  state = { ...state, ...s }
  for (const l of listeners) l()
}
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

let started = false
export async function loadReleases(refresh = false) {
  set({ loading: true })
  try {
    set({ data: await api.appReleases(refresh) })
  } catch (e) {
    set({ data: { current: state.data?.current ?? '', packaged: false, releases: [], error: (e as Error).message } })
  } finally {
    set({ loading: false })
  }
}

export function useAppUpdate() {
  const s = useSyncExternalStore(subscribe, () => state)
  useEffect(() => {
    if (started) return
    started = true
    void loadReleases()
  }, [])
  return s
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 下载并安装某个版本；完成后等服务重启成新版本，再刷新页面 */
export async function installRelease(tag: string) {
  let job = await api.appInstall(tag)
  set({ job })
  while (job.status === 'running') {
    await sleep(600)
    job = await api.appInstallJob(job.id)
    set({ job })
  }
  if (job.status === 'failed') throw new Error(job.error ?? t('更新失败'))
  const version = tag.replace(/^v/, '')
  set({ restarting: version })
  // 重启要几秒；新服务起来、版本对上后刷新页面加载新的前端
  for (let i = 0; i < 90; i++) {
    await sleep(1000)
    const v = await api.appVersion().catch(() => null)
    if (v?.current === version) {
      location.reload()
      return
    }
  }
  set({ restarting: undefined })
  throw new Error(t('新版本已经装好，但服务没有自动重启成功，请手动重新启动面板'))
}

export const clearUpdateJob = () => set({ job: undefined })
