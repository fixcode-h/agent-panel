import { lazy } from 'react'

/**
 * 设置页里按需加载的各栏。从 pages/SettingsPage.tsx 挪出（那个文件到了行数上限），
 * 页面只按名字引用，加载时机和以前一样。
 */
// 设置弹窗本身是第一次打开时才加载的，里面 25 个分页再按页加载：不常打开的几页（数据、用量、组件陈列、
// 本地生图、插件……）带着自己的大依赖，不该跟着「常规」一起下载
export const UpdateSection = lazy(() =>
  import('@/components/settings/UpdateSection').then((m) => ({ default: m.UpdateSection })),
)
export const DataSection = lazy(() =>
  import('@/components/settings/DataSection').then((m) => ({ default: m.DataSection })),
)
export const UsageSection = lazy(() =>
  import('@/components/usage/UsageSection').then((m) => ({ default: m.UsageSection })),
)
export const LocalImageSection = lazy(() =>
  import('@/components/settings/LocalImageSection').then((m) => ({ default: m.LocalImageSection })),
)
export const PluginsSection = lazy(() =>
  import('@/plugins/PluginsSection').then((m) => ({ default: m.PluginsSection })),
)
export const PluginParamsSection = lazy(() =>
  import('@/plugins/PluginParams').then((m) => ({ default: m.PluginParamsSection })),
)
export const RemoteSection = lazy(() =>
  import('@/components/settings/RemoteSection').then((m) => ({ default: m.RemoteSection })),
)
export const SpeechSection = lazy(() =>
  import('@/components/settings/SpeechSection').then((m) => ({ default: m.SpeechSection })),
)
export const ReadAloudSection = lazy(() =>
  import('@/components/settings/ReadAloudSection').then((m) => ({ default: m.ReadAloudSection })),
)
export const ExperienceSection = lazy(() =>
  import('@/components/settings/ExperienceSection').then((m) => ({ default: m.ExperienceSection })),
)
export const ChatMemorySection = lazy(() =>
  import('@/components/settings/ChatMemorySection').then((m) => ({ default: m.ChatMemorySection })),
)
export const NotifyChannelsSection = lazy(() =>
  import('@/components/settings/NotifyChannelsSection').then((m) => ({ default: m.NotifyChannelsSection })),
)
export const HooksSection = lazy(() =>
  import('@/components/settings/HooksSection').then((m) => ({ default: m.HooksSection })),
)
export const IntegrationsSection = lazy(() =>
  import('@/components/settings/IntegrationsSection').then((m) => ({ default: m.IntegrationsSection })),
)
export const DeploySection = lazy(() =>
  import('@/components/settings/DeploySection').then((m) => ({ default: m.DeploySection })),
)
export const MarkdownSection = lazy(() =>
  import('@/components/settings/MarkdownSection').then((m) => ({ default: m.MarkdownSection })),
)
export const ComponentsSection = lazy(() =>
  import('@/components/settings/ComponentsSection').then((m) => ({ default: m.ComponentsSection })),
)
