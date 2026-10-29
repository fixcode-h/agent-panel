import { useEffect, useState } from 'react'
import { Check, Plus, Sparkles, X } from 'lucide-react'
import type { BundledSkill, LibraryItem } from '@shared/library'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger, menuItem } from '@/components/ui/menu'
import { MenuSearch } from '@/components/ui/menu-search'
import { IconButton } from '@/components/ui/icon-button'

/** 本机各 CLI 用户目录下的 Skill 和面板自带的 Skill，打开 Agent 页时读一次 */
let skillCache: Promise<{ items: LibraryItem[]; bundled: BundledSkill[] }> | null = null
const loadSkills = () =>
  (skillCache ??= Promise.all([api.library('skill').then((r) => r.items), api.bundledSkills().then((r) => r.items)])
    .then(([items, bundled]) => ({ items, bundled }))
    .catch(() => {
      skillCache = null
      return { items: [], bundled: [] }
    }))

/**
 * 选 Agent 要用的 Skill：从本机已有的 Skill 里挑，也可以直接写名字（项目里的 Skill、插件带的）。
 * 当前 CLI 没装的标出来，免得以为它会用。
 */
export function SkillsPicker({
  value,
  onChange,
  cli,
}: {
  value: string[]
  onChange: (v: string[]) => void
  /** Agent 实际用的 CLI */
  cli: string
}) {
  const [items, setItems] = useState<LibraryItem[]>([])
  const [bundled, setBundled] = useState<BundledSkill[]>([])
  const [q, setQ] = useState('')
  useEffect(() => {
    void loadSkills().then((r) => {
      setItems(r.items)
      setBundled(r.bundled)
    })
  }, [])
  // 自带的排在前面：执行时会自动装进 CLI
  const names = [...new Set([...bundled.map((x) => x.name), ...items.map((x) => x.name)])]
  const isBundled = (n: string) => bundled.some((x) => x.name === n)
  const name = q.trim()
  const list = names.filter((n) => n.toLowerCase().includes(name.toLowerCase()))
  const toggle = (n: string) => onChange(value.includes(n) ? value.filter((x) => x !== n) : [...value, n])
  const has = (n: string) => isBundled(n) || items.some((x) => x.name === n && x.cli === cli)
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {value.map((n) => (
        <span
          key={n}
          title={has(n) ? undefined : t('当前 Agent 的用户目录里没有这个 Skill（可能在项目里或插件里）')}
          // 不描边，靠底色分；当前 CLI 没装的用更浅的底和灰字，和装了的区分开
          className={cn(
            'inline-flex h-7 items-center gap-1 rounded-md bg-sel/70 pr-0.5 pl-2 font-mono text-[0.75rem]',
            !has(n) && items.length > 0 && 'bg-field text-muted',
          )}
        >
          <Sparkles className="h-3 w-3 text-accent-text" />
          {n}
          <IconButton icon={X} label={t('去掉 {name}', { name: n })} onClick={() => toggle(n)} />
        </span>
      ))}
      <Popover onOpenChange={(o) => o && setQ('')}>
        <PopoverTrigger asChild>
          <Button variant="secondary" size="sm">
            <Plus className="h-3.5 w-3.5" />
            {t('添加 Skill')}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[300px]">
          <MenuSearch
            value={q}
            onChange={setQ}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name && !value.includes(name)) {
                e.preventDefault()
                onChange([...value, name])
                setQ('')
              }
            }}
            placeholder={t('搜索，或输入 Skill 名后回车')}
          />
          <div className="max-h-72 overflow-y-auto">
            {list.map((n) => {
              const it =
                bundled.find((x) => x.name === n) ??
                items.find((x) => x.name === n && x.cli === cli) ??
                items.find((x) => x.name === n)
              return (
                <button key={n} type="button" className={menuItem} onClick={() => toggle(n)}>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex items-center gap-1.5 truncate font-mono text-[0.75rem]">
                      {n}
                      {isBundled(n) && (
                        <span className="rounded bg-sel px-1 font-sans text-[0.6875rem] text-subtle">{t('自带')}</span>
                      )}
                    </span>
                    {it?.description && <span className="truncate text-[0.6875rem] text-subtle">{it.description}</span>}
                  </span>
                  {value.includes(n) && <Check className="h-4 w-4 shrink-0 text-accent-text" />}
                </button>
              )
            })}
            {!names.length && !name && (
              <p className="px-2.5 py-2 text-xs text-subtle">{t('本机还没有 Skill，可以直接输入名字')}</p>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}

/** 开场白：几条常用要求，一行一条 */
export function StartersEditor({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [text, setText] = useState('')
  const add = () => {
    const s = text.trim()
    if (!s || value.includes(s)) return
    onChange([...value, s])
    setText('')
  }
  return (
    <div className="flex flex-col gap-1.5">
      {value.map((s, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <Input
            value={s}
            maxLength={500}
            onChange={(e) => onChange(value.map((x, j) => (j === i ? e.target.value : x)))}
            onBlur={() => !value[i].trim() && onChange(value.filter((_, j) => j !== i))}
            className="h-9 text-[0.8125rem]"
          />
          <IconButton icon={X} label={t('删除')} size="sm" onClick={() => onChange(value.filter((_, j) => j !== i))} />
        </div>
      ))}
      {value.length < 8 && (
        <div className="flex items-center gap-1.5">
          <Input
            value={text}
            maxLength={500}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault()
                add()
              }
            }}
            placeholder={t('例如：审查当前分支相对 main 的改动')}
            className="h-9 text-[0.8125rem]"
          />
          <Button variant="secondary" size="sm" onClick={add} disabled={!text.trim()}>
            <Plus className="h-3.5 w-3.5" />
            {t('添加')}
          </Button>
        </div>
      )}
    </div>
  )
}
