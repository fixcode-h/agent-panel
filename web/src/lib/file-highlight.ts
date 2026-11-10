import { useEffect, useState } from 'react'
import { ensureHljs } from '@/lib/workflow-doc'
import { highlightLines, langOf, type HlLines, type Hljs } from '@/lib/file-highlight-core'

export * from '@/lib/file-highlight-core'

/**
 * 文件弹窗的语法高亮：阅读时按行拆开带行号，编辑时只给看得见的几十行上色。
 * highlight.js 体积不小，按需加载（useHljs），没加载完或认不出语言时按纯文本显示。
 * 整个文件的高亮放到后台线程算（useHighlightedLines），算完之前先显示没有颜色的文字，页面不卡。
 */

/** 高亮结果缓存：重开同一个文件、阅读 / 编辑来回切时不再重算。按字数限总量，最久没用的先丢 */
const CACHE_MAX = 12
const CACHE_MAX_CHARS = 4_000_000
const cache = new Map<string, { lines: HlLines | null; chars: number }>()
let cacheChars = 0

const keyOf = (path: string, code: string) => `${path}\0${code}`

export function cachedHighlight(path: string, code: string) {
  const key = keyOf(path, code)
  const hit = cache.get(key)
  if (!hit) return undefined
  // 命中后挪到末尾：Map 的插入顺序就是最近使用顺序
  cache.delete(key)
  cache.set(key, hit)
  return hit.lines
}

export function rememberHighlight(path: string, code: string, lines: HlLines | null) {
  const key = keyOf(path, code)
  const old = cache.get(key)
  if (old) cacheChars -= old.chars
  const chars = key.length + (lines?.reduce((n, l) => n + (l?.length ?? 0), 0) ?? 0)
  // 一份就超过上限的不存：存进去也会马上把别的都挤掉
  if (chars > CACHE_MAX_CHARS) return
  cache.delete(key)
  cache.set(key, { lines, chars })
  cacheChars += chars
  while (cache.size > CACHE_MAX || cacheChars > CACHE_MAX_CHARS) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cacheChars -= cache.get(oldest)?.chars ?? 0
    cache.delete(oldest)
  }
}

type Pending = (lines: HlLines | null) => void
let worker: Worker | null | undefined
let seq = 0
const waiting = new Map<number, Pending>()

/** 后台线程：第一次用时才建；建不了（老浏览器、被禁用）时返回 null，退回主线程算 */
function highlightWorker() {
  if (worker !== undefined) return worker
  try {
    worker = new Worker(new URL('./highlight.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<{ id: number; lines: HlLines | null }>) => {
      waiting.get(e.data.id)?.(e.data.lines)
      waiting.delete(e.data.id)
    }
    // 后台线程出错（脚本加载失败）：手上等着的都退回主线程，以后也不再用它
    worker.onerror = () => {
      worker?.terminate()
      worker = null
      const left = [...waiting.values()]
      waiting.clear()
      for (const done of left) done(undefined as never)
    }
  } catch {
    worker = null
  }
  return worker
}

/** 在主线程上算：后台线程不可用时的退路 */
async function highlightHere(code: string, path: string) {
  return highlightLines(await ensureHljs(), code, path)
}

function highlightAsync(code: string, path: string): Promise<HlLines | null> {
  const w = highlightWorker()
  if (!w) return highlightHere(code, path)
  return new Promise((resolve) => {
    const id = ++seq
    // 后台线程出错时会用 undefined 回调：这时改在主线程算
    waiting.set(id, (lines) => (lines === undefined ? void highlightHere(code, path).then(resolve) : resolve(lines)))
    w.postMessage({ id, code, path })
  })
}

/**
 * 整个文件按行高亮，结果缓存。on 为 false（编辑中、截断的文件）时不算。
 * 认不出语言的文件直接返回 null，不必绕一趟后台线程
 */
export function useHighlightedLines(code: string, path: string, on: boolean) {
  const hl = useHljs()
  const want = on && !!code && (!hl || !!langOf(hl, path))
  const hit = want ? cachedHighlight(path, code) : undefined
  const [got, setGot] = useState<{ path: string; code: string; lines: HlLines | null } | null>(null)
  useEffect(() => {
    if (!want || hit !== undefined) return
    let alive = true
    void highlightAsync(code, path).then((lines) => {
      rememberHighlight(path, code, lines)
      if (alive) setGot({ path, code, lines })
    })
    return () => {
      alive = false
    }
  }, [want, hit, code, path])
  if (!want) return null
  if (hit !== undefined) return hit
  return got && got.path === path && got.code === code ? got.lines : null
}

/** 高亮库按需加载：加载完这次渲染就有颜色了 */
export function useHljs() {
  const [hl, setHl] = useState<Hljs | null>(null)
  useEffect(() => {
    let alive = true
    void ensureHljs().then((h) => alive && setHl(h))
    return () => {
      alive = false
    }
  }, [])
  return hl
}

/** 文件大小：1 KB 以下给字节，再往上给 KB / MB，单位不用翻 */
export function sizeText(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
