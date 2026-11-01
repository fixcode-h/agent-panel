import { useState } from 'react'
import { toast } from '@/lib/toast'
import { Check, ChevronDown, FolderPlus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { fieldClass } from './input'
import { Popover, PopoverClose, PopoverContent, PopoverTrigger, menuItem } from './menu'
import { t } from '@shared/i18n'

interface Option {
  id: string
  name: string
}

/** 选择分类；输入一个不存在的名字可以直接新建（Agent 分类和项目分类共用） */
export function CategoryPicker({
  value,
  onChange,
  options,
  onCreate,
}: {
  value: string
  onChange: (id: string) => void
  options: Option[]
  onCreate: (name: string) => Promise<Option>
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const current = options.find((c) => c.id === value)
  const name = q.trim()
  const list = options.filter((c) => c.name.toLowerCase().includes(name.toLowerCase()))
  const exact = options.some((c) => c.name === name)

  const create = async () => {
    try {
      const c = await onCreate(name)
      onChange(c.id)
      setOpen(false)
      toast.success(t('已新建分类「{name}」', { name: c.name }))
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
        <span className={cn('flex-1 truncate', !current && 'text-subtle')}>{current?.name ?? t('未分类')}</span>
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
          placeholder={t('搜索或输入新分类名')}
          className="mb-1 h-9 w-full rounded-lg border-0 bg-field px-2.5 text-body outline-none placeholder:text-subtle"
        />
        <div className="max-h-64 overflow-y-auto">
          {!name && (
            <PopoverClose className={menuItem} onClick={() => onChange('')}>
              <span className="flex-1 text-muted">{t('未分类')}</span>
              {!value && <Check className="h-4 w-4 text-accent-text" />}
            </PopoverClose>
          )}
          {list.map((c) => (
            <PopoverClose key={c.id} className={menuItem} onClick={() => onChange(c.id)}>
              <span className="flex-1 truncate">{c.name}</span>
              {c.id === value && <Check className="h-4 w-4 text-accent-text" />}
            </PopoverClose>
          ))}
          {name && !exact && (
            <button className={cn(menuItem, 'text-accent-text')} onClick={create}>
              <FolderPlus className="h-4 w-4" />
              {t('新建分类「{name}」', { name })}
            </button>
          )}
          {!name && options.length === 0 && (
            <p className="px-2.5 py-2 text-xs text-subtle">{t('还没有分类，输入名字即可新建')}</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
