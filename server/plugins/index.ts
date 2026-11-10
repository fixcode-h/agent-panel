/**
 * 插件系统的服务端入口（ADR 0059）：server/index.ts、runner 只从这里取。
 * 插件包的读写在 store.ts，装删开关在 manager.ts，服务端部分的运行在 runtime.ts，接口在 api.ts。
 */
export { pluginsApi } from './api.ts'
export { applyPluginSettings, cleanupDisabledPlugins, initPlugins } from './manager.ts'
export { pluginToolsForRun } from './runtime.ts'
