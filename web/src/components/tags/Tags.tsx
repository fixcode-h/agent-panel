import { useState } from 'react'
import { toast } from '@/lib/toast'
import { Check, Plus, Tag as TagIcon, X } from 'lucide-react'
import { TAG_COLORS, type Tag } from '@shared/schema'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger, menuItem } from '@/components/ui/menu'
import { MenuSearch } from '@/components/ui/menu-search'
import { ChipGroup } from '@/components/ui/chip-group'

/** 标签的颜色：浅色底 + 同色字，深浅主题都看得清。色值在 index.css 的 --tag-*，这里只取变量 */
export const TAG_HEX: Record<Tag['color'], string> = {
  gray: 'var(--tag-gray)',
  red: 'var(--tag-red)',
  orange: 'var(--tag-orange)',
  amber: 'var(--tag-amber)',
  green: 'var(--tag-green)',
  teal: 'var(--tag-teal)',
  blue: 'var(--tag-blue)',
  violet: 'var(--tag-violet)',
  pink: 'var(--tag-pink)',
}

export const tagStyle = (c: Tag['color']) => ({
  color: TAG_HEX[c],
  background: `color-mix(in srgb, ${TAG_HEX[c]} 14%, transparent)`,
})

export function TagChip({ tag, onRemove, className }: { tag: Tag; onRemove?: () => void; className?: string }) {
  return (
    <span
      title={tag.description || undefined}
      style={tagStyle(tag.color)}
      className={cn('inline-flex h-[22px] max-w-full items-center gap-1 rounded-md px-1.5 text-[0.6875rem]', className)}
    >
      <span className="truncate">{tag.name}</span>
      {onRemove && (
        <button
          type="button"
          aria-label={t('去掉标签「{name}」', { name: tag.name })}
          onClick={onRemove}
          className="-mr-0.5 grid h-4 w-4 cursor-pointer place-items-center rounded opacity-70 hover:opacity-100"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  )
}

/** 列表里一行显示的几个标签：放不下的只显示数量 */
export function TagList({ ids, max = 3 }: { ids: string[]; max?: number }) {
  const { tags } = useData()
  const list = ids.map((id) => tags.find((x) => x.id === id)).filter((x): x is Tag => !!x)
  if (!list.length) return null
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {list.slice(0, max).map((x) => (
        <TagChip key={x.id} tag={x} className="h-[18px] px-1 text-[0.6875rem]" />
      ))}
      {list.length > max && <span className="text-[0.6875rem] text-subtle">+{list.length - max}</span>}
    </span>
  )
}

/** 选标签：已选的显示成小块，点「添加标签」搜索或新建（新建的标签是全局的，Agent 和工作流都能用） */
export function TagPicker({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const { tags, setTags } = useData()
  const [q, setQ] = useState('')
  const name = q.trim()
  const list = tags.filter((x) => x.name.toLowerCase().includes(name.toLowerCase()))
  const exact = tags.some((x) => x.name === name)
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id])
  const create = async () => {
    try {
      // 新标签按已有数量轮着取颜色，免得全是灰色
      const color = TAG_COLORS[(tags.length + 1) % TAG_COLORS.length]
      const tag = await api.createTag({ name, color, description: '' })
      setTags((ts) => [...ts, tag])
      onChange([...value, tag.id])
      setQ('')
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  const chosen = value.map((id) => tags.find((x) => x.id === id)).filter((x): x is Tag => !!x)
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {chosen.map((x) => (
        <TagChip key={x.id} tag={x} onRemove={() => toggle(x.id)} />
      ))}
      <Popover onOpenChange={(o) => o && setQ('')}>
        <PopoverTrigger className="chip-idle inline-flex h-[26px] cursor-pointer items-center gap-1 rounded-md px-2 text-xs text-muted hover:text-fg data-[state=open]:bg-sel data-[state=open]:text-fg">
          <Plus className="h-3 w-3" />
          {t('添加标签')}
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[240px]">
          <MenuSearch
            value={q}
            onChange={setQ}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name && !exact) {
                e.preventDefault()
                void create()
              }
            }}
            placeholder={t('搜索或输入新标签名')}
          />
          <div className="max-h-64 overflow-y-auto">
            {list.map((x) => (
              <button key={x.id} type="button" className={menuItem} onClick={() => toggle(x.id)}>
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: TAG_HEX[x.color] }} />
                <span className="flex-1 truncate">{x.name}</span>
                {value.includes(x.id) && <Check className="h-4 w-4 text-accent-text" />}
              </button>
            ))}
            {name && !exact && (
              <button type="button" className={menuItem} onClick={() => void create()}>
                <Plus className="h-4 w-4 text-accent-text" />
                <span className="flex-1 truncate">{t('新建标签「{name}」', { name })}</span>
              </button>
            )}
            {!tags.length && !name && (
              <p className="px-2.5 py-2 text-xs text-subtle">{t('还没有标签，输入名字新建；也可以在设置里管理')}</p>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}

/** 列表上方按标签筛选：点一个标签只看带它的，再点取消 */
export function TagFilter({
  value,
  onChange,
  used,
}: {
  value: string
  onChange: (id: string) => void
  /** 只列出这些条目用到的标签 */
  used: string[]
}) {
  const { tags } = useData()
  const list = tags.filter((x) => used.includes(x.id))
  if (!list.length) return null
  return (
    <div className="flex items-center gap-1.5 px-1 pb-2">
      <TagIcon className="h-3.5 w-3.5 shrink-0 text-subtle" />
      {/* 单选，再点选中的那个取消筛选；每块前面一个标签色的圆点，认得出是哪个标签 */}
      <ChipGroup
        label={t('按标签筛选')}
        size="sm"
        value={value}
        onChange={(id) => onChange(value === id ? '' : id)}
        options={list.map((x) => ({
          id: x.id,
          label: x.name,
          title: x.description || undefined,
          icon: <span className="h-2 w-2 rounded-full" style={{ background: TAG_HEX[x.color] }} />,
        }))}
      />
    </div>
  )
}
