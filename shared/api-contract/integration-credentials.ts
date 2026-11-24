/**
 * 账号授权里的备用登录信息（shared/integrations.ts 的 Integration.credentials，例如飞书不装 lark-cli 时用的 token）。
 * 存在 server/secrets/store.ts 的 integration:<id> 下；保密项原文只进不出，只给末 4 位，不保密的（选哪个平台）给原值。
 * 写时值为空串表示清掉；只收定义里声明过的键。
 *
 * 没进 probe.ts：探查的数据目录里没有存过的值，形状由 server/secrets/integration-credentials.test.ts 查
 */
import { z } from 'zod'
import { endpoint } from './define.ts'

/** 只列设了的：tail 是保密项的末 4 位（太短的不给），value 是不保密项的原值 */
export const IntegrationCredentialHints = z.record(
  z.string(),
  z.object({ tail: z.string(), value: z.string().optional() }),
)
export type IntegrationCredentialHints = z.infer<typeof IntegrationCredentialHints>

/** 要改的项：值为空串表示清掉 */
export const IntegrationCredentialsPatch = z.record(z.string(), z.string().max(8192))
export type IntegrationCredentialsPatch = z.infer<typeof IntegrationCredentialsPatch>

export const integrationCredentialsContract = {
  hints: endpoint({ method: 'GET', path: '/integrations/:id/credentials', res: IntegrationCredentialHints }),
  save: endpoint({
    method: 'PUT',
    path: '/integrations/:id/credentials',
    body: IntegrationCredentialsPatch,
    res: IntegrationCredentialHints,
  }),
}
