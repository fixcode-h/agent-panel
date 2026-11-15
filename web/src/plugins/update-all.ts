import type { PluginUpdate } from '@shared/plugins/version'
import { pluginApi } from './api'
import { loadPlugins } from './registry'
import { setBulkStep, usePluginUpdates } from './updates'

/**
 * 「一键更新」：把有新版本的插件按顺序下载、直接换上，不弹安装确认（用户明确要的：点了就更新替换）。
 * 一个一个来而不是并发：都从 GitHub 下载，并发容易撞匿名限流；一个失败不影响后面的，原因记在那张卡片上。
 * 单个卡片上的「升级到 vX」仍然走安装确认，想看清扫描结果再装的用那个。
 */
export async function updateAll(list: PluginUpdate[]) {
  setBulkStep()
  for (const u of list) setBulkStep(u.id, { status: 'waiting', to: u.latest })
  for (const u of list) {
    setBulkStep(u.id, { status: 'updating', to: u.latest })
    try {
      const preview = await pluginApi.fromGithub(u.install)
      await pluginApi.confirm(preview.token)
      setBulkStep(u.id, { status: 'done', to: u.latest })
      // 每装好一个就刷新列表，卡片上的版本号马上换成新的
      await loadPlugins().catch(() => {})
    } catch (e) {
      setBulkStep(u.id, { status: 'failed', to: u.latest, error: (e as Error).message })
    }
  }
}

/** 一键更新还在跑（有排队或正在装的） */
export const useUpdatingAll = () =>
  [...usePluginUpdates().bulk.values()].some((s) => s.status === 'waiting' || s.status === 'updating')
