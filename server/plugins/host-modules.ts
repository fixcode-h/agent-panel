import * as serverAsks from '../asks.ts'
import * as serverAttachments from '../attachments.ts'
import * as serverAuth from '../auth.ts'
import * as serverBridge from '../bridge.ts'
import * as serverComfy from '../comfy.ts'
import * as serverExecInvoke from '../exec/invoke.ts'
import * as serverExecProcess from '../exec/process.ts'
import * as serverExecRetryPolicy from '../exec/retry-policy.ts'
import * as serverImage from '../image.ts'
import * as serverLog from '../log.ts'
import * as serverPluginsMcp from './mcp.ts'
import * as serverSettings from '../settings.ts'
import * as serverSlash from '../slash.ts'
import * as serverStore from '../store.ts'
import * as serverStyles from '../styles.ts'
import * as serverUploads from '../uploads.ts'
import * as serverZip from '../zip.ts'
import * as sharedAssist from '../../shared/assist.ts'
import * as sharedBrowserExt from '../../shared/browser-ext.ts'
import * as sharedCliSpec from '../../shared/cli-spec.ts'
import * as sharedClis from '../../shared/clis.ts'
import * as sharedDuration from '../../shared/duration.ts'
import * as sharedFix from '../../shared/fix.ts'
import * as sharedI18n from '../../shared/i18n.ts'
import * as sharedLocalImage from '../../shared/local-image.ts'
import * as sharedLocalPrompts from '../../shared/local-prompts.ts'
import * as sharedMoss from '../../shared/moss.ts'
import * as sharedPromptLang from '../../shared/prompt-lang.ts'
import * as sharedRaster from '../../shared/raster.ts'
import * as sharedRestoreThresholds from '../../shared/restore/thresholds.ts'
import * as sharedSchema from '../../shared/schema.ts'
import * as sharedSettings from '../../shared/settings.ts'
import * as sharedStyleTypes from '../../shared/style-types.ts'
import * as sharedStyles from '../../shared/styles.ts'
import * as sharedTask from '../../shared/task.ts'
import * as sharedText from '../../shared/text.ts'
import * as zod from 'zod'

/**
 * 插件服务端能直接 import 的面板模块（插件接口 4，ADR 0059）。键是面板源码里的路径（不带扩展名），
 * 清单在 shared/plugins/host-modules.json（插件仓库 sdk/ 里有副本，插件构建时按它把这些 import 接到
 * globalThis.__agentPanelServer.modules）。插件拿到的是面板进程里正在用的同一份：跑 CLI、提问、设置、出图的状态都和面板一致。
 * 整块搬出去的功能（UI 设计）靠它用面板跑 CLI、出图和提问的能力，不用另起一套。
 */
export const SERVER_HOST_MODULES: Record<string, object> = {
  'server/asks': serverAsks,
  'server/attachments': serverAttachments,
  'server/auth': serverAuth,
  'server/bridge': serverBridge,
  'server/comfy': serverComfy,
  'server/exec/invoke': serverExecInvoke,
  'server/exec/process': serverExecProcess,
  'server/exec/retry-policy': serverExecRetryPolicy,
  'server/image': serverImage,
  'server/log': serverLog,
  'server/plugins/mcp': serverPluginsMcp,
  'server/settings': serverSettings,
  'server/slash': serverSlash,
  'server/store': serverStore,
  'server/styles': serverStyles,
  'server/uploads': serverUploads,
  'server/zip': serverZip,
  'shared/assist': sharedAssist,
  'shared/browser-ext': sharedBrowserExt,
  'shared/cli-spec': sharedCliSpec,
  'shared/clis': sharedClis,
  'shared/duration': sharedDuration,
  'shared/fix': sharedFix,
  'shared/i18n': sharedI18n,
  'shared/local-image': sharedLocalImage,
  'shared/local-prompts': sharedLocalPrompts,
  'shared/moss': sharedMoss,
  'shared/prompt-lang': sharedPromptLang,
  'shared/raster': sharedRaster,
  'shared/restore/thresholds': sharedRestoreThresholds,
  'shared/schema': sharedSchema,
  'shared/settings': sharedSettings,
  'shared/style-types': sharedStyleTypes,
  'shared/styles': sharedStyles,
  'shared/task': sharedTask,
  'shared/text': sharedText,
  zod,
}

/** 插件的服务端入口 import 之前调：把开放的模块挂到全局 */
export function exposeHostModules() {
  ;(globalThis as { __agentPanelServer?: unknown }).__agentPanelServer ??= { modules: SERVER_HOST_MODULES }
}
