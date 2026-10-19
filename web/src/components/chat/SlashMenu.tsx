import { useCallback, useEffect, useState } from 'react'
import { BookOpen, Loader2, SquareSlash, Terminal, X } from 'lucide-react'
import type { SlashCommand } from '@shared/schema'
import { getCli } from '@shared/clis'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { t } from '@shared/i18n'

/** 面板自己执行的命令：不发给 CLI，直接调对应的操作 */
export type SlashAction = 'compact' | 'review'

/**
 * 输入框里能用的命令集合：
 * task：已有的对话（能压缩、审查）；new：新建对话（还没有会话，只有发给 CLI 的命令）；skills：只列 CLI 的命令和 Skill（UI 设计）
 */
export type SlashScope = 'task' | 'new' | 'skills'

interface Item {
  name: string
  description: string
  group: 'builtin' | 'command' | 'skill'
  hint?: string
  source?: string
  action?: SlashAction
}

/** 选中的命令或 Skill：输入框里显示成卡片，发送时再拼回「/名字」交给服务端展开 */
export type PickedSlash = Pick<Item, 'name' | 'group' | 'description' | 'source'>

/** 内置命令：压缩、审查由面板执行；init 每个 CLI 都能用（Claude Code 自己有，其他的由面板展开）；security-review 只有 Claude Code 有 */
function builtins(cli: string, scope: SlashScope): Item[] {
  if (scope === 'skills') return []
  const list: (Item & { clis?: string[] })[] = [
    {
      name: 'compact',
      description: t('压缩上下文：把之前的对话压成摘要，腾出上下文'),
      group: 'builtin',
      action: 'compact',
    },
    {
      name: 'review',
      description: t('审查还没提交的改动；后面跟分支名就审查相对这个分支的改动'),
      group: 'builtin',
      hint: t('[分支]'),
      action: 'review',
    },
    {
      name: 'init',
      description: t('分析项目，写一份给 Agent 看的项目说明（CLAUDE.md / AGENTS.md）'),
      group: 'builtin',
    },
    {
      name: 'security-review',
      description: t('检查当前分支改动里的安全问题'),
      group: 'builtin',
      clis: ['claude'],
    },
  ]
  return list.filter((x) => (!x.clis || x.clis.includes(cli)) && (scope === 'task' || !x.action))
}

