import { useLayoutEffect, useRef, useState } from 'react'
import { BadgeCheck, Check, ImagePlus, Loader2, Send, Trash2, Undo2 } from 'lucide-react'
import { toast } from '@/lib/toast'
import {
  hasMask,
  maskBox,
  sendsMaskOnly,
  type Annotation,
  type AnnotationKind,
  type ConceptImage,
  type ConceptJob,
  type ConceptState,
} from '@shared/design'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { t } from '@shared/i18n'
import { AnnotationLayer, AnnotationToolbar, isMarkTool, type Tool } from './Annotations'
import { readFile } from './ImagesPanel'

/**
 * 原画面板：占满左边的画布区域。上面是标注工具和操作，中间是正在看的那张（可以在上面标出要改的地方），
 * 下面按轮次列出所有候选。确认一张作为模板后，AI 照着它搭界面、出切图
 */
export function ConceptBoard({
  concept,
  url,
  marks,
  onMarks,
  onSelect,
  onApprove,
  onRemove,
  onUpload,
  onSendMarks,
  /** 这次发送会走「只重绘蒙版区域」：只发蒙版这一块，其余标注会留在图上 */
  inpaint,
  /** 当前生成方式支持局部重绘（只有本机 ComfyUI）：不支持时勾了也只整张重画，按钮不能写成「按蒙版重绘」 */
  inpaintSupported,
  progress,
  busy,
}: {
  concept: ConceptState
  /** 原画的图片地址 */
  url: (c: ConceptImage) => string
  /** 全部原画上的标注（target 是 concept:<id>） */
  marks: Annotation[]
  /** 换掉某张原画上的标注 */
  onMarks: (id: string, list: Annotation[]) => void
  onSelect: (id: string) => void
  /** 确认作为模板；空字符串是取消确认 */
  onApprove: (id: string) => void
  onRemove: (id: string) => void
  onUpload: (data: string) => void
  /** 把这张图上的标注直接发给 AI（不用再到对话框里手动点发送） */
  onSendMarks?: () => void
  /** 对话侧勾选了「只重绘蒙版区域」：这次只发蒙版那一块 */
  inpaint?: boolean
  /** 当前生图方式能不能真做局部重绘；不能时按钮文案不改成「按蒙版重绘」 */
  inpaintSupported?: boolean
  /** 正在出原画的进度 */
  progress?: ConceptJob
  /** AI 正在处理：不能确认模板 */
  busy?: boolean
}) {
  const [tool, setTool] = useState<Tool>('select')
  const [kind, setKind] = useState<AnnotationKind>('change')
  const [active, setActive] = useState('')
  const [shown, setShown] = useState(true)
  const [brush, setBrush] = useState(48)
  const [erase, setErase] = useState(false)
  const img = useRef<HTMLImageElement>(null)
  const file = useRef<HTMLInputElement>(null)
  const [scale, setScale] = useState(0)
  const cur = concept.images.find((i) => i.id === concept.selected) ?? concept.images.at(-1)
  const size = { X: cur?.width || 1, Y: cur?.height || 1 }
  const target = cur ? `concept:${cur.id}` : ''
  const mine = marks.filter((m) => m.target === target)
  // 一张原画只有一个蒙版：后续的涂抹和橡皮擦都并到这一条里，撤销就是去掉最后一笔
  const maskMark = mine.find((m) => m.shape === 'mask')
  const canUndoMask = !!maskMark && hasMask(maskMark)
  const undoMask = () => {
    if (!cur || !maskMark) return
    const strokes = maskMark.strokes.slice(0, -1)
    if (!strokes.some((s) => !s.erase)) {
      onMarks(
        cur.id,
        mine.filter((m) => m.id !== maskMark.id),
      )
      setActive('')
      return
    }
    const b = maskBox(strokes)
    onMarks(
      cur.id,
      mine.map((m) => (m.id === maskMark.id ? { ...m, strokes, points: [b.x, b.y, b.w, b.h] } : m)),
    )
  }
  useLayoutEffect(() => {
    const el = img.current
    if (!el) return
    const fit = () => setScale(el.clientWidth / size.X)
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [size.X, cur?.id])
  // 还在出的几张：在列表最后放占位
  const pending = progress ? Math.max(0, progress.want - progress.got) : 0
  const rounds = [...new Set(concept.images.map((i) => i.round))]
  const approved = !!cur && concept.approved === cur.id
  // 三个条件用 shared 的同一个函数判：勾了、生图方式真能局部重绘、真有蒙版（测试里也是这份口径）
  const maskOnly = sendsMaskOnly({ inpaint: !!inpaint, inpaintSupported: !!inpaintSupported, marks: mine })

  return (
    <div data-concept-board className="absolute inset-0 z-20 flex flex-col bg-canvas text-canvas-fg">
      {/* 左边让出浮在上面的「画板 / 数据」切换（--board-switch-w 由 DesignPage 量好） */}
      <div className="flex h-11 shrink-0 items-center gap-2 pr-3 pl-[max(0.75rem,var(--board-switch-w,0px))] text-[0.75rem]">
        <span className="shrink-0 font-medium whitespace-nowrap text-canvas-strong">{t('原画')}</span>
        {cur && (
          <span className="min-w-0 truncate font-mono text-canvas-subtle">
            {cur.id} · {cur.width}×{cur.height}
          </span>
        )}
        {concept.approved && (
          <span className="inline-flex items-center gap-1 rounded-md bg-success/20 px-1.5 py-0.5 text-[0.6875rem] text-success">
            <BadgeCheck className="h-3.5 w-3.5" />
            {t('已确认模板：{id}', { id: concept.approved })}
          </span>
        )}
        <span className="flex-1" />
        <input
          ref={file}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={async (e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (f) onUpload(await readFile(f))
          }}
        />
        <Button variant="on-canvas" size="sm" onClick={() => file.current?.click()} title={t('上传自己画的效果图')}>
          <ImagePlus className="h-3.5 w-3.5" />
          {t('上传')}
        </Button>
        {cur && (
          <Button
            variant="on-canvas"
            size="icon-sm"
            onClick={() => onRemove(cur.id)}
            aria-label={t('删除这张原画')}
            title={t('删除这张原画')}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
        {cur &&
          (approved ? (
            <Button variant="on-canvas" size="sm" onClick={() => onApprove('')} disabled={busy}>
              <Undo2 className="h-3.5 w-3.5" />
              {t('取消模板')}
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => {
                if (mine.length) toast(t('这张图上还有没发出去的标注，确认模板后标注会被清掉'))
                onApprove(cur.id)
              }}
              disabled={busy}
              title={t('确认用这张作为最终效果，AI 会照着它搭界面、出切图')}
            >
              <Check className="h-3.5 w-3.5" />
              {t('用这张做模板')}
            </Button>
          ))}
      </div>
      {cur && (
        <div className="flex shrink-0 items-start justify-center px-3 pb-2">
          <AnnotationToolbar
            tools={['select', 'rect', 'arrow', 'pen', 'pin', 'mask']}
            labels
            tool={tool}
            onTool={(x) => {
              setTool(x)
              if (isMarkTool(x)) setShown(true)
              if (x !== 'mask') setErase(false)
            }}
            kind={kind}
            onKind={(k) => {
              setKind(k)
              if (!isMarkTool(tool)) setTool('rect')
            }}
            count={mine.length}
            visible={shown}
            onToggleVisible={() => setShown((x) => !x)}
            onClear={() => {
              onMarks(cur.id, [])
              setActive('')
            }}
            mask={{
              size: brush,
              erase,
              canUndo: canUndoMask,
              onSize: setBrush,
              onErase: setErase,
              onUndo: undoMask,
            }}
          />
        </div>
      )}
      <div className="grid min-h-0 flex-1 place-items-center overflow-hidden p-4">
        {cur ? (
          <div className="relative max-h-full max-w-full">
            <img
              ref={img}
              src={url(cur)}
              alt={cur.id}
              draggable={false}
              className="block max-h-[calc(100dvh-260px)] max-w-full object-contain shadow-canvas"
            />
            {scale > 0 && (
              <AnnotationLayer
                size={size}
                scale={scale}
                tool={tool}
                kind={kind}
                list={mine}
                visible={shown}
                active={active}
                brush={brush}
                erase={erase}
                onActive={setActive}
                onCreate={(a) => {
                  // 蒙版：并进同一张图上已有的蒙版，外框按所有涂抹笔画重算
                  if (a.shape === 'mask') {
                    const strokes = [...(maskMark?.strokes ?? []), ...a.strokes]
                    const b = maskBox(strokes)
                    const mark: Annotation = maskMark
                      ? { ...maskMark, strokes, points: [b.x, b.y, b.w, b.h] }
                      : {
                          ...a,
                          id: crypto.randomUUID(),
                          note: '',
                          target,
                          widgets: [cur.id],
                          strokes,
                          points: [b.x, b.y, b.w, b.h],
                        }
                    onMarks(cur.id, maskMark ? mine.map((m) => (m.id === maskMark.id ? mark : m)) : [...mine, mark])
                    setActive(mark.id)
                    return
                  }
                  const mark: Annotation = {
                    ...a,
                    id: crypto.randomUUID(),
                    note: '',
                    target,
                    widgets: [cur.id],
                    strokes: [],
                  }
                  onMarks(cur.id, [...mine, mark])
                  setActive(mark.id)
                }}
                onChange={(a) =>
                  onMarks(
                    cur.id,
                    mine.map((x) => (x.id === a.id ? a : x)),
                  )
                }
                onRemove={(id) => {
                  onMarks(
                    cur.id,
                    mine.filter((x) => x.id !== id),
                  )
                  setActive('')
                }}
              />
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 text-[0.75rem] text-canvas-subtle">
            <Loader2 className="h-5 w-5 animate-spin" />
            {progress?.text ?? t('正在出原画…')}
          </div>
        )}
      </div>
      {/* 标注完直接在这里发（在底部提示行右侧）：用户不一定知道要去右边对话框点发送 */}
      <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 px-3 pb-1">
        <p className="text-center text-[0.6875rem] text-canvas-subtle">
          {tool === 'mask'
            ? canUndoMask
              ? t('涂出要重绘的区域；在右边勾选「只重绘蒙版区域」再发送，就是局部重绘')
              : t('用笔刷涂出要重绘的区域，涂错了用橡皮擦或撤销')
            : t('标注 → 发送给 AI → 出一张改过的原画，可以接着标；满意了点「用这张做模板」')}
        </p>
        {mine.length > 0 && onSendMarks && (
          <Button
            size="sm"
            onClick={onSendMarks}
            disabled={busy}
            title={
              maskOnly
                ? t('对话侧勾了「只重绘蒙版区域」：只把蒙版这一块发给 AI，其余标注会留在图上')
                : t('把这张图上的 {n} 处标注发给 AI，让它按标注改这张原画', { n: mine.length })
            }
          >
            <Send className="h-3.5 w-3.5" />
            {maskOnly ? t('按蒙版重绘（1）') : t('发送标注给 AI（{n}）', { n: mine.length })}
          </Button>
        )}
      </div>
      <div className="flex shrink-0 gap-3 overflow-x-auto bg-canvas-bar/60 px-3 py-2.5">
        {rounds.map((r) => (
          <div key={r} className="flex shrink-0 flex-col gap-1">
            <span className="text-[0.6875rem] text-canvas-subtle">{t('第 {n} 轮', { n: r })}</span>
            <div className="flex gap-1.5">
              {concept.images
                .filter((i) => i.round === r)
                .map((i) => (
                  <button
                    key={i.id}
                    onClick={() => onSelect(i.id)}
                    title={i.prompt || i.id}
                    aria-label={i.id}
                    aria-pressed={i.id === cur?.id}
                    className={cn(
                      'relative h-16 shrink-0 cursor-pointer overflow-hidden rounded-md ring-canvas-subtle hover:ring-1',
                      i.id === cur?.id && 'ring-2 ring-accent hover:ring-accent',
                    )}
                    style={{ aspectRatio: `${i.width || 16} / ${i.height || 9}` }}
                  >
                    <img src={url(i)} alt="" className="h-full w-full object-cover" draggable={false} />
                    {concept.approved === i.id && (
                      <BadgeCheck className="absolute top-1 right-1 h-4 w-4 rounded-full bg-canvas/70 text-success" />
                    )}
                    {marks.some((m) => m.target === `concept:${i.id}`) && (
                      <span className="absolute bottom-1 left-1 h-2 w-2 rounded-full bg-warning" />
                    )}
                  </button>
                ))}
            </div>
          </div>
        ))}
        {pending > 0 && (
          <div className="flex shrink-0 flex-col gap-1">
            <span className="text-[0.6875rem] text-canvas-subtle">{t('正在出')}</span>
            <div className="flex gap-1.5">
              {Array.from({ length: pending }, (_, k) => (
                <span
                  key={k}
                  className="grid h-16 w-28 place-items-center rounded-md bg-canvas-hover"
                  title={progress?.text}
                >
                  <Loader2 className="h-4 w-4 animate-spin text-canvas-subtle" />
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
