import { Eye, Layers, Loader2 } from 'lucide-react'
import { t } from '@shared/i18n'
import type { DesignImage } from '@shared/design'
import type { RestoreState } from '@shared/restore/schema'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'

/** 切图这一步：干净背景放最前面，其余按元素顺序；每张标出和原画的相似度、被几个元素共用 */
export function AssetsView({
  restore,
  images,
  url,
  min,
}: {
  restore: RestoreState
  images: DesignImage[]
  url: (img: DesignImage) => string | undefined
  min: number
}) {
  const list = images.filter((i) => i.id.startsWith('rs_'))
  if (!list.length) return <Empty text={t('还没有切图：确认上一步后自动从原画里抠')} />
  const uses = new Map<string, number>()
  for (const e of restore.elements) if (e.image && !e.hidden) uses.set(e.image, (uses.get(e.image) ?? 0) + 1)
  const simOf = (id: string) => restore.elements.find((e) => `rs_${e.id}` === id)?.sim
  const ordered = [...list.filter((i) => i.id === restore.plate), ...list.filter((i) => i.id !== restore.plate)]
  return (
    <div
      data-restore-assets
      className="grid min-h-0 flex-1 auto-rows-max grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-2 overflow-y-auto bg-canvas p-3"
    >
      {ordered.map((img) => {
        const sim = simOf(img.id)
        const n = uses.get(img.id) ?? 0
        const plate = img.id === restore.plate
        return (
          <figure
            key={img.id}
            className={cn('flex flex-col gap-1 rounded-lg bg-canvas-bar p-1.5', plate && 'col-span-2 row-span-2')}
          >
            <div className="grid aspect-square place-items-center overflow-hidden rounded-md bg-canvas-checker">
              {url(img) && <img src={url(img)} alt={img.name} className="max-h-full max-w-full object-contain" />}
            </div>
            <figcaption className="flex items-center gap-1 text-caption text-canvas-fg">
              <span className="min-w-0 flex-1 truncate">{plate ? t('干净背景') : img.name}</span>
              {img.nineSlice && <span title={t('九宫格：拉伸时边框不变形')}>9</span>}
              {n > 1 && <span title={t('{n} 个元素共用这张', { n })}>×{n}</span>}
              {sim !== undefined && (
                <span className={cn('tabular-nums', sim < min ? 'text-warning' : 'text-canvas-subtle')}>
                  {sim.toFixed(2)}
                </span>
              )}
            </figcaption>
          </figure>
        )
      })}
    </div>
  )
}

/** 校验这一步：每个元素和搭出来的控件差多少；没过的排前面，可以「接受差异」 */
export function VerifyView({
  restore,
  onAccept,
  onCompare,
  busy,
}: {
  restore: RestoreState
  onAccept: (element: string, on: boolean) => void
  onCompare: () => void
  busy: boolean
}) {
  const s = restore.score
  if (!s) return <Empty text={t('还没有校验：搭建确认后自动逐个核对')} />
  const byId = new Map(restore.elements.map((e) => [e.id, e]))
  const items = [...s.items].sort((a, b) => Number(a.ok) - Number(b.ok))
  const why = (w: string) =>
    w
      .split(',')
      .filter(Boolean)
      .map(
        (x) =>
          ({ missing: t('控件不见了'), position: t('位置不对'), asset: t('切图不像'), text: t('文字没内容') })[x] ?? x,
      )
      .join('、')
  const n = (v: number) => (Math.abs(v) < 0.05 ? '0' : v > 0 ? `+${v}` : String(v))
  return (
    <div data-restore-verify className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <span className="text-body font-medium">{t('{ok}/{all} 个元素对上', { ok: s.posOk, all: s.posTotal })}</span>
        <span className="flex-1" />
        <Button size="sm" variant="secondary" onClick={onCompare}>
          <Eye className="h-3.5 w-3.5" />
          {t('在画布上对照原画')}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <table className="w-full text-footnote tabular-nums">
          <thead className="sticky top-0 bg-card text-left text-caption text-subtle">
            <tr>
              <th className="px-3 py-1.5 font-normal">{t('元素')}</th>
              <th className="px-1 py-1.5 font-normal">Δx</th>
              <th className="px-1 py-1.5 font-normal">Δy</th>
              <th className="px-1 py-1.5 font-normal">Δw</th>
              <th className="px-1 py-1.5 font-normal">Δh</th>
              <th className="px-1 py-1.5 font-normal">{t('相似度')}</th>
              <th className="px-3 py-1.5 font-normal">{t('结果')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.element} data-check={i.ok ? 'ok' : 'bad'} className="border-t border-line/60">
                <td className="max-w-[200px] truncate px-3 py-1.5">
                  {byId.get(i.element)?.name || i.widget || i.element}
                </td>
                <td className="px-1">{n(i.dx)}</td>
                <td className="px-1">{n(i.dy)}</td>
                <td className="px-1">{n(i.dw)}</td>
                <td className="px-1">{n(i.dh)}</td>
                <td className="px-1">{i.sim?.toFixed(2) ?? '–'}</td>
                <td className="px-3">
                  {i.why ? (
                    <label className="flex items-center gap-1.5">
                      <span className={cn(i.accepted ? 'text-subtle line-through' : 'text-warning')}>{why(i.why)}</span>
                      <Switch
                        checked={!!i.accepted}
                        disabled={busy}
                        onCheckedChange={(on) => onAccept(i.element, on)}
                        aria-label={t('接受差异')}
                      />
                    </label>
                  ) : (
                    <span className="text-success">{t('对上')}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** 搭建、交付这两步：结论在右边卡上，这里给去画布的入口 */
export function CanvasHint({ text, onOpen }: { text: string; onOpen: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-canvas p-6 text-center">
      <Layers className="h-6 w-6 text-canvas-subtle" />
      <p className="max-w-[420px] text-body text-canvas-fg">{text}</p>
      <Button size="sm" onClick={onOpen} data-restore-open-canvas>
        {t('在画布里看')}
      </Button>
    </div>
  )
}

export function Empty({ text, busy }: { text: string; busy?: boolean }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center gap-2 bg-canvas p-6 text-body text-canvas-subtle">
      {busy && <Loader2 className="h-4 w-4 animate-spin" />}
      {text}
    </div>
  )
}
