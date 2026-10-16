import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { t } from '@shared/i18n'

export type SaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error'

/**
 * 编辑后自动保存：停止输入 600ms 后保存；组件卸载（切换到别的条目）时立即保存未提交的改动。
 * `valid` 为 false 时不保存（例如名称为空）。
 */
export function useAutosave<T>(value: T, save: (v: T) => Promise<unknown>, valid: boolean) {
  const [status, setStatus] = useState<SaveStatus>('idle')
  const [error, setError] = useState('')
  const serialized = JSON.stringify(value)
  const baseline = useRef(serialized)
  const latest = useRef({ value, save, valid, serialized })
  latest.current = { value, save, valid, serialized }

  const run = async () => {
    const { value, save, serialized } = latest.current
    setStatus('saving')
    try {
      await save(value)
      baseline.current = serialized
      setStatus('saved')
      setError('')
    } catch (e) {
      setStatus('error')
      setError((e as Error).message)
    }
  }

  useEffect(() => {
    if (serialized === baseline.current) {
      // 改回了已保存的内容：之前的「保存失败」不再成立
      setStatus((s) => (s === 'error' || s === 'pending' ? 'idle' : s))
      return
    }
    if (!valid) return
    setStatus('pending')
    const t = setTimeout(run, 600)
    return () => clearTimeout(t)
  }, [serialized, valid])

  useEffect(
    () => () => {
      const l = latest.current
      // 离开页面时补存；失败只能用提示告诉用户，页面已经不在了
      if (l.valid && l.serialized !== baseline.current)
        l.save(l.value).catch((e) => toast.error(t('刚才的修改没有保存：{error}', { error: (e as Error).message })))
    },
    [],
  )

  return { status, error }
}
