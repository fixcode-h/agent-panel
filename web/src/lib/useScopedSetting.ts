import { useState } from 'react'

/**
 * 每个设计（或别的范围）各自记住的设置：存在浏览器里，键是 `<base>:<scope>`。
 * 这个范围还没存过时用最近一次在别处选的值（`<base>`），所以新建的设计沿用上次的选择，
 * 但之后在这里改不会影响别的设计。给了 initial 时新范围改用它的值（例如设置里的默认值），不沿用上次的选择。
 * 读写失败（无痕模式、存储被禁用）时只在这次打开期间生效
 */
export function useScopedSetting<T>(
  base: string,
  scope: string,
  read: (raw: string | null) => T,
  write: (v: T) => string,
  initial?: () => T,
) {
  const load = () => {
    try {
      const own = localStorage.getItem(`${base}:${scope}`)
      const v = own !== null ? read(own) : initial ? initial() : read(localStorage.getItem(base))
      // 第一次打开就记下来：之后在别的设计里改了，这里也不跟着变
      if (own === null) localStorage.setItem(`${base}:${scope}`, write(v))
      return v
    } catch {
      return initial ? initial() : read(null)
    }
  }
  const [value, setValue] = useState<T>(load)
  // 换了设计：读那个设计自己的设置
  const [at, setAt] = useState(scope)
  if (at !== scope) {
    setAt(scope)
    setValue(load())
  }
  const set = (v: T) => {
    setValue(v)
    try {
      localStorage.setItem(`${base}:${scope}`, write(v))
      localStorage.setItem(base, write(v))
    } catch {}
  }
  return [value, set] as const
}
