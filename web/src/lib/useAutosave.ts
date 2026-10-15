import { useEffect, useRef, useState } from 'react'

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
    if (serialized === baseline.current || !valid) return
    setStatus('pending')
    const t = setTimeout(run, 600)
    return () => clearTimeout(t)
  }, [serialized, valid])

  useEffect(
    () => () => {
      const l = latest.current
      if (l.valid && l.serialized !== baseline.current) void l.save(l.value)
    },
    [],
  )

  return { status, error }
}
