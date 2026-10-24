import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { DesignDoc, DesignImage, DesignJob } from '@shared/design'
import type { Widget } from '@shared/umg'
import { api, type DesignFull } from '@/lib/api'
import type { SaveStatus } from '@/lib/useAutosave'
import { useData } from '@/lib/data'
import { t } from '@shared/i18n'

const docOf = (d: DesignFull): DesignDoc => ({
  title: d.title,
  designSize: d.designSize,
  style: d.style,
  root: d.root,
  components: d.components,
  images: d.images,
  annotations: d.annotations ?? [],
  animations: d.animations ?? [],
})

/**
 * 服务端的图片（生成结果、状态）合进本地：本地能改的只有名字、九宫格、选哪一版；
 * 本地刚删掉、还没保存上去的图片不要被合回来。
 */
function mergeImages(local: DesignImage[], remote: DesignImage[], deleted: Set<string>) {
  const out = local.map((l) => {
    const r = remote.find((x) => x.id === l.id)
    if (!r) return l
    const grown = r.variants.length !== l.variants.length
    return { ...l, variants: r.variants, status: r.status, error: r.error, selected: grown ? r.selected : l.selected }
  })
  for (const r of remote) if (!local.some((l) => l.id === r.id) && !deleted.has(r.id)) out.push(r)
  return out
}

/**
 * 设计器的状态：本地编辑的副本（自动保存）、撤销 / 重做、AI 对话和生成图片时的轮询。
 * AI 改了结构（rev 变大）时用服务端的树替换本地的，替换前的状态放进撤销栈，可以退回去。
 */
