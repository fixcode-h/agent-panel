import { useLayoutEffect, useRef, useState } from 'react'
import { BadgeCheck, Check, ImagePlus, Loader2, Trash2, Undo2 } from 'lucide-react'
import { toast } from 'sonner'
import type { Annotation, AnnotationKind, ConceptImage, ConceptJob, ConceptState } from '@shared/design'
import { cn } from '@/lib/utils'
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
  /** 正在出原画的进度 */
  progress?: ConceptJob
  /** AI 正在处理：不能确认模板 */
  busy?: boolean
}) {
  const [tool, setTool] = useState<Tool>('select')
  const [kind, setKind] = useState<AnnotationKind>('change')
  const [active, setActive] = useState('')
  const [shown, setShown] = useState(true)
  const img = useRef<HTMLImageElement>(null)
  const file = useRef<HTMLInputElement>(null)
  const [scale, setScale] = useState(0)
  const cur = concept.images.find((i) => i.id === concept.selected) ?? concept.images.at(-1)
  const size = { X: cur?.width || 1, Y: cur?.height || 1 }
  const target = cur ? `concept:${cur.id}` : ''
  const mine = marks.filter((m) => m.target === target)
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

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-[#18181a] text-white/80">
      <div className="flex h-11 shrink-0 items-center gap-2 px-3 text-[0.75rem]">
        <span className="font-medium text-white">{t('原画')}</span>
        {cur && (
          <span className="font-mono text-white/50">
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
        <button
          onClick={() => file.current?.click()}
          title={t('上传自己画的效果图')}
          className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md px-2 text-white/70 hover:bg-white/10 hover:text-white"
        >
          <ImagePlus className="h-3.5 w-3.5" />
          {t('上传')}
        </button>
        {cur && (
          <button
            onClick={() => onRemove(cur.id)}
            aria-label={t('删除这张原画')}
            title={t('删除这张原画')}
            className="grid h-7 w-7 cursor-pointer place-items-center rounded-md text-white/70 hover:bg-white/10 hover:text-white"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
        {cur &&
          (approved ? (
            <button
              onClick={() => onApprove('')}
              disabled={busy}
              className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md px-2.5 text-white/80 hover:bg-white/10 disabled:cursor-default disabled:opacity-50"
            >
              <Undo2 className="h-3.5 w-3.5" />
              {t('取消模板')}
            </button>
          ) : (
            <button
              onClick={() => {
                if (mine.length) toast(t('这张图上还有没发出去的标注，确认模板后标注会被清掉'))
                onApprove(cur.id)
              }}
              disabled={busy}
              title={t('确认用这张作为最终效果，AI 会照着它搭界面、出切图')}
              className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md bg-accent px-2.5 font-medium text-white hover:brightness-110 disabled:cursor-default disabled:opacity-50"
            >
              <Check className="h-3.5 w-3.5" />
              {t('用这张做模板')}
            </button>
          ))}
      </div>
      {cur && (
        <div className="flex shrink-0 justify-center px-3 pb-2">
          <AnnotationToolbar
            tools={['select', 'rect', 'arrow', 'pen', 'pin']}
            tool={tool}
            onTool={(x) => {
              setTool(x)
              if (isMarkTool(x)) setShown(true)
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
              className="block max-h-[calc(100dvh-260px)] max-w-full object-contain shadow-[0_12px_40px_-12px_rgba(0,0,0,0.8)]"
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
                onActive={setActive}
                onCreate={(a) => {
                  const mark: Annotation = { ...a, id: crypto.randomUUID(), note: '', target, widgets: [cur.id] }
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
          <div className="flex flex-col items-center gap-2 text-[0.78125rem] text-white/50">
            <Loader2 className="h-5 w-5 animate-spin" />
            {progress?.text ?? t('正在出原画…')}
          </div>
        )}
      </div>
      <p className="pointer-events-none shrink-0 px-3 pb-1 text-center text-[0.71875rem] text-white/40">
        {mine.length
          ? t('在右边的对话框里补充修改意见后发送，AI 会在这张的基础上改')
          : t('挑一张，用上面的工具在图上标出要改的地方再发送；满意了点「用这张做模板」')}
      </p>
      <div className="flex shrink-0 gap-3 overflow-x-auto border-t border-white/10 px-3 py-2.5">
        {rounds.map((r) => (
          <div key={r} className="flex shrink-0 flex-col gap-1">
            <span className="text-[0.65625rem] text-white/40">{t('第 {n} 轮', { n: r })}</span>
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
                      'relative h-16 shrink-0 cursor-pointer overflow-hidden rounded-md ring-1 ring-white/10 hover:ring-white/40',
                      i.id === cur?.id && 'ring-2 ring-accent hover:ring-accent',
                    )}
                    style={{ aspectRatio: `${i.width || 16} / ${i.height || 9}` }}
                  >
                    <img src={url(i)} alt="" className="h-full w-full object-cover" draggable={false} />
                    {concept.approved === i.id && (
                      <BadgeCheck className="absolute top-1 right-1 h-4 w-4 rounded-full bg-black/50 text-success" />
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
            <span className="text-[0.65625rem] text-white/40">{t('正在出')}</span>
            <div className="flex gap-1.5">
              {Array.from({ length: pending }, (_, k) => (
                <span
                  key={k}
                  className="grid h-16 w-28 place-items-center rounded-md bg-white/5 ring-1 ring-white/10"
                  title={progress?.text}
                >
                  <Loader2 className="h-4 w-4 animate-spin text-white/40" />
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
