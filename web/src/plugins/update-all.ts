import { pluginWrapContract as W } from '@shared/api-contract/plugin-wrap'
import { t } from '@shared/i18n'
import type { PluginUpdate } from '@shared/plugins/version'
import { call } from '@/lib/api/call'
import { pluginApi } from './api'
import { loadPlugins } from './registry'
import { setBulkStep, usePluginUpdates } from './updates'

/**
 * 「一键更新」：把有新版本的插件按顺序下载、直接换上，不弹安装确认（用户明确要的：点了就更新替换）。
 * 一个一个来而不是并发：都从 GitHub 下载，并发容易撞匿名限流；一个失败不影响后面的，原因记在那张卡片上。
 * 单个卡片上的「升级到 vX」仍然走安装确认，想看清扫描结果再装的用那个。
 * 包装插件只自动更新权限没变、没有新增中高级发现的，其余跳过（设计稿第 8 节）。
 */
export async function updateAll(list: PluginUpdate[]) {
  setBulkStep()
  for (const u of list) setBulkStep(u.id, { status: 'waiting', to: u.latest })
  for (const u of list) {
    setBulkStep(u.id, { status: 'updating', to: u.latest })
    try {
      // 包装插件（ADR 0068）：权限变了、或有新增中高级扫描发现的不自动装，标出来让用户点开单独确认
      if (u.install.wrap) {
        const p = await call(W.preview, { body: { url: u.install.repo, update: true } })
        if (p.wrap.update?.blocked || !p.token) {
          setBulkStep(u.id, {
            status: 'skipped',
            to: u.latest,
            error: p.wrap.update?.permChanges.length
              ? t('权限有变化（{list}），点「升级」看清楚再装', { list: p.wrap.update.permChanges.join(t('、')) })
              : t('有新增的扫描发现，点「升级」看清楚再装'),
          })
          continue
        }
        await pluginApi.confirm(p.token)
        setBulkStep(u.id, { status: 'done', to: u.latest })
        await loadPlugins().catch(() => {})
        continue
      }
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
