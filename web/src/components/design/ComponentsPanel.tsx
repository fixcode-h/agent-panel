import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Plus } from 'lucide-react'
import type { ProjectComponents } from '@shared/design'
import type { Component } from '@shared/umg'
import { api, designFileUrl } from '@/lib/api'
import { cn } from '@/lib/utils'
import { t } from '@shared/i18n'
import { UmgNode, type RenderImage } from './umg-render'

/**
 * 「控件」列表：这个 UI 项目里所有设计已经做好的子控件。
 * 这个设计自己的点一下就进去编辑；别的设计的可以连同它用到的图片一起加进这个设计复用
 */
export function ComponentsPanel({
  projectId,
  designId,
  kind,
  own,
  onOpen,
  onImport,
}: {
  projectId: string
  designId: string
  /** 只列同一种设计（游戏 UI / 网页 UI）的子控件 */
  kind: 'game' | 'web'
  /** 这个设计现在的子控件名（变了就重新取列表） */
  own: string[]
  onOpen: (name: string) => void
  onImport: (from: string, name: string) => Promise<void>
}) {
  const [list, setList] = useState<ProjectComponents[]>()
  const [importing, setImporting] = useState('')
  const key = own.join('|')
  useEffect(() => {
    let alive = true
    api
      .projectComponents(projectId)
      .then((l) => alive && setList(l))
      .catch(() => alive && setList([]))
    return () => {
      alive = false
    }
  }, [projectId, key])

  // 这个设计排在最前面
  const groups = useMemo(
    () =>
      (list ?? [])
        // 游戏 UI 和网页 UI 的控件不能混用
        .filter((g) => (g.kind ?? 'game') === kind)
        .sort((a, b) => Number(b.designId === designId) - Number(a.designId === designId)),
    [list, designId, kind],
  )
  if (!list) return <Loader2 className="mx-auto mt-6 h-4 w-4 animate-spin text-subtle" />
  if (!groups.length)
    return (
      <p className="px-4 py-6 text-center text-[0.75rem] leading-relaxed text-subtle">
        {t('这个项目里还没有子控件。让 AI 把重复的部分（列表项、格子、按钮）做成子控件，就会出现在这里。')}
      </p>
    )
  return (
    <div className="flex flex-col gap-3 p-2">
      {groups.map((g) => {
        const mine = g.designId === designId
        const images = new Map<string, RenderImage>(
          g.images.map((i) => [i.id, { url: designFileUrl(g.designId, i.file), width: i.width, height: i.height }]),
        )
        const comps = new Map(g.components.map((c) => [c.Name, c]))
        return (
          <section key={g.designId}>
            <h3 className="mb-1.5 truncate px-1 text-[0.6875rem] font-medium text-subtle">
              {mine ? t('这个设计') : g.title}
            </h3>
            <div className="grid grid-cols-2 gap-2">
              {g.components.map((c) => {
                const has = own.includes(c.Name)
                const id = `${g.designId}:${c.Name}`
                return (
                  <div
                    key={c.Name}
                    role={mine ? 'button' : undefined}
                    tabIndex={mine ? 0 : undefined}
                    onClick={mine ? () => onOpen(c.Name) : undefined}
                    onKeyDown={mine ? (e) => e.key === 'Enter' && onOpen(c.Name) : undefined}
                    title={mine ? t('点击编辑这个子控件') : undefined}
                    className={cn(
                      'group flex flex-col overflow-hidden rounded-lg border bg-field text-left transition-colors',
                      mine && 'cursor-pointer hover:border-line-strong',
                    )}
                  >
                    <Preview comp={c} images={images} components={comps} />
                    <span className="flex items-center gap-1 px-1.5 py-1">
                      <span className="min-w-0 flex-1 truncate font-mono text-[0.6875rem]">{c.Name}</span>
                      <span className="shrink-0 font-mono text-[0.625rem] text-subtle">
                        {c.DesignSize.X}×{c.DesignSize.Y}
                      </span>
                    </span>
                    {!mine && (
                      <button
                        disabled={has || !!importing}
                        onClick={() => {
                          setImporting(id)
                          void onImport(g.designId, c.Name).finally(() => setImporting(''))
                        }}
                        title={has ? t('这个设计里已经有同名的子控件') : t('连同它用到的图片一起加进这个设计')}
                        className="mx-1.5 mb-1.5 inline-flex h-6 cursor-pointer items-center justify-center gap-1 rounded-md border text-[0.6875rem] text-muted hover:bg-sel hover:text-fg disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent"
                      >
                        {importing === id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
                        {has ? t('已在这个设计里') : t('加入这个设计')}
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          </section>
        )
      })}
    </div>
  )
}

/** 子控件的缩略图：按卡片大小等比缩放画出来 */
function Preview({
  comp,
  images,
  components,
}: {
  comp: Component
  images: Map<string, RenderImage>
  components: Map<string, Component>
}) {
  const box = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const fit = () =>
      setScale(Math.min(el.clientWidth / comp.DesignSize.X, el.clientHeight / comp.DesignSize.Y, 2) * 0.9)
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [comp.DesignSize.X, comp.DesignSize.Y])
  return (
    <div ref={box} className="relative aspect-square w-full overflow-hidden bg-[#18181a]">
      {scale > 0 && (
        <div
          className="pointer-events-none absolute top-1/2 left-1/2 flex"
          style={{
            width: comp.DesignSize.X,
            height: comp.DesignSize.Y,
            transform: `translate(-50%, -50%) scale(${scale})`,
          }}
        >
          <UmgNode w={comp.Root} ctx={{ images, components, interactive: false, depth: 1 }} />
        </div>
      )}
    </div>
  )
}
