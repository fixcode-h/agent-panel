import { getIntegration } from '../../shared/integrations.ts'
import type {
  IntegrationCredentialHints,
  IntegrationCredentialsPatch,
} from '../../shared/api-contract/integration-credentials.ts'
import { getSecret, setSecret } from './store.ts'

/**
 * 账号授权里的备用登录信息（例如飞书不装 lark-cli 时的 token）：加密存在本机，命名空间 integration:<id>。
 * 和插件自己的保密项（plugin:<id>）分开：登录信息归账号授权管，几个插件都能用同一份，卸载插件也不丢。
 * 只认定义里声明过的键：网页和插件都不能往里塞别的东西
 */

const ns = (id: string) => `integration:${id}`

/** 这个工具声明过的备用登录项；没有这个工具或没声明时返回空 */
const fields = (id: string) => getIntegration(id)?.credentials ?? []

/** 网页显示用：保密项只给末 4 位，不保密的给原值 */
export async function credentialHints(id: string): Promise<IntegrationCredentialHints> {
  const out: IntegrationCredentialHints = {}
  for (const f of fields(id)) {
    const v = await getSecret(ns(id), f.key)
    if (!v) continue
    out[f.key] = f.secret ? { tail: v.length > 8 ? v.slice(-4) : '' } : { tail: '', value: v }
  }
  return out
}

/** 网页保存：只改声明过的键，值去掉首尾空白，空串清掉 */
export async function saveCredentials(id: string, patch: IntegrationCredentialsPatch) {
  const keys = new Set(fields(id).map((f) => f.key))
  for (const [k, v] of Object.entries(patch)) if (keys.has(k)) await setSecret(ns(id), k, v.trim())
  return credentialHints(id)
}

/**
 * 给插件读写（PluginServerContext.integrations.credentials，插件接口 19）：插件续期令牌后要写回新的。
 * 没声明的键读出空串、写入报错，插件写错键名能马上看到
 */
export function credentialStore(id: string) {
  const known = (k: string) => fields(id).some((f) => f.key === k)
  return {
    get: async (k: string) => (known(k) ? (await getSecret(ns(id), k)).trim() : ''),
    set: async (k: string, v: string) => {
      if (!known(k)) throw new Error(`账号授权「${id}」没有登录项 ${k}`)
      await setSecret(ns(id), k, v.trim())
    },
  }
}
