import { useState } from 'react'
import { toast } from 'sonner'
import { Check, ChevronDown, FolderPlus } from 'lucide-react'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { cn } from '@/lib/utils'
import { fieldClass } from '@/components/ui/input'
import { Popover, PopoverClose, PopoverContent, PopoverTrigger, menuItem } from '@/components/ui/menu'

/** 选择分类；输入一个不存在的名字可以直接新建 */
export function CategoryPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const { categories, setCategories } = useData()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const current = categories.find((c) => c.id === value)
  const name = q.trim()
  const list = categories.filter((c) => c.name.toLowerCase().includes(name.toLowerCase()))
  const exact = categories.some((c) => c.name === name)

  const create = async () => {
    try {
      const c = await api.createCategory(name)
      setCategories((cs) => [...cs, c])
      onChange(c.id)
      setOpen(false)
      toast.success(`已新建分类「${c.name}」`)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) setQ('')
      }}
    >
      <PopoverTrigger className={cn(fieldClass, 'flex h-10 cursor-pointer items-center text-left')}>
        <span className={cn('flex-1 truncate', !current && 'text-subtle')}>{current?.name ?? '未分类'}</span>
        <ChevronDown className="h-4 w-4 text-subtle" />
      </PopoverTrigger>
      <PopoverContent>
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && name && !exact) {
              e.preventDefault()
              create()
            }
          }}
          placeholder="搜索或输入新分类名"
          className="mb-1 h-9 w-full rounded-lg border-0 bg-field px-2.5 text-[13px] outline-none placeholder:text-subtle"
        />
        <div className="max-h-64 overflow-y-auto">
          {!name && (
            <PopoverClose className={menuItem} onClick={() => onChange('')}>
              <span className="flex-1 text-muted">未分类</span>
              {!value && <Check className="h-4 w-4 text-accent" />}
            </PopoverClose>
          )}
          {list.map((c) => (
            <PopoverClose key={c.id} className={menuItem} onClick={() => onChange(c.id)}>
              <span className="flex-1 truncate">{c.name}</span>
              {c.id === value && <Check className="h-4 w-4 text-accent" />}
            </PopoverClose>
          ))}
          {name && !exact && (
            <button className={cn(menuItem, 'text-accent')} onClick={create}>
              <FolderPlus className="h-4 w-4" />
              新建分类「{name}」
            </button>
          )}
          {!name && categories.length === 0 && (
            <p className="px-2.5 py-2 text-xs text-subtle">还没有分类，输入名字即可新建</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
