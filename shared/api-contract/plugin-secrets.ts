/**
 * 插件保密项的接口契约（插件接口 18，参数类型 secret；存储在 server/secrets/store.ts，写法见 ./define.ts）。
 * 原文只进不出：读只给「设没设」和末 4 位，写时值为空串表示清掉。只收清单里声明成 secret 的键。
 *
 * 没进 probe.ts：探查跑在没装插件的数据目录上；接口形状由 server/secrets/store.test.ts 和插件参数页的界面检查查
 */
import { z } from 'zod'
import { endpoint } from './define.ts'

/** 显示信息：只列设了的；tail 是末 4 位（太短的不给） */
export const PluginSecretHints = z.record(z.string(), z.object({ tail: z.string() }))
export type PluginSecretHints = z.infer<typeof PluginSecretHints>

/** 要改的保密项：值为空串表示清掉 */
export const PluginSecretsPatch = z.record(z.string(), z.string().max(8192))
export type PluginSecretsPatch = z.infer<typeof PluginSecretsPatch>

export const pluginSecretsContract = {
  hints: endpoint({ method: 'GET', path: '/plugins/:id/secrets', res: PluginSecretHints }),
  save: endpoint({ method: 'PUT', path: '/plugins/:id/secrets', body: PluginSecretsPatch, res: PluginSecretHints }),
}
