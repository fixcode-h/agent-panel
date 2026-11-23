import { Box } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { t } from '@shared/i18n'
import { TreeList, type TreeLine } from './tree-list'
import { SearchBox } from '../search-box'

/**
 * 树的即时搜索（用户 2026-11-15「加个搜索框」）：UObject 树、控件树共用。
 * 按名字或类名筛，不分大小写；命中的节点连同一路的父节点都留着并自动展开，命中的字高亮。
 * 只筛网页上已经读到的节点（懒加载的树没展开过的层不在里面），所以不发请求、边打字边筛
 */

/** 关键词出现在任一字段里（不分大小写）；空关键词算全都命中 */
export function hitText(q: string, ...fields: (string | undefined)[]) {
  const k = q.trim().toLowerCase()
  if (!k) return true
  return fields.some((f) => !!f && f.toLowerCase().includes(k))
}

/**
 * 要留下的节点：自己命中，或下面（已读到的）有命中的。返回这些节点的 key 集合和自己命中的个数。
 * 一遍算完存成集合，画每一行时只查集合，几千个节点也不用每行再往下递归
 */
export function keepSet<N>(roots: N[], kidsOf: (n: N) => N[], keyOf: (n: N) => string, test: (n: N) => boolean) {
  const keep = new Set<string>()
  const seen = new Set<string>()
  let hits = 0
  const walk = (n: N): boolean => {
    const k = keyOf(n)
    // 防环：同一个节点只看一次（Outer 链按理是树，但读到的数据不保证）
    if (seen.has(k)) return keep.has(k)
    seen.add(k)
    let any = false
    for (const c of kidsOf(n)) if (walk(c)) any = true
    const self = test(n)
    if (self) hits++
    if (self || any) keep.add(k)
    return self || any
  }
  for (const r of roots) walk(r)
  return { keep, hits }
}

/** 命中的字标成强调色底（和面板设置搜索的高亮一样） */
export function Hit({ text, q }: { text: string; q: string }) {
  const k = q.trim().toLowerCase()
  if (!k) return <>{text}</>
  const low = text.toLowerCase()
  const parts: { s: string; hit: boolean }[] = []
  let at = 0
  for (let i = low.indexOf(k); i >= 0; i = low.indexOf(k, at)) {
    if (i > at) parts.push({ s: text.slice(at, i), hit: false })
    parts.push({ s: text.slice(i, i + k.length), hit: true })
    at = i + k.length
  }
  if (at < text.length) parts.push({ s: text.slice(at), hit: false })
  return (
    <>
      {parts.map((p, i) =>
        p.hit ? (
          <mark key={i} className="rounded-[3px] bg-accent-soft text-accent-text">
            {p.s}
          </mark>
        ) : (
          p.s
        ),
      )}
    </>
  )
}

/**
 * 树上方的搜索条：输入框（边打字边筛）+ 下面一行小字说命中几个；partial 时提醒只搜了已读到的层。
 * value 由调用方管（UObject 树要切页面回来还留着）
 */
export function TreeSearch({
  value,
  onChange,
  placeholder,
  hits,
  partial,
  busy,
  extra,
  addon,
  onEnter,
  onFocusChange,
}: {
  value: string
  onChange: (q: string) => void
  placeholder: string
  /** 命中的节点数；没在搜时不显示 */
  hits?: number
  /** 树是懒加载的：只搜了已经展开读过的层 */
  partial?: boolean
  /** 结果还没回来（要问服务端的搜索）：先写「搜索中…」，不说没有匹配 */
  busy?: boolean
  /** 命中数后面再补一句（截断、数据来源） */
  extra?: ReactNode
  /** 输入框里最右边的小控件（资源页的类型筛选） */
  addon?: ReactNode
  /** 按回车：要问整个项目的搜索（资源页）回车立刻全力搜，不等停手 */
  onEnter?: (q: string) => void
  /** 输入框焦点变化：点进来就先准备数据 */
  onFocusChange?: (focused: boolean) => void
}) {
  const q = value.trim()
  return (
    <div className="flex flex-col gap-1.5 border-b border-line px-3 py-2">
      <SearchBox
        initial={value}
        placeholder={placeholder}
        onSearch={onChange}
        allowEmpty
        live
        addon={addon}
        onEnter={onEnter}
        onFocusChange={onFocusChange}
      />
      {q && (
        <span className="text-caption text-subtle">
          {busy ? t('搜索中…') : hits ? t('{n} 个匹配', { n: hits }) : t('没有匹配的')}
          {partial && ` · ${t('只搜已经展开过的层，没展开的层先展开再搜')}`}
          {extra && !busy && <> · {extra}</>}
        </span>
      )}
    </div>
  )
}

/** 设置 →「组件」里的示例：一棵小树配搜索条，打字看筛选和高亮 */
export function TreeSearchSpecimen() {
  const [q, setQ] = useState('sub')
  const tree = SAMPLE
  const lines = useMemo(() => {
    const { keep, hits } = keepSet(
      tree,
      (n) => n.kids ?? [],
      (n) => n.name,
      (n) => hitText(q, n.name, n.cls),
    )
    const out: TreeLine[] = []
    const walk = (list: SampleNode[], depth: number) => {
      for (const n of list) {
        if (q.trim() && !keep.has(n.name)) continue
        out.push({
          key: n.name,
          depth,
          label: <Hit text={n.name} q={q} />,
          icon: Box,
          expandable: !!n.kids?.length,
          open: true,
          selected: false,
          aside: <Hit text={n.cls} q={q} />,
        })
        walk(n.kids ?? [], depth + 1)
      }
    }
    walk(tree, 0)
    return { out, hits }
  }, [q, tree])
  return (
    <div className="flex h-64 w-full max-w-md flex-col overflow-hidden rounded-lg border border-line bg-card">
      <TreeSearch value={q} onChange={setQ} placeholder={t('按名字或类名筛')} hits={lines.hits} partial />
      <TreeList lines={lines.out} label={t('UObject 树')} />
    </div>
  )
}

interface SampleNode {
  name: string
  cls: string
  kids?: SampleNode[]
}
const SAMPLE: SampleNode[] = [
  {
    name: 'GameInstance_0',
    cls: 'GameInstance',
    kids: [
      { name: 'CommonUISubsystemBase_0', cls: 'CommonUISubsystemBase' },
      { name: 'OnlineSession_0', cls: 'OnlineSession' },
      { name: 'UMG_Main_C_0', cls: 'UMG_Main_C' },
    ],
  },
  { name: 'MainMap', cls: 'World', kids: [{ name: 'PersistentLevel', cls: 'Level' }] },
  {
    name: 'UnrealEdEngine_0',
    cls: 'UnrealEdEngine',
    kids: [{ name: 'AssetEditorSubsystem_0', cls: 'AssetEditorSubsystem' }],
  },
]
