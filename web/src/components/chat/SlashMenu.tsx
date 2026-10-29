import { useCallback, useEffect, useState } from 'react'
import { BookOpen, Loader2, SquareSlash, Terminal } from 'lucide-react'
import type { SlashCommand } from '@shared/schema'
import { getCli } from '@shared/clis'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { t } from '@shared/i18n'
import { chipMarker, commandChip, type ChipKind } from '@shared/composer'
import { builtinCommands } from '@shared/commands'
import type { RichInputHandle } from './RichInput'
import { useMenuBox } from './useMenuBox'

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

/** 光标前面正在敲的「/命令」：在文字里的起点和已经敲进去的内容 */
function slashQuery(text: string, caret: number) {
  const start = text.lastIndexOf('/', caret - 1)
  if (start < 0) return null
  const q = text.slice(start + 1, caret)
  if (/[\s/]/.test(q)) return null
  // 「/」前面得是空白或者开头，不然讲「3/4」的时候也会弹菜单
  if (start > 0 && !/\s/.test(text[start - 1])) return null
  return { start, q }
}

/**
 * 内置命令（shared/commands.ts）：压缩、审查由面板执行；其余的每个 CLI 都能用——CLI 自己有同名命令的（例如
 * Claude Code 的 init）原样发过去，没有的由面板展开成要求
 */
function builtins(scope: SlashScope): Item[] {
  if (scope === 'skills') return []
  return builtinCommands()
    .filter((x) => scope === 'task' || !x.action)
    .map((x) => ({ name: x.name, description: x.description, hint: x.hint, group: 'builtin', action: x.action }))
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
 * 选中后在光标处插入一张行内卡片（面板执行的命令直接执行），发送时由 forSend 把「/名字」提到要求
 * 最前面，再由服务端按 CLI 展开。
 */
export function useSlashMenu({
  cli,
  projectId = '',
  scope,
  setText,
  editor,
  onAction,
}: {
  /** 为空时没有菜单（例如按工作流执行时不知道是哪个 CLI） */
  cli: string
  projectId?: string
  scope: SlashScope
  setText: (v: string) => void
  /** 输入框：菜单按光标前面的「/命令」开，选中后把卡片插到光标处 */
  editor: React.RefObject<RichInputHandle | null>
  onAction?: (a: SlashAction, arg: string) => void
}) {
  const [query, setQuery] = useState<string | null>(null)
  const [cmds, setCmds] = useState<SlashCommand[] | null>(null)
  const [active, setActive] = useState(0)
  const [closed, setClosed] = useState(false)

  /** 光标前面正在敲「/命令」时才是在输命令 */
  const sync = useCallback(() => {
    const el = editor.current
    if (!el) return
    const q = slashQuery(el.text(), el.caret())
    setQuery(q ? q.q : null)
    if (!q) setClosed(false)
  }, [editor])

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
  // 自定义命令和内置命令同名时发出去用的是自定义的（服务端先找 CLI 和「所有 Agent」的命令），菜单里只留它
  const own = new Set((cmds ?? []).map((c) => c.name))
  const all: Item[] = [
    ...builtins(scope).filter((x) => x.action || !own.has(x.name)),
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

  // 菜单的滚动和高度：选中项跟着 ↑↓ 滚进可视区，矮窗口时压短（见 useMenuBox）
  const box = useMenuBox(active, open, 20)

  // 换了关键词或 CLI：回到第一条，菜单也回到顶部，不用等 ↑↓ 才滚回来
  useEffect(() => {
    setActive(0)
    if (box.current) box.current.scrollTop = 0
    // box 是稳定的 ref，不用进依赖
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [kw, cli])

  const pick = (x: Item) => {
    const el = editor.current
    const v = el?.text() ?? ''
    const caret = el?.caret() ?? v.length
    const start = slashQuery(v, caret)?.start ?? caret
    setClosed(true)
    if (x.action && onAction) {
      const rest = (v.slice(0, start) + v.slice(caret)).trim()
      el?.replace(0, v.length, '')
      setText('')
      onAction(x.action, rest)
      return
    }
    // 命令不写进文字：换成一张行内卡片，光标停到它后面接着写
    const kind: ChipKind = x.group === 'skill' ? 'skill' : 'command'
    el?.replace(start, caret, `${chipMarker(kind, x.name)} `)
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
    // 选的是 CLI 自己的同名命令（行内卡片）时按命令发，不要当成面板的压缩 / 审查
    if (commandChip(editor.current?.text() ?? '') || scope !== 'task' || !onAction) return false
    const m = /^\/(compact|review)(?:\s+(\S+))?\s*$/.exec(v.trim())
    if (!m) return false
    if (m[1] === 'compact' && m[2]) return false
    onAction(m[1] as SlashAction, m[2] ?? '')
    setText('')
    return true
  }

  const groups: { id: Item['group']; label: string; icon: typeof Terminal }[] = [
    { id: 'builtin', label: t('内置命令'), icon: SquareSlash },
    { id: 'command', label: t('自定义命令'), icon: Terminal },
    { id: 'skill', label: t('Skill'), icon: BookOpen },
  ]
  const menu = open ? (
    <div
      ref={box}
      role="listbox"
      aria-label={t('命令')}
      className="absolute right-3 bottom-full left-3 z-30 mb-2 max-h-[min(20rem,60vh)] overflow-y-auto overscroll-contain rounded-xl border border-line-strong bg-card p-1 shadow-pop"
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
            <div className="px-2.5 pt-2 pb-0.5 text-[0.6875rem] font-medium text-subtle">{g.label}</div>
            {list.map((x) => {
              const i = items.indexOf(x)
              return (
                <button
                  key={`${x.group}:${x.name}`}
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  data-i={i}
                  onMouseDown={(e) => e.preventDefault()}
                  // 用 mousemove 不用 mouseenter：滚动时列表会在鼠标底下换行，mouseenter 会跟着再改一次选中项，来回抖
                  onMouseMove={() => setActive(i)}
                  onClick={() => pick(x)}
                  title={x.description}
                  className={cn(
                    'flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[0.8125rem]',
                    i === active ? 'bg-sel text-fg' : 'text-muted',
                  )}
                >
                  <g.icon className="h-3.5 w-3.5 shrink-0 text-subtle" />
                  <span className="shrink-0 font-mono text-fg">/{x.name}</span>
                  {x.hint && <span className="shrink-0 font-mono text-[0.6875rem] text-subtle">{x.hint}</span>}
                  <span className="min-w-0 flex-1 truncate text-[0.75rem] text-subtle">{x.description}</span>
                  {x.source && (
                    <span className="max-w-[120px] shrink-0 truncate font-mono text-[0.6875rem] text-subtle/80">
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
        <div className="px-2.5 py-2 text-[0.75rem] text-subtle">{t('正在读取 Agent 的命令和 Skill…')}</div>
      )}
    </div>
  ) : null

  return { sync, onKeyDown, menu, intercept }
}