export function useDesignEditor(id: string) {
  const { setDesigns } = useData()
  const [server, setServer] = useState<DesignFull>()
  const [doc, setDoc] = useState<DesignDoc>()
  const [error, setError] = useState('')
  const rev = useRef(0)
  const past = useRef<DesignDoc[]>([])
  const future = useRef<DesignDoc[]>([])
  const lastKey = useRef<{ key: string; at: number }>({ key: '', at: 0 })
  const deleted = useRef(new Set<string>())
  const [, bump] = useState(0)
  /** 服务端已经有的内容；本地和它一样就不用保存 */
  const saved = useRef('')
  const [save, setSave] = useState<{ status: SaveStatus; error: string }>({ status: 'idle', error: '' })

  const current = useRef(id)
  current.current = id
  const absorb = useCallback(
    (d: DesignFull) => {
      // 切到别的设计后，上一个设计迟到的响应不要用
      if (d.id !== current.current) return
      setServer(d)
      // 轮询每 1.2 秒来一次：标题、更新时间、执行状态都没变时沿用原数组，
      // 侧栏和设计列表不用跟着重新渲染
      setDesigns((list) => {
        const i = list.findIndex((x) => x.id === d.id)
        if (i < 0) return list
        const cur = list[i]
        const running = d.job?.status === 'running'
        if (cur.title === d.title && cur.updatedAt === d.updatedAt && cur.running === running) return list
        const next = list.slice()
        next[i] = { ...cur, title: d.title, updatedAt: d.updatedAt, running }
        return next
      })
      setDoc((cur) => {
        if (!cur) {
          rev.current = d.rev
          saved.current = JSON.stringify(docOf(d))
          return docOf(d)
        }
        if (d.rev > rev.current) {
          rev.current = d.rev
          past.current.push(cur)
          future.current = []
          const deletedNow = deleted.current
          const next = { ...docOf(d), images: d.images.filter((i) => !deletedNow.has(i.id)) }
          saved.current = JSON.stringify(docOf(d))
          return next
        }
        const images = mergeImages(cur.images, d.images, deleted.current)
        return JSON.stringify(images) === JSON.stringify(cur.images) ? cur : { ...cur, images }
      })
    },
    [setDesigns],
  )

  useEffect(() => {
    setServer(undefined)
    setDoc(undefined)
    setError('')
    past.current = []
    future.current = []
    deleted.current = new Set()
    api
      .design(id)
      .then(absorb)
      .catch((e) => setError((e as Error).message))
  }, [id, absorb])

  // 有 AI 对话或生成图片在进行时轮询
  const running = server?.job?.status === 'running' || !!server?.images.some((i) => i.status === 'generating')
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => {
      api
        .design(id)
        .then(absorb)
        .catch(() => {})
    }, 1200)
    return () => clearInterval(timer)
  }, [running, id, absorb])

  // AI 要的截图走长轮询：后台标签页里 setInterval 会被浏览器节流到一分钟一次，
  // 而已经挂着的 fetch 一有响应就继续执行，截图请求才不会等到 20 秒超时。
  // 页面打开着就一直挂着，不依赖 running（AI 可能在页面切到后台以后才开始）
  useEffect(() => {
    // 在线演示没有真实后端，不会有人要截图
    if (import.meta.env.VITE_DEMO) return
    const ctrl = new AbortController()
    let retry: ReturnType<typeof setTimeout> | undefined
    const loop = async () => {
      while (!ctrl.signal.aborted) {
        try {
          const r = await api.designCaptureWait(id, ctrl.signal)
          if (ctrl.signal.aborted) return
          const cap = r.capture
          if (cap) {
            setServer((cur) => {
              if (!cur || cur.job?.capture?.id === cap.id) return cur
              // 页面还没轮询到 running（后台被节流）时也补一个状态，否则截图组件不挂载
              const job: DesignJob = cur.job ?? {
                status: 'running',
                phase: 'design',
                text: '',
                outChars: 0,
                attempt: 1,
                startedAt: Date.now(),
              }
              return { ...cur, job: { ...job, capture: cap } }
            })
          }
        } catch {
          if (ctrl.signal.aborted) return
          // 后端暂时不可用（重启、页面刚切回来）：歇一下再连，不刷请求
          await new Promise<void>((r) => {
            retry = setTimeout(r, 2000)
          })
        }
      }
    }
    void loop()
    return () => {
      ctrl.abort()
      if (retry) clearTimeout(retry)
    }
  }, [id])

  // 自动保存：停下 500ms 后保存；离开页面时补存
  const latest = useRef(doc)
  latest.current = doc
  const flush = useCallback(async () => {
    const v = latest.current
    if (!v || !v.title.trim()) return
    const json = JSON.stringify(v)
    if (json === saved.current) return
    setSave({ status: 'saving', error: '' })
    try {
      saved.current = json
      const res = await api.saveDesign(id, v)
      if (id === current.current) absorb(res)
      setSave({ status: 'saved', error: '' })
    } catch (e) {
      saved.current = ''
      setSave({ status: 'error', error: (e as Error).message })
    }
  }, [id, absorb])
  useEffect(() => {
    if (!doc || JSON.stringify(doc) === saved.current) return
    setSave((s) => ({ ...s, status: 'pending' }))
    const timer = setTimeout(() => void flush(), 500)
    return () => clearTimeout(timer)
  }, [doc, flush])
  useEffect(() => () => void flush(), [flush])

  /** 改设计：key 相同、间隔很短的连续修改（拖动、输入）合成一步撤销 */
  const change = useCallback((fn: (d: DesignDoc) => DesignDoc, key = '') => {
    setDoc((cur) => {
      if (!cur) return cur
      const next = fn(cur)
      if (next === cur) return cur
      const now = Date.now()
      if (!key || key !== lastKey.current.key || now - lastKey.current.at > 800) {
        past.current.push(cur)
        if (past.current.length > 200) past.current.shift()
      }
      lastKey.current = { key, at: now }
      future.current = []
      for (const i of cur.images) if (!next.images.some((x) => x.id === i.id)) deleted.current.add(i.id)
      return next
    })
  }, [])

  const undo = () => {
    const prev = past.current.pop()
    if (!prev || !doc) return
    future.current.push(doc)
    lastKey.current = { key: '', at: 0 }
    setDoc({ ...prev, images: mergeImages(prev.images, server?.images ?? [], deleted.current) })
    bump((n) => n + 1)
  }
  const redo = () => {
    const next = future.current.pop()
    if (!next || !doc) return
    past.current.push(doc)
    lastKey.current = { key: '', at: 0 }
    setDoc(next)
    bump((n) => n + 1)
  }

  return {
    server,
    doc,
    error,
    save,
    /** 马上存下还没存的改动（让 CLI 读设计前用） */
    flush,
    change,
    absorb,
    undo,
    redo,
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
    running: server?.job?.status === 'running',
    reload: () =>
      api
        .design(id)
        .then(absorb)
        .catch((e) => toast.error((e as Error).message)),
  }
}

/** 正在编辑的那棵树：主界面或某个子控件 */
export function treeOf(doc: DesignDoc, target: string): Widget | undefined {
  return target ? doc.components.find((c) => c.Name === target)?.Root : doc.root
}
export function setTree(doc: DesignDoc, target: string, root: Widget): DesignDoc {
  if (!target) return { ...doc, root }
  return { ...doc, components: doc.components.map((c) => (c.Name === target ? { ...c, Root: root } : c)) }
}

export const errorText = (e: unknown) => (e as Error)?.message ?? t('未知错误')
