import { useCallback, useEffect, useState } from 'react'
import { t } from '@shared/i18n'
import { pluginSecretsContract, type PluginSecretHints } from '@shared/api-contract/plugin-secrets'
import type { PluginSetting } from '@shared/plugins/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { call } from '@/lib/api/call'

/**
 * 插件参数里的保密项（type: secret，插件接口 18）：令牌、密钥。
 * 原文不回到网页：服务端只给「设没设」和末 4 位，这里输入新的就是替换，「清除」就是删掉；
 * 不输入时保存不动它（不会因为输入框是空的就把已存的令牌清掉）
 */

export interface SecretsState {
  hints: PluginSecretHints
  /** 这次要改的：值为空串表示清掉 */
  patch: Record<string, string>
  dirty: boolean
  edit: (key: string, value: string) => void
  clear: (key: string) => void
  reset: () => void
  reload: () => Promise<void>
  /** 有改动时存进去（值为空串的清掉） */
  save: () => Promise<void>
}

export function useSecrets(pluginId: string, has: boolean): SecretsState {
  const [hints, setHints] = useState<PluginSecretHints>({})
  const [patch, setPatch] = useState<Record<string, string>>({})
  const reload = useCallback(async () => {
    if (!has) return
    setHints(await call(pluginSecretsContract.hints, { params: { id: pluginId } }).catch(() => ({})))
    setPatch({})
  }, [pluginId, has])
  useEffect(() => void reload(), [reload])
  return {
    hints,
    patch,
    dirty: Object.keys(patch).length > 0,
    edit: (k, v) => setPatch(({ [k]: _old, ...rest }) => (v ? { ...rest, [k]: v } : rest)),
    clear: (k) => setPatch((p) => ({ ...p, [k]: '' })),
    reset: () => setPatch({}),
    reload,
    save: async () => {
      if (!Object.keys(patch).length) return
      setHints(await call(pluginSecretsContract.save, { params: { id: pluginId }, body: patch }))
      setPatch({})
    },
  }
}

export function SecretField({ s, state }: { s: PluginSetting; state: SecretsState }) {
  const hint = state.hints[s.key]
  const pending = state.patch[s.key]
  const cleared = pending === ''
  const placeholder = cleared
    ? t('保存后清除')
    : hint
      ? hint.tail
        ? t('已设置（末 4 位 {tail}），输入新的替换', { tail: hint.tail })
        : t('已设置，输入新的替换')
      : s.placeholder
        ? t(s.placeholder)
        : t('未设置')
  return (
    <div className="flex items-center gap-2">
      <Input
        type="password"
        autoComplete="off"
        aria-label={t(s.label)}
        value={pending ?? ''}
        placeholder={placeholder}
        className="min-w-0 flex-1 font-mono"
        onChange={(e) => state.edit(s.key, e.target.value)}
      />
      {hint && !cleared && (
        <Button size="sm" variant="ghost" onClick={() => state.clear(s.key)}>
          {t('清除')}
        </Button>
      )}
    </div>
  )
}
