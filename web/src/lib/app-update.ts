import { useEffect, useSyncExternalStore } from 'react'
import type { AppReleases, AppUpdateBusy, AppUpdateJob } from '@shared/version'
import { api } from './api'
import { t } from '@shared/i18n'

/**
 * 面板版本更新的全局状态：打开页面时自动检查（服务端记着上次检查的时间，最多每 6 小时真去问一次 GitHub），
 * 页面一直开着就每小时问一次服务端；侧栏的「设置」和设置里的「版本更新」共用；
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
    // 不用 refresh：没到 6 小时服务端直接回上次的结果
    setInterval(() => {
      if (!state.loading && !state.job && !state.restarting) void loadReleases()
    }, 3600_000)
  }, [])
  return s
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 下载并安装某个版本；完成后等服务重启成新版本，再刷新页面 */
export async function installRelease(tag: string) {
  let job: AppUpdateJob
  try {
    job = await api.appInstall(tag)
  } catch (e) {
    // 已经在更新（409）：把那一次的进度交给界面显示，用户能看到卡在哪、能不能强制更新，
    // 而不是只收到一句「正在更新，请稍等」。服务端超过 10 分钟没进展时会自己作废，重试即可
    const busy = (e as Error & { body?: { busy?: AppUpdateBusy } }).body?.busy
    if (busy) set({ job: busy.job })
    throw e
  }
  set({ job })
  while (job.status === 'running') {
    await sleep(600)
    const next = await api.appInstallJob(job.id).catch(() => null)
    // 装好后服务马上重启：这时查不到进度（连不上，或者新服务里没有这条记录），
    // 不当成失败，按「正在重启」等新版本起来
    if (!next) break
    job = next
    set({ job })
  }
  if (job.status === 'failed') throw new Error(job.error ?? t('更新失败'))
  await waitRestart(tag.replace(/^v/, ''))
}

/**
 * 页面打开时接回正在跑的那次更新（刷新过页面、job 丢了）：
 * 不接管的话界面像什么都没发生，再点更新只会收到一句「正在更新」
 */
export async function adoptRunningJob() {
  const busy = await api.appInstallCurrent().catch(() => null)
  if (!busy) return null
  set({ job: busy.job })
  // 接管之后也要接着盯：装完 / 失败 / 重启都要反映到界面上，不能停在接管时那一刻
  if (busy.job.status === 'running') void followJob(busy.job)
  return busy
}

/** 盯着一个还在跑的更新，直到它结束；结束的方式和 installRelease 一致 */
async function followJob(start: AppUpdateJob) {
  let job = start
  while (job.status === 'running') {
    await sleep(600)
    const next = await api.appInstallJob(job.id).catch(() => null)
    if (!next) break
    job = next
    set({ job })
  }
  if (job.status === 'failed') return
  // 装好了：服务正在重启，等新版本起来再刷新页面
  await waitRestart(job.tag.replace(/^v/, '')).catch(() => {})
}

/** 下载完了但还有任务在执行：中断所有 CLI，马上替换并重启；安装轮询会接着更新进度 */
export async function forceInstallRelease() {
  const job = state.job
  if (!job) return
  set({ job: await api.appForceInstall(job.id) })
}

/** 回到更新前的版本：服务端换回程序文件后重启 */
export async function rollbackRelease() {
  const { version } = await api.appRollback()
  await waitRestart(version)
}

/** 重启要几秒；新服务起来、版本对上后刷新页面加载对应的前端 */
async function waitRestart(version: string) {
  set({ restarting: version })
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
