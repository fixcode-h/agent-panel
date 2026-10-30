import { useEffect, useState } from 'react'
import type { CliInstallJob } from '@shared/schema'
import { api } from './api'

/**
 * 安装 / 更新 / 卸载的进度放在页面组件外面：切到别的 CLI、关掉设置再打开都还在，
 * 刷新页面后从服务端取回最近一次操作，正在进行的接着轮询。
 */
const jobs = new Map<string, CliInstallJob>()
const listeners = new Set<() => void>()
const polling = new Set<string>()
let onFinish: ((j: CliInstallJob) => void) | null = null
let resumed = false

const emit = () => listeners.forEach((f) => f())

/** 操作结束时做什么（刷新检测结果、提示），由设置页注册 */
export const setInstallFinish = (f: (j: CliInstallJob) => void) => {
  onFinish = f
}

function poll(job: CliInstallJob) {
  if (polling.has(job.id)) return
  polling.add(job.id)
  const tick = async () => {
    try {
      const j = await api.cliJob(job.id)
      // 已经被清掉或换成新的操作
      if (jobs.get(j.cli)?.id !== j.id) return polling.delete(job.id)
      jobs.set(j.cli, j)
      emit()
      if (j.status === 'running') setTimeout(tick, 700)
      else {
        polling.delete(job.id)
        onFinish?.(j)
      }
    } catch {
      // 服务重启后操作就没了，不再轮询
      polling.delete(job.id)
      jobs.delete(job.cli)
      emit()
    }
  }
  setTimeout(tick, 500)
}

/** 打开设置时取回服务端记录的操作（只取回还在进行的，结束了的不再弹出来） */
export async function resumeInstallJobs() {
  if (resumed) return
  resumed = true
  try {
    for (const j of await api.cliJobs())
      if (j.status === 'running' && !jobs.has(j.cli)) {
        jobs.set(j.cli, j)
        poll(j)
      }
    emit()
  } catch {
    resumed = false
  }
}

export async function startInstall(cli: string, action: CliInstallJob['action']) {
  const j = await api.cliAction(cli, action)
  jobs.set(cli, j)
  emit()
  poll(j)
  return j
}

export function clearInstallJob(cli: string) {
  if (jobs.get(cli)?.status === 'running') return
  jobs.delete(cli)
  emit()
}

export function useInstallJob(cli: string) {
  const [, tick] = useState(0)
  useEffect(() => {
    const f = () => tick((n) => n + 1)
    listeners.add(f)
    return () => void listeners.delete(f)
  }, [])
  return jobs.get(cli) ?? null
}
