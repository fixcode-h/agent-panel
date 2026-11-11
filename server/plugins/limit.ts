import { t } from '../../shared/i18n.ts'

/**
 * 面板调插件代码的统一限时（插件框架改进 A1）：插件的 activate / tools / status / onConfig / stop 都在面板进程里 await，
 * 插件卡住（等 UE 进程、等网络）时面板跟着卡：tools 卡住每一轮对话都起不来，stop 卡住关插件、升级一直不返回。
 * 到时间就按出错处理（错误原样显示给用户），插件那边还在跑的 Promise 不管它。
 */
export const PLUGIN_LIMITS = {
  /** 服务端入口启动：可能要检查外部程序、读数据，给宽一点 */
  activate: 20_000,
  /** 每轮对话问要不要挂工具：在 CLI 启动前同步等，要短 */
  tools: 8_000,
  /** 插件页的运行状态 */
  status: 5_000,
  onConfig: 10_000,
  stop: 10_000,
} as const

export type PluginCall = keyof typeof PLUGIN_LIMITS

/** 超时的错误：调用方据此和插件自己抛的错区分（日志、提示里写明是超时） */
export class PluginTimeout extends Error {}

export async function withPluginLimit<T>(
  what: PluginCall,
  run: () => T | Promise<T>,
  ms: number = PLUGIN_LIMITS[what],
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(run),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new PluginTimeout(t('插件的 {what} 超过 {s} 秒没有返回', { what, s: ms / 1000 }))),
          ms,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
