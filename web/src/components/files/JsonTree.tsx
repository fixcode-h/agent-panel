import { createContext, useContext, useMemo, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { t } from '@shared/i18n'
import { childrenOf, isBranch, parseJsonFile, revealPaths } from '@/lib/json-tree'
import { cn } from '@/lib/utils'

/** 一个节点一次最多画这么多子项：上万项的数组展开时不一下子全画出来 */
const PAGE = 200

/** 搜索时要自动展开的节点（revealPaths）；没在搜索或命中太多时是空的 */
const RevealCtx = createContext<Map<string, number> | null>(null)

const ROW = 'flex items-start rounded-sm hover:bg-fg/4'

/** 值的写法和颜色：和代码高亮用同一套（index.css 的 .hljs-*），树形和源码看着是一个文件 */
function Leaf({ value }: { value: unknown }) {
  if (typeof value === 'string')
    return <span className="hljs-string break-all whitespace-pre-wrap">{JSON.stringify(value)}</span>
  if (typeof value === 'number') return <span className="hljs-number">{String(value)}</span>
  return <span className="hljs-literal">{String(value)}</span>
}

function Node({ name, value, depth, path }: { name?: string | number; value: unknown; depth: number; path: string }) {
  const reveal = useContext(RevealCtx)
  const branch = isBranch(value)
  const kids = useMemo(() => (branch ? childrenOf(value) : []), [branch, value])
  // 默认展开最上面两层（太长的不展开）；用户点过之后按用户的来
  const [picked, setPicked] = useState<boolean | null>(null)
  const [limit, setLimit] = useState(PAGE)
  const need = reveal?.get(path)
  const open = picked ?? (need !== undefined || (depth < 2 && kids.length <= 100))
  // 搜索命中在后面的子项里时，画到那一项为止
  const count = Math.min(kids.length, Math.max(limit, open && need !== undefined ? need + 1 : 0))
  // 每层缩进 1rem；叶子没有箭头，留出箭头的位置和同层的键对齐
  const pad = { paddingLeft: `${depth}rem` }
  const label =
    name === undefined ? null : typeof name === 'number' ? (
      <span className="text-subtle">{name}: </span>
    ) : (
      <>
        <span className="hljs-attr">{JSON.stringify(name)}</span>
        <span className="text-subtle">: </span>
      </>
    )
  if (!branch)
    return (
      <div className={ROW} style={pad}>
        <span className="ml-5 min-w-0">
          {label}
          <Leaf value={value} />
        </span>
      </div>
    )
  const isArr = Array.isArray(value)
  return (
    <>
      <div className={ROW} style={pad}>
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? t('收起') : t('展开')}
          disabled={!kids.length}
          onClick={() => setPicked(!open)}
          className="grid h-[1.6em] w-5 shrink-0 cursor-pointer place-items-center text-subtle hover:text-fg disabled:invisible"
        >
          <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-90')} />
        </button>
        <span className="min-w-0">
          {label}
          <span className="text-muted">{isArr ? '[' : '{'}</span>
          {(!open || !kids.length) && (
            <>
              {kids.length > 0 && (
                <span className="mx-1 text-caption text-subtle">{t('{n} 项', { n: kids.length })}</span>
              )}
              <span className="text-muted">{isArr ? ']' : '}'}</span>
            </>
          )}
        </span>
      </div>
      {open && kids.length > 0 && (
        <>
          {kids.slice(0, count).map(([k, child], i) => (
            <Node key={i} name={k} value={child} depth={depth + 1} path={path ? `${path}/${i}` : String(i)} />
          ))}
          {count < kids.length && (
            <div style={{ paddingLeft: `${depth + 1}rem` }}>
              <button
                type="button"
                onClick={() => setLimit(count + PAGE * 5)}
                className="ml-5 cursor-pointer rounded-sm px-1 text-accent-text hover:bg-hover"
              >
                {t('还有 {n} 项，继续显示', { n: kids.length - count })}
              </button>
            </div>
          )}
          <div className="text-muted" style={{ paddingLeft: `calc(${depth}rem + 1.25rem)` }}>
            {isArr ? ']' : '}'}
          </div>
        </>
      )}
    </>
  )
}

/**
 * 文件弹窗里 JSON 的树形视图：一层层折叠展开，压成一行的 JSON、很深的配置也能看清结构。
 * 没展开的节点不在页面里；搜索时把有命中的节点自动展开（revealPaths），再由弹窗在画出来的字里标出来。
 */
export function JsonTree({
  text,
  path,
  truncated,
  query,
  caseSensitive,
}: {
  text: string
  path: string
  /** 文件太大只读了前面一部分：解析不了时说明是这个原因 */
  truncated?: boolean
  /** 正在搜的词；没在搜时传空串 */
  query: string
  caseSensitive: boolean
}) {
  const parsed = useMemo(() => parseJsonFile(text, path), [text, path])
  const reveal = useMemo(
    () => (parsed.ok && query ? revealPaths(parsed.value, query, caseSensitive) : null),
    [parsed, query, caseSensitive],
  )
  if (!parsed.ok)
    return (
      <p className="p-6 text-body text-subtle">
        {truncated
          ? t('文件太大只读了前面一部分，没法按树形显示。可以切到「阅读」看已读到的内容。')
          : t('这不是合法的 JSON，没法按树形显示：{error}', { error: parsed.error })}
      </p>
    )
  return (
    <RevealCtx.Provider value={reveal}>
      <div className="px-3 py-2 font-mono text-footnote leading-[1.6]">
        <Node value={parsed.value} depth={0} path="" />
      </div>
    </RevealCtx.Provider>
  )
}
