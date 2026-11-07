import { useCallback, useEffect, useRef, useState } from 'react'
import { t } from '@shared/i18n'
import { RESTORE_STEPS, stepOf, type RestoreElement, type RestoreStep } from '@shared/restore/schema'
import { DEFAULT_THRESHOLDS } from '@shared/restore/thresholds'
import type { DesignImage } from '@shared/design'
import { toast } from '@/lib/toast'
import { designFileUrl, type DesignFull } from '@/lib/api'
import { restoreApi } from '@/lib/api-restore'
import { activeStep } from '@/lib/restore-stages'
import { stepName } from '@shared/restore/steps'
import { ElementEditor, ElementInspector } from './ElementEditor'
import { StepCardPanel } from './StepCardPanel'
import { AssetsView, CanvasHint, Empty, VerifyView } from './RestoreViews'

/**
 * 照原画还原的工作区：左边是这一步的产物（原画、元素框、切图、校验表），右边是这一步的决策卡。
 * 看哪一步由标题行的步骤条决定（step），默认是还没确认的第一步；一步在后台跑时按钮都灰掉，页面靠轮询拿结果
 */
export function RestoreWorkspace({
  design,
  step,
  onAbsorb,
  onOpenCanvas,
}: {
  design: DesignFull
  step: RestoreStep
  onAbsorb: (d: DesignFull) => void
  /** 去画布看；compare 时打开和原画的滑块对照 */
  onOpenCanvas: (compare?: boolean) => void
}) {
  const r = design.restore!
  const id = design.id
  const busy = RESTORE_STEPS.some((s) => stepOf(r, s).status === 'running')
  const [selected, setSelected] = useState('')
  // 拖框时先改本地，松手再存；服务端的新结果（重跑了这一步）进来就换掉
  const [local, setLocal] = useState<RestoreElement[]>(r.elements)
  const dirty = useRef(false)
  useEffect(() => {
    if (!dirty.current) setLocal(r.elements)
  }, [r.elements])

  const call = useCallback(
    (p: Promise<DesignFull>) => p.then(onAbsorb).catch((e) => toast.error((e as Error).message)),
    [onAbsorb],
  )
  const saveElements = useCallback(
    (list: RestoreElement[], commit: boolean) => {
      setLocal(list)
      dirty.current = !commit
      if (commit) void call(restoreApi.elements(id, list))
    },
    [call, id],
  )

  const src = r.source
  if (!src) return <Empty text={t('还没有原画')} />
  const artUrl = designFileUrl(id, src.file)
  const imgUrl = (img: DesignImage) => {
    const v = img.variants[img.selected] ?? img.variants.at(-1)
    return v && designFileUrl(id, v.file)
  }
  const sel = local.find((e) => e.id === selected && !e.hidden)
  const editable = !busy && (step === 'elements' || step === 'source') && stepOf(r, 'elements').versions.length > 0

  let view
  const running = stepOf(r, step).status === 'running'
  if (running && step !== 'elements' && step !== 'source')
    view = <Empty text={t('正在{step}…', { step: stepName(step) })} busy />
  else if (step === 'source' || step === 'elements')
    view = (
      <ElementEditor
        url={artUrl}
        width={src.width}
        height={src.height}
        elements={step === 'source' ? [] : local}
        selected={selected}
        onSelect={setSelected}
        onChange={saveElements}
        readOnly={step === 'source' || !editable}
      />
    )
  else if (step === 'assets')
    view = <AssetsView restore={r} images={design.images} url={imgUrl} min={DEFAULT_THRESHOLDS.assetSim} />
  else if (step === 'verify')
    view = (
      <VerifyView
        restore={r}
        busy={busy}
        onAccept={(element, on) => void call(restoreApi.accept(id, element, on))}
        onCompare={() => onOpenCanvas(true)}
      />
    )
  else
    view = (
      <CanvasHint
        text={
          step === 'build'
            ? t('控件树已经按元素框搭好，位置锁住了。到画布里看层级、名字，和原画对照。')
            : t('还原做完了：之后就像平常的设计一样，在画布里继续改、让 AI 改，或者导出到 UE。')
        }
        onOpen={() => onOpenCanvas()}
      />
    )

  return (
    <div data-restore-step={step} className="flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{view}</div>
      <aside aria-label={t('决策卡')} className="flex w-[300px] shrink-0 flex-col overflow-y-auto border-l">
        <StepCardPanel
          restore={r}
          step={step}
          busy={busy}
          onRun={(feedback) => void call(restoreApi.run(id, step, feedback))}
          onConfirm={() => void call(restoreApi.confirm(id, step))}
        />
        {step === 'elements' && sel && (
          <ElementInspector
            element={sel}
            readOnly={!editable}
            onChange={(e) => {
              const list = e
                ? local.map((x) => (x.id === e.id ? e : x))
                : local.map((x) => (x.id === sel.id ? { ...x, hidden: true } : x))
              if (!e) setSelected('')
              saveElements(list, true)
            }}
          />
        )}
        {step === 'elements' && !sel && activeStep(r) === 'elements' && (
          <p className="border-t p-3 text-footnote text-subtle">
            {t('点框看它的类型和名字；拖动改位置，拖右下角改大小，Delete 删掉。')}
          </p>
        )}
      </aside>
    </div>
  )
}
