/** 构建时从设置页源码抽出的设置项（scripts/lib/settings-index.mjs 的 Vite 插件提供） */
declare module 'virtual:settings-index' {
  const index: import('@/lib/settings-search').SettingsEntry[]
  export default index
}
