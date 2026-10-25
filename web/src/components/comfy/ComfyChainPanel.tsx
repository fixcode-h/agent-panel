import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ArrowDown, ImagePlus, Loader2, Play, Plus, Save, Trash2, X } from 'lucide-react'
import { t } from '@shared/i18n'
import { IMG2IMG_DENOISE, workflowInKind, type ComfyWorkflow } from '@shared/local-image'
import {
  CHAIN_MAX_STEPS,
  defaultChainSteps,
  type ComfyChain,
  chainNeedsImage,
  chainNotes,
  checkChain,
} from '@shared/comfy-chain'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input, Select } from '@/components/ui/input'

/** 新链的 id：和时间戳拼，不依赖后端生成 */
const newChainId = () => `ch_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/** 读图片文件成 data URL（发给服务端上传到 ComfyUI） */
const readImage = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error(t('读取图片失败')))
    reader.readAsDataURL(file)
  })

/**
 * 工作流链：把多个工作流按顺序串起来，前一段的输出图当后一段的输入图，例如「图生图 → 去背景」。
 * 列出已存的链，可以改段序、选工作流、上传一张原图试跑并看输出。
 */
export function ComfyChainPanel({ kind, className }: { kind: 'game' | 'web'; className?: string }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.comfyChains>>>()
  const [sel, setSel] = useState('')
  const [draft, setDraft] = useState<ComfyChain | null>(null)
  const [image, setImage] = useState<string>('')
  const [prompt, setPrompt] = useState('')
  const [running, setRunning] = useState(false)
  const [output, setOutput] = useState<string[]>([])
  const file = useRef<HTMLInputElement>(null)

  const load = useCallback(
    () =>
      api
        .comfyChains()
        .then(setData)
        .catch((e) => toast.error((e as Error).message)),
    [],
  )
  useEffect(() => {
    void load()
  }, [load])

  // 该分类（含 both）的工作流；能不能接进链由 checkChain 逐段报，这里不先筛掉，免得选不出段又看不出原因
  const usable = useMemo(() => (data?.workflows ?? []).filter((w) => workflowInKind(w, kind)), [data, kind])
  const byId = useMemo(() => new Map((data?.workflows ?? []).map((w) => [w.id, w])), [data])
  const chains = data?.list ?? []
  const current = draft ?? chains.find((c) => c.id === sel) ?? chains[0]

  const pick = (chain: ComfyChain) => {
    setSel(chain.id)
    setDraft(null)
    setOutput([])
  }

  const create = () => {
    // 默认给两段「去背景 → 图生图」这类真能连起来的组合，比给一段文生图更有用
    const steps = defaultChainSteps(usable)
    if (!steps.length) {
      toast.error(t('先有能用的工作流才能建链'))
      return
    }
    const chain: ComfyChain = {
      id: newChainId(),
      name: t('新链'),
      steps: steps.map((workflowId) => ({
        workflowId,
        prompt: '',
        denoise: workflowId.includes('img2img') ? IMG2IMG_DENOISE : undefined,
      })),
      updatedAt: '',
    }
    setDraft(chain)
    setSel(chain.id)
    setOutput([])
  }

  const edit = (patch: Partial<ComfyChain>) => {
    if (!current) return
    setDraft({ ...current, ...patch })
  }
  const setStep = (i: number, patch: Partial<ComfyChain['steps'][number]>) => {
    if (!current) return
    edit({ steps: current.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) })
  }
  const move = (i: number, delta: number) => {
    if (!current) return
    const j = i + delta
    if (j < 0 || j >= current.steps.length) return
    const steps = [...current.steps]
    ;[steps[i], steps[j]] = [steps[j], steps[i]]
    edit({ steps })
  }
  const addStep = () => {
    if (!current || current.steps.length >= CHAIN_MAX_STEPS) return
    const last = byId.get(current.steps.at(-1)!.workflowId)
    // 上一段的工作流被删了：先让用户把它换掉，不凭缺失的段猜下一个该接什么
    if (!last) {
      toast.error(t('上一段的工作流已经不在了，请先重新选一下'))
      return
    }
    // 新段优先选能接在上一段后面、且还没用过的（放大、去背景这类）
    const next =
      usable.find((w) => w.id !== last.id && checkChain([{ workflow: last }, { workflow: w }]).length === 0) ??
      usable[0]
    if (!next) return
    edit({ steps: [...current.steps, { workflowId: next.id, prompt: '' }] })
  }

  const save = async () => {
    if (!current) return
    try {
      const r = await api.saveComfyChain(current)
      setDraft(null)
      setData((d) => (d ? { ...d, list: r.list } : d))
      toast.success(t('已保存'))
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const run = async () => {
    if (!current || running) return
    setRunning(true)
    setOutput([])
    try {
      const r = await api.runComfyChain(current, image || undefined, prompt || undefined)
      setOutput(r.images)
      if (!r.images.length) toast.message(t('跑完了，但没有拿到图片'))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setRunning(false)
    }
  }

  const steps = current?.steps ?? []
  // 不 filter：失效的段要占住它的下标，否则第一段、描点的判断都会错位（见 checkChain 的注释）
  const stepWorkflows = steps.map((s) => ({ workflow: byId.get(s.workflowId) }))
  const problems = checkChain(stepWorkflows)
  const notes = chainNotes(stepWorkflows.filter((s): s is { workflow: ComfyWorkflow } => !!s.workflow))
  const needsImage = chainNeedsImage(stepWorkflows)
  const ready = new Set(data?.ready ?? [])

  return (
    <section
      aria-label={t('工作流链')}
      className={cn('flex flex-col gap-3 rounded-xl border bg-card/60 p-3', className)}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[0.8125rem] font-medium">{t('工作流链')}</h2>
        <span className="min-w-0 flex-1 text-[0.75rem] text-subtle">
          {t('把几个工作流按顺序串起来：前一段的输出图直接给后一段用，例如「图生图 → 去背景」')}
        </span>
        <Button size="sm" variant="ghost" onClick={create}>
          <Plus className="h-3.5 w-3.5" />
          {t('新建链')}
        </Button>
      </div>

      {!chains.length && !draft && (
        <p className="text-[0.78125rem] leading-relaxed text-subtle">
          {t('还没有链。新建一条，选两段就能试：例如先「图生图」重画，再「去背景」抠成透明底。')}
        </p>
      )}

      {!!chains.length && (
        <div className="flex flex-wrap gap-1">
          {chains.map((c) => (
            <button
              key={c.id}
              onClick={() => pick(c)}
              aria-current={current?.id === c.id}
              className={cn(
                'cursor-pointer rounded-lg px-2 py-1 text-[0.75rem]',
                current?.id === c.id ? 'bg-sel text-fg' : 'text-muted hover:bg-sel/60',
              )}
            >
              {c.name}
              <span className="ml-1 text-subtle">{c.steps.length}</span>
            </button>
          ))}
        </div>
      )}

      {current && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-[0.75rem] font-medium text-muted">{t('名称')}</span>
              <Input value={current.name} onChange={(e) => edit({ name: e.target.value })} />
            </label>
            <Button size="sm" onClick={() => void save()} disabled={!draft}>
              <Save className="h-3.5 w-3.5" />
              {t('保存')}
            </Button>
            {!draft && (
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t('删除这条链')}
                title={t('删除这条链')}
                onClick={async () => {
                  try {
                    const r = await api.deleteComfyChain(current.id)
                    setData((d) => (d ? { ...d, list: r.list } : d))
                    setSel('')
                    setOutput([])
                  } catch (e) {
                    // 删链失败要告诉用户，不能吞成未处理的 rejection
                    toast.error((e as Error).message)
                  }
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>

          <ol className="flex flex-col gap-1.5">
            {steps.map((step, i) => {
              const w = byId.get(step.workflowId)
              return (
                <li key={`${step.workflowId}-${i}`} className="flex flex-wrap items-center gap-1.5">
                  <span className="w-5 shrink-0 text-right font-mono text-[0.71875rem] text-subtle">{i + 1}</span>
                  <Select
                    aria-label={t('第 {n} 段的工作流', { n: i + 1 })}
                    value={step.workflowId}
                    onChange={(e) => setStep(i, { workflowId: e.target.value })}
                    options={usable.map((x) => ({
                      value: x.id,
                      // 模型没下载的段标出来：链能存但跑不了
                      label: ready.has(x.id) ? x.name : t('{name}（模型没下载）', { name: x.name }),
                    }))}
                    className="min-w-0 flex-1"
                  />
                  {/* 吃提示词的段才给单独的描述框（图生图这类）；按能力判断，用户自建的同类工作流也适用 */}
                  {w && JSON.stringify(w.graph).includes('{{prompt}}') && (
                    <Input
                      aria-label={t('第 {n} 段的描述', { n: i + 1 })}
                      placeholder={t('这一段的描述，留空用链名')}
                      value={step.prompt}
                      onChange={(e) => setStep(i, { prompt: e.target.value })}
                      className="w-40 shrink-0"
                    />
                  )}
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t('上移')}
                    title={t('上移')}
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                  >
                    <ArrowDown className="h-3.5 w-3.5 rotate-180" />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t('下移')}
                    title={t('下移')}
                    disabled={i === steps.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    <ArrowDown className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t('删掉第 {n} 段', { n: i + 1 })}
                    title={t('删掉这一段')}
                    disabled={steps.length <= 1}
                    onClick={() => edit({ steps: steps.filter((_, j) => j !== i) })}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </li>
              )
            })}
          </ol>
          {steps.length < CHAIN_MAX_STEPS && (
            <Button size="sm" variant="ghost" className="self-start" onClick={addStep}>
              <Plus className="h-3.5 w-3.5" />
              {t('加一段')}
            </Button>
          )}

          {problems.length > 0 && (
            <ul className="flex flex-col gap-1 text-[0.78125rem] text-danger">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          {notes.map((n) => (
            <p key={n} className="rounded-lg bg-warning/10 px-2 py-1 text-[0.75rem] leading-relaxed text-warning">
              {n}
            </p>
          ))}

          <div className="flex flex-wrap items-center gap-2 border-t pt-3">
            <input
              ref={file}
              type="file"
              accept="image/*"
              aria-label={t('原图')}
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0]
                if (!f) return
                try {
                  setImage(await readImage(f))
                  setOutput([])
                } catch (err) {
                  toast.error((err as Error).message)
                }
              }}
            />
            <Button size="sm" variant="secondary" onClick={() => file.current?.click()}>
              <ImagePlus className="h-3.5 w-3.5" />
              {image ? t('换一张原图') : t('选原图')}
            </Button>
            {needsImage && !image && (
              <span className="text-[0.75rem] text-warning">{t('这条链的第一段要一张原图')}</span>
            )}
            <Input
              aria-label={t('描述')}
              placeholder={t('描述（图生图那一段用）')}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="min-w-0 flex-1"
            />
            <Button size="sm" onClick={() => void run()} disabled={running || problems.length > 0}>
              {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              {t('试跑')}
            </Button>
          </div>

          {(image || output.length > 0) && (
            <div className="flex flex-wrap items-start gap-2">
              {image && (
                <figure className="flex flex-col gap-1">
                  <img src={image} alt={t('原图')} className="h-24 w-24 rounded-lg border bg-sel object-contain" />
                  <figcaption className="text-[0.71875rem] text-subtle">{t('原图')}</figcaption>
                </figure>
              )}
              {output.map((src, i) => (
                <figure key={i} className="flex flex-col gap-1">
                  <img
                    src={src}
                    alt={t('输出图 {n}', { n: i + 1 })}
                    className="h-24 w-24 rounded-lg border bg-sel object-contain"
                  />
                  <figcaption className="text-[0.71875rem] text-subtle">{t('输出图 {n}', { n: i + 1 })}</figcaption>
                </figure>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