// CLI 的命令和 Skill 读一次要起进程（Codex），同一个 CLI 和项目一分钟内用缓存
const cache = new Map<string, { at: number; list: Promise<SlashCommand[]> }>()
function loadCommands(cli: string, projectId: string) {
  const key = `${cli}\n${projectId}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < 60_000) return hit.list
  const list = api.cliCommands(cli, projectId)
  cache.set(key, { at: Date.now(), list })
  list.catch(() => cache.delete(key))
  return list
}

/**
 * 输入「/」弹出命令菜单：内置命令、CLI 自己带的命令、Skill，随选的 CLI 变化。
 * 选中后显示成输入框上方的卡片（面板执行的命令直接执行），发送时把「/名字」拼回要求前面，
 * 再由服务端按 CLI 展开。
 */
export function useSlashMenu({
  cli,
  projectId = '',
  scope,
  text,
  setText,
  ta,
  onAction,
}: {
  /** 为空时没有菜单（例如按工作流执行时不知道是哪个 CLI） */
  cli: string
  projectId?: string
  scope: SlashScope
  text: string
  setText: (v: string) => void
  ta: React.RefObject<HTMLTextAreaElement | null>
  onAction?: (a: SlashAction, arg: string) => void
}) {
  const [query, setQuery] = useState<string | null>(null)
  const [cmds, setCmds] = useState<SlashCommand[] | null>(null)
  const [active, setActive] = useState(0)
  const [closed, setClosed] = useState(false)
  const [picked, setPicked] = useState<PickedSlash | null>(null)
  // 换 CLI 后原来选的命令不一定还存在，清掉
  useEffect(() => setPicked(null), [cli])

  /** 光标还在第一个词里、而且以「/」开头时才是在输命令 */
  const sync = useCallback(() => {
    const el = ta.current
    if (!el) return
    const v = el.value
    const pos = el.selectionStart ?? v.length
    const m = /^\/(\S*)/.exec(v)
    const typing = !!m && pos <= m[0].length
    setQuery(typing ? m![1] : null)
    if (!typing) setClosed(false)
  }, [ta])

  useEffect(() => {
    setCmds(null)
    if (!cli || query === null) return
    let off = false
    loadCommands(cli, projectId)
      .then((l) => !off && setCmds(l))
      .catch(() => !off && setCmds([]))
    return () => {
      off = true
    }
    // 只在开始输入命令（query 从无到有）、换 CLI 或项目时读
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [cli, projectId, query === null])

  const kw = (query ?? '').toLowerCase()
  const all: Item[] = [
    ...builtins(cli, scope),
    ...(cmds ?? []).map(
      (c): Item => ({ name: c.name, description: c.description, group: c.kind, hint: c.hint, source: c.source }),
    ),
  ]
  const items = all
    .filter((x) => x.name.toLowerCase().includes(kw))
    // 名字开头就对上的排在前面，同组的保持原来的顺序
    .sort((a, b) => Number(!a.name.toLowerCase().startsWith(kw)) - Number(!b.name.toLowerCase().startsWith(kw)))
    .slice(0, 80)
  const open = !!cli && query !== null && !closed && (items.length > 0 || cmds === null)

  useEffect(() => setActive(0), [kw, cli])

  const pick = (x: Item) => {
    const el = ta.current
    const rest = text.replace(/^\/\S*\s*/, '')
    setClosed(true)
    if (x.action && onAction) {
      setText('')
      onAction(x.action, rest.trim())
      return
    }
    // 命令不再写进文字：显示成卡片，文字只留后面写的要求
    setPicked({ name: x.name, group: x.group, description: x.description, source: x.source })
    setText(rest)
    requestAnimationFrame(() => {
      if (!el) return
      el.focus()
      el.setSelectionRange(0, 0)
    })
  }

  /** 菜单打开时接管上下键、回车、Tab、Esc；返回 true 表示已处理 */
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open || !items.length) return false
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const d = e.key === 'ArrowDown' ? 1 : -1
      setActive((i) => (i + d + items.length) % items.length)
      return true
    }
    if ((e.key === 'Enter' && !e.nativeEvent.isComposing) || e.key === 'Tab') {
      e.preventDefault()
      pick(items[Math.min(active, items.length - 1)])
      return true
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      setClosed(true)
      return true
    }
    return false
  }

  /** 发送前：是面板执行的命令（/compact、/review 分支）就直接执行，返回 true 表示不用再发 */
  const intercept = (v: string) => {
    // 选的是 CLI 自己的同名命令时按命令发，不要当成面板的压缩 / 审查
    if (picked || scope !== 'task' || !onAction) return false
    const m = /^\/(compact|review)(?:\s+(\S+))?\s*$/.exec(v.trim())
    if (!m) return false
    if (m[1] === 'compact' && m[2]) return false
    onAction(m[1] as SlashAction, m[2] ?? '')
    setText('')
    setPicked(null)
    return true
  }

  /** 交给服务端的文字：选中的命令拼回最前面，服务端按 CLI 展开 */
  const build = (v: string) => {
    if (!picked) return v
    const rest = v.trim()
    return `/${picked.name}${rest ? ` ${rest}` : ''}`
  }
  const clear = () => setPicked(null)

  const groups: { id: Item['group']; label: string; icon: typeof Terminal }[] = [
    { id: 'builtin', label: t('内置命令'), icon: SquareSlash },
    { id: 'command', label: t('自定义命令'), icon: Terminal },
    { id: 'skill', label: t('Skill'), icon: BookOpen },
  ]
  const menu = open ? (
    <div
      role="listbox"
      aria-label={t('命令')}
      className="absolute right-3 bottom-full left-3 z-30 mb-2 max-h-80 overflow-y-auto rounded-xl border border-line-strong bg-card p-1 shadow-pop"
    >
      <div className="flex items-center gap-2 px-2.5 pt-1.5 pb-1 text-[0.6875rem] text-subtle">
        <span className="font-medium text-muted">{getCli(cli)?.name ?? cli}</span>
        <span>{t('↑↓ 选择，回车确认')}</span>
        {cmds === null && <Loader2 className="ml-auto h-3 w-3 animate-spin" />}
      </div>
      {groups.map((g) => {
        const list = items.filter((x) => x.group === g.id)
        if (!list.length) return null
        return (
          <div key={g.id}>
            <div className="px-2.5 pt-2 pb-0.5 text-[0.65625rem] font-medium text-subtle">{g.label}</div>
            {list.map((x) => {
              const i = items.indexOf(x)
              return (
                <button
                  key={`${x.group}:${x.name}`}
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(x)}
                  title={x.description}
                  className={cn(
                    'flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[0.8125rem]',
                    i === active ? 'bg-sel text-fg' : 'text-muted',
                  )}
                >
                  <g.icon className="h-3.5 w-3.5 shrink-0 text-subtle" />
                  <span className="shrink-0 font-mono text-fg">/{x.name}</span>
                  {x.hint && <span className="shrink-0 font-mono text-[0.71875rem] text-subtle">{x.hint}</span>}
                  <span className="min-w-0 flex-1 truncate text-[0.75rem] text-subtle">{x.description}</span>
                  {x.source && (
                    <span className="max-w-[120px] shrink-0 truncate font-mono text-[0.65625rem] text-subtle/80">
                      {x.source}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        )
      })}
      {cmds === null && !items.length && (
        <div className="px-2.5 py-2 text-[0.75rem] text-subtle">{t('正在读取 CLI 的命令和 Skill…')}</div>
      )}
    </div>
  ) : null

  return { sync, onKeyDown, menu, intercept, build, picked, clear }
}

/** 输入框上方的命令卡片：图标、/名字、类型，点叉去掉 */
export function SlashChip({ item, onRemove }: { item: PickedSlash; onRemove: () => void }) {
  const Icon = item.group === 'skill' ? BookOpen : item.group === 'command' ? Terminal : SquareSlash
  const label = item.group === 'skill' ? t('Skill') : item.group === 'command' ? t('自定义命令') : t('内置命令')
  return (
    <div
      title={item.description}
      className="relative flex h-9 max-w-[300px] items-center gap-2 rounded-lg border border-accent/35 bg-accent-soft pr-8 pl-2.5 text-accent"
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate font-mono text-[0.78125rem]">/{item.name}</span>
      <span className="shrink-0 text-[0.6875rem] text-accent/70">{label}</span>
      <button
        type="button"
        aria-label={t('移除 {name}', { name: `/${item.name}` })}
        title={t('移除 {name}', { name: `/${item.name}` })}
        onClick={onRemove}
        className="absolute top-1/2 right-1.5 grid h-5 w-5 -translate-y-1/2 cursor-pointer place-items-center rounded text-accent/70 transition-colors hover:bg-accent/15 hover:text-accent"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  )
}
