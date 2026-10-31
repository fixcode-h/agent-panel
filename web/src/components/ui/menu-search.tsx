import { forwardRef, type InputHTMLAttributes } from 'react'
import { Search } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * 弹层顶部的搜索框（选角色、选分类、选标签、选会话）：放大镜 + 无框输入，凹下去的一块底色（index.css 的 sunken），
 * 和下面的菜单项靠底色分开，不描边。打开弹层就能直接打字，所以默认 autoFocus；读屏名默认用 placeholder
 */
export const MenuSearch = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'size'> & {
    value: string
    onChange: (v: string) => void
    placeholder: string
  }
>(({ value, onChange, placeholder, className, autoFocus = true, ...props }, ref) => (
  <label
    className={cn(
      'sunken mb-1 flex h-8 shrink-0 cursor-text items-center gap-2 rounded-lg px-2.5 transition-shadow',
      'focus-within:ring-2 focus-within:ring-focus-soft',
      className,
    )}
  >
    <Search className="h-3.5 w-3.5 shrink-0 text-subtle" />
    <input
      ref={ref}
      autoFocus={autoFocus}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      aria-label={props['aria-label'] ?? placeholder}
      className="h-full min-w-0 flex-1 bg-transparent text-body text-fg outline-none placeholder:text-subtle"
      {...props}
    />
  </label>
))
MenuSearch.displayName = 'MenuSearch'
