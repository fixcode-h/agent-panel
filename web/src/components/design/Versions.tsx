import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { toast } from '@/lib/toast'
import { Bot, Eye, History, Loader2, RotateCcw, Save, Trash2, X } from 'lucide-react'
import type { DesignVersion, DesignVersionMeta } from '@shared/design'
import type { Component, Vec2, Widget } from '@shared/umg'
import { api, type DesignFull } from '@/lib/api'
import { hhmm } from '@shared/datetime'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/menu'
import { t } from '@shared/i18n'
import { UmgNode, type RenderImage } from './umg-render'
import type { Device } from '@shared/web'

const when = (at: string) => {
  const d = new Date(at)
  return `${d.getMonth() + 1}/${d.getDate()} ${hhmm(d)}`
}

/**
 * 版本：给现在的设计存一个带名字的版本，列出手动存的和自动存的（AI 改之前、恢复之前），
 * 可以和现在并排对比、恢复、删除
 */
export function VersionsButton({
  designId,
  beforeSave,
  onRestored,
  onCompare,
}: {
  designId: string
  /** 存版本前先把页面上的改动保存上去 */
  beforeSave: () => Promise<void>
  onRestored: (d: DesignFull) => void
  onCompare: (v: DesignVersion) => void
}) {
  const [open, setOpen] = useState(false)
  const [list, setList] = useState<DesignVersionMeta[]>()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState('')
  const load = () =>
    api
      .designVersions(designId)
      .then(setList)
      .catch(() => setList([]))
  useEffect(() => {
    if (open) void load()
    // 每次打开时重新取
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [open, designId])
  const save = () =>
    void run('save', async () => {
      await beforeSave()
      await api.saveDesignVersion(designId, name)
      setName('')
      await load()
      toast.success(t('已存为一个版本'))
    })
  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key)
    try {
      await fn()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy('')
    }
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="icon-sm" variant="ghost" aria-label={t('版本')} title={t('版本')}>
          <History className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[340px] p-0">
        <div className="flex gap-1.5 border-b p-2.5">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('版本名，例如：第一稿、给老板看的')}
            className="h-8 text-footnote"
            onKeyDown={(e) => e.key === 'Enter' && !busy && save()}
          />
          <Button size="sm" disabled={!!busy} onClick={save}>
            {busy === 'save' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            {t('存版本')}
          </Button>
        </div>
        <div className="max-h-[360px] overflow-y-auto p-1">
          {!list ? (
            <Loader2 className="mx-auto my-4 h-4 w-4 animate-spin text-subtle" />
          ) : !list.length ? (
            <p className="px-3 py-5 text-center text-footnote leading-relaxed text-subtle">
              {t('还没有版本。AI 每次修改前会自动存一个，也可以在上面手动存。')}
            </p>
          ) : (
            list.map((v) => (
              <div key={v.id} className="group flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-sel/60">
                {v.auto ? (
                  <Bot className="h-3.5 w-3.5 shrink-0 text-subtle" />
                ) : (
                  <Save className="h-3.5 w-3.5 shrink-0 text-accent-text" />
                )}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className={cn('truncate text-footnote', v.auto ? 'text-muted' : 'font-medium')}>{v.name}</span>
                  <span className="text-caption text-subtle">
                    {when(v.at)} · {t('{n} 个控件', { n: v.widgets })}
                  </span>
                </span>
                <button
                  title={t('和现在对比')}
                  aria-label={t('和现在对比')}
                  onClick={() =>
                    void run(`c:${v.id}`, async () => {
                      onCompare(await api.designVersion(designId, v.id))
                      setOpen(false)
                    })
                  }
                  className="grid h-6 w-6 cursor-pointer place-items-center rounded-md text-subtle hover:bg-sel hover:text-fg"
                >
                  {busy === `c:${v.id}` ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Eye className="h-3.5 w-3.5" />
                  )}
                </button>
                <button
                  title={t('恢复到这个版本')}
                  aria-label={t('恢复到这个版本')}
                  onClick={() =>
                    void run(`r:${v.id}`, async () => {
                      await beforeSave()
                      onRestored(await api.restoreDesignVersion(designId, v.id))
                      toast.success(t('已恢复到「{name}」，恢复前的样子也存成了一个版本', { name: v.name }))
                      setOpen(false)
                    })
                  }
                  className="grid h-6 w-6 cursor-pointer place-items-center rounded-md text-subtle hover:bg-sel hover:text-fg"
                >
                  {busy === `r:${v.id}` ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RotateCcw className="h-3.5 w-3.5" />
                  )}
                </button>
                <button
                  title={t('删除这个版本')}
                  aria-label={t('删除这个版本')}
                  onClick={() =>
                    void run(`d:${v.id}`, async () => {
                      await api.deleteDesignVersion(designId, v.id)
                      setList((l) => l?.filter((x) => x.id !== v.id))
                    })
                  }
                  className="grid h-6 w-6 cursor-pointer place-items-center rounded-md text-subtle opacity-0 group-hover:opacity-100 hover:bg-sel hover:text-danger"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** 盖在画布区域上的对比：左边是版本，右边是现在，按同样的比例缩放 */
export function VersionCompare({
  version,
  current,
  images,
  device,
  onRestore,
  onClose,
}: {
  version: DesignVersion
  current: { root: Widget; components: Component[]; designSize: Vec2 }
  images: Map<string, RenderImage>
  device?: Device
  onRestore: () => void
  onClose: () => void
}) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [onClose])
  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-canvas animate-[fade-in_120ms_ease-out]">
      <div className="flex h-11 shrink-0 items-center gap-2 pr-3 pl-[max(0.75rem,var(--board-switch-w,0px))] text-footnote text-canvas-fg">
        <span className="font-medium text-canvas-strong">{t('对比版本')}</span>
        <span className="flex-1" />
        <Button size="sm" onClick={onRestore}>
          <RotateCcw className="h-3.5 w-3.5" />
          {t('恢复到这个版本')}
        </Button>
        <Button variant="on-canvas" size="icon-sm" onClick={onClose} aria-label={t('关闭对比')} title={t('关闭对比')}>
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-2 gap-3 px-3 pb-3">
        <Pane label={`${version.name} · ${when(version.at)}`} tree={version.snapshot} images={images} device={device} />
        <Pane label={t('现在')} tree={current} images={images} device={device} />
      </div>
    </div>
  )
}

function Pane({
  label,
  tree,
  images,
  device,
}: {
  label: string
  tree: { root: Widget; components: Component[]; designSize: Vec2 }
  images: Map<string, RenderImage>
  device?: Device
}) {
  const box = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0)
  const { X, Y } = tree.designSize
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const fit = () => setScale(Math.min(el.clientWidth / X, el.clientHeight / Y) * 0.96)
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [X, Y])
  return (
    <div className="flex min-h-0 flex-col gap-1.5">
      <p className="truncate text-caption text-canvas-subtle">{label}</p>
      <div ref={box} className="relative min-h-0 flex-1 overflow-hidden rounded-lg bg-canvas-board/60">
        {scale > 0 && (
          <div
            className="pointer-events-none absolute top-1/2 left-1/2 overflow-hidden bg-canvas-board"
            style={{ width: X, height: Y, transform: `translate(-50%, -50%) scale(${scale})` }}
          >
            <UmgNode
              w={tree.root}
              ctx={{
                images,
                components: new Map(tree.components.map((c) => [c.Name, c])),
                interactive: false,
                depth: 0,
                device,
              }}
            />
          </div>
        )}
      </div>
    </div>
  )
}
