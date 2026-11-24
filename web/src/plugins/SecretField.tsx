import { t } from '@shared/i18n'
import { pluginSecretsContract } from '@shared/api-contract/plugin-secrets'
import type { PluginSetting } from '@shared/plugins/types'
import { SecretField as Field, useSecretStore, type SecretsState } from '@/components/ui/secret-field'
import { call } from '@/lib/api/call'

/** 插件参数里的保密项（type: secret，插件接口 18）：输入框和编辑状态用共用的 ui/secret-field，这里只接插件的接口 */

export type { SecretsState }

export function useSecrets(pluginId: string, has: boolean): SecretsState {
  return useSecretStore(has ? pluginId : '', {
    load: () => call(pluginSecretsContract.hints, { params: { id: pluginId } }),
    save: (patch) => call(pluginSecretsContract.save, { params: { id: pluginId }, body: patch }),
  })
}

export function SecretField({ s, state }: { s: PluginSetting; state: SecretsState }) {
  return (
    <Field s={{ key: s.key, label: t(s.label), placeholder: s.placeholder ? t(s.placeholder) : '' }} state={state} />
  )
}
