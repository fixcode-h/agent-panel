import { useCallback, useEffect, useState } from 'react'
import { t } from '@shared/i18n'
import { Button } from './button'
import { Input } from './input'

/**
 * 保密项的输入框（令牌、密钥）和它的编辑状态：插件参数里的 secret（插件接口 18）、账号授权的备用登录信息共用。
 * 原文不回到网页：服务端只给「设没设」和末 4 位（不保密的项给原值 value），这里输入新的就是替换，「清除」就是删掉；
 * 不输入时保存不动它（不会因为输入框是空的就把已存的令牌清掉）
 */

/** 服务端给的显示信息：只列设了的 */
export type SecretHints = Record<string, { tail: string; value?: string }>

export interface SecretsState {
  hints: SecretHints
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

/** 读写走哪个接口由调用方给；scope 变了（换了插件、换了工具）重新读，为空时不读 */
export function useSecretStore(
  scope: string,
  io: { load: () => Promise<SecretHints>; save: (patch: Record<string, string>) => Promise<SecretHints> },
): SecretsState {
  const [hints, setHints] = useState<SecretHints>({})
  const [patch, setPatch] = useState<Record<string, string>>({})
  const reload = useCallback(async () => {
    if (!scope) return
    setHints(await io.load().catch(() => ({})))
    setPatch({})
    // io 每次渲染都是新对象，跟着 scope 变就够了
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [scope])
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
      setHints(await io.save(patch))
      setPatch({})
    },
  }
}

/** s.label 和 s.placeholder 是已经翻译好的文字 */
export function SecretField({
  s,
  state,
}: {
  s: { key: string; label: string; placeholder?: string }
  state: SecretsState
}) {
  const hint = state.hints[s.key]
  const pending = state.patch[s.key]
  const cleared = pending === ''
  const placeholder = cleared
    ? t('保存后清除')
    : hint
      ? hint.tail
        ? t('已设置（末 4 位 {tail}），输入新的替换', { tail: hint.tail })
        : t('已设置，输入新的替换')
      : s.placeholder || t('未设置')
  return (
    <div className="flex items-center gap-2">
      <Input
        type="password"
        autoComplete="off"
        aria-label={s.label}
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
