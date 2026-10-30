import { z } from 'zod'
import { t } from './i18n.ts'
import { IMAGE_PLACEHOLDER, checkWorkflow, needsInputImage, type ComfyWorkflow } from './local-image.ts'

/**
 * 工作流链：把多个 ComfyUI 工作流串起来，前一段的输出图当后一段的输入图，
 * 例如「图生图 → 去背景」——先按描述重画，再把主体抠成透明底。
 *
 * 合并成一张图一次提交（而不是每段提交一次、中间图落盘再上传）：
 * - 中间图不经过磁盘，少一次上传和下载，也不会留下「第一段跑完第二段失败」的半成品文件；
 * - 进度、取消、队列、文件名前缀、占位符填充全部复用现有的单工作流逻辑，不另写一套轮询。
 *
 * 接线约定只有一条：段图里读 {{image}} 的 LoadImage 是这一段的输入锚点，
 * SaveImage（或 PreviewImage）接的节点是出口。锚点不参与提交——合并时把它的消费者直接接到上游出口。
 */

/** 链里的一段：用哪个工作流，以及这一段的描述（图生图这类需要提示词的段用） */
export const ComfyChainStep = z.object({
  workflowId: z.string().min(1),
  /** 这一段自己的描述；空着用链的描述 */
  prompt: z.string().max(4000).default(''),
  /** 图生图的去噪强度，不填用工作流自己的默认值 */
  denoise: z.number().min(0).max(1).optional(),
})
export type ComfyChainStep = z.infer<typeof ComfyChainStep>

/** 链最多几段：再多就没法在一个界面上看清楚了 */
export const CHAIN_MAX_STEPS = 6

export const ComfyChain = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(80),
  /** 步骤按顺序执行，前一段的输出就是后一段的输入 */
  steps: z.array(ComfyChainStep).min(1).max(CHAIN_MAX_STEPS),
  updatedAt: z.string().default(''),
})
export type ComfyChain = z.infer<typeof ComfyChain>

/** 合并后的节点 id：第 i 段（从 0 起）的节点 id 前面加 s{i}_，避免两段用同名 id 撞上 */
export const chainPrefix = (i: number) => `s${i}_`

/** 段图里的输入锚点和出口 */
interface Wiring {
  /** 读 {{image}} 的 LoadImage 节点 id（这一段的输入图来源） */
  input?: string
  /** 这一段最终输出的节点和输出序号（接给下一段） */
  output?: [string, number]
}

/** 读 {{image}} 的 LoadImage 有几个 */
const anchorsOf = (graph: ComfyWorkflow['graph']) =>
  Object.entries(graph)
    .filter(([, n]) => n.class_type === 'LoadImage' && n.inputs?.image === IMAGE_PLACEHOLDER)
    .map(([id]) => id)

const findWiring = (graph: ComfyWorkflow['graph']): Wiring => {
  const anchors = anchorsOf(graph)
  // 多张输入图的工作流（例如带蒙版的局部重绘）不猜哪张是主图
  const input = anchors.length === 1 ? anchors[0] : undefined
  const save = Object.entries(graph).find(([, n]) => n.class_type === 'SaveImage' || n.class_type === 'PreviewImage')
  if (!save) return { input }
  const images = save[1].inputs?.images
  const output: [string, number] | undefined =
    Array.isArray(images) && typeof images[0] === 'string' && typeof images[1] === 'number'
      ? [images[0], images[1]]
      : undefined
  return { input, output }
}

/** 锚点节点输出的消费者：[节点 id, 输入名] */
const consumersOf = (graph: ComfyWorkflow['graph'], anchor: string): [string, string][] =>
  Object.entries(graph).flatMap(([id, n]) =>
    Object.entries(n.inputs ?? {}).flatMap(([k, v]) =>
      Array.isArray(v) && v[0] === anchor ? ([[id, k]] as [string, string][]) : [],
    ),
  )

/**
 * 锚点能不能被上游的图替掉：它的消费者只吃 IMAGE。
 * LoadImage 还有 MASK 输出，消费者要是拿它当蒙版（MASK），IMAGE 接不进去
 */
const usableAnchor = (graph: ComfyWorkflow['graph'], anchor: string) =>
  consumersOf(graph, anchor).every(([id, k]) => {
    const v = graph[id].inputs[k]
    return Array.isArray(v) && v[1] === 0
  })

/** 链的第一段要不要外部传一张原图：段的工作流已经不在时按不要处理（校验会单独报那一段） */
export const chainNeedsImage = (steps: { workflow: ComfyWorkflow | undefined }[]) => {
  const first = steps[0]?.workflow
  return !!first && needsInputImage(first.graph)
}

/**
 * 检查一条链能不能跑：每段有没有出口、第一段的图从哪来、后面的段接不接得上上一段。
 * 返回的都是会让提交失败的问题；能跑但结果可能不如预期的提示见 chainNotes
 */
export function checkChain(steps: { workflow: ComfyWorkflow | undefined }[], known?: Set<string>): string[] {
  const errors: string[] = []
  if (!steps.length) return [t('链里至少要有一个工作流')]
  if (steps.length > CHAIN_MAX_STEPS) errors.push(t('一条链最多 {n} 段', { n: CHAIN_MAX_STEPS }))
  steps.forEach((step, i) => {
    // 段的工作流被删了：这一段的索引要留住，否则后面的段下标错位（第一段、锚点的判断都靠下标）
    if (!step.workflow) {
      errors.push(t('第 {n} 段的工作流已经不在了，请重新选一下', { n: i + 1 }))
      return
    }
    const label = step.workflow.name
    const wiring = findWiring(step.workflow.graph)
    if (!wiring.output) errors.push(t('{name} 没有 SaveImage 节点，接不上下一段', { name: label }))
    // 锚点有好几个（读了两张不同的输入图）时不知道该接哪张
    if (anchorsOf(step.workflow.graph).length > 1)
      errors.push(t('{name} 读了不止一张输入图，没法接进链里', { name: label }))
    for (const problem of checkWorkflow(step.workflow.graph, known)) errors.push(`${label}：${problem}`)
    if (i === 0) return
    // 后面的段要有输入锚点，或者能改写成图生图（把上一段的图编码进 latent）
    if (wiring.input && !usableAnchor(step.workflow.graph, wiring.input))
      errors.push(t('{name} 的输入图还被当成蒙版用，链里接不进去', { name: label }))
  })
  return errors
}

/**
 * 能跑但结果可能不如预期的提示：
 * 去背景段后面如果还有采样（图生图），图要进 VAE 编码，alpha 通道会被丢掉，透明底白抠
 */
export function chainNotes(steps: { workflow: ComfyWorkflow }[]): string[] {
  const notes: string[] = []
  const samplerAfter = (from: number) =>
    steps
      .slice(from + 1)
      .some((s) => Object.values(s.workflow.graph).some((n) => /KSampler|SamplerCustom/.test(n.class_type)))
  steps.forEach((step, i) => {
    const types = Object.values(step.workflow.graph).map((n) => n.class_type)
    if (types.includes('JoinImageWithAlpha') && samplerAfter(i))
      notes.push(
        t(
          '{name} 放在链中间时透明底会在后面的重画里丢掉：图要编码进 VAE 时 alpha 通道不保留。想留住透明背景，把去背景放到链的最后一段',
          { name: step.workflow.name },
        ),
      )
  })
  return notes
}

/** 合并链时用到的改写函数：给纯文生图的段加上输入锚点（接上游的图）。签名和 imageToImage 一致，直接传它 */
export type MakeImg2Img = (
  graph: ComfyWorkflow['graph'],
  o: { image: string; denoise?: number },
) => ComfyWorkflow['graph'] | undefined

/**
 * 把链的各段合并成一张节点图：节点 id 加段前缀、中间段的出图节点去掉、
 * 锚点节点的消费者直接接上游出口，只有第一段的锚点保留并填上外部传进来的图。
 *
 * 第 0 段的锚点必须由调用方给图（image）；给不出时保留 {{image}}，由调用方处理。
 * 中间段没有锚点（纯文生图的工作流）时用 makeImg2Img 现场改成图生图。
 */
export function chainGraph(
  steps: { workflow: ComfyWorkflow; prompt?: string; denoise?: number }[],
  o: { image?: string; makeImg2Img: MakeImg2Img },
): ComfyWorkflow['graph'] {
  const merged: ComfyWorkflow['graph'] = {}
  /** 上游的出口：[合并后的节点 id, 输出序号] */
  let upstream: [string, number] | undefined
  steps.forEach((step, i) => {
    const prefix = chainPrefix(i)
    const original = step.workflow.graph
    let graph = original
    let wiring = findWiring(graph)
    // 这一段要接上游的图，但图里没有输入锚点：改写成图生图，把上游的图编码进 latent
    if (i > 0 && upstream && !wiring.input) {
      const rewritten = o.makeImg2Img(original, { image: IMAGE_PLACEHOLDER, denoise: step.denoise })
      if (rewritten) {
        graph = rewritten
        wiring = findWiring(graph)
      }
    }
    const last = i === steps.length - 1
    const anchor = wiring.input
    // 锚点输出的消费者：接上游时把它们改成直接吃上游的图，第一段则填外部传进来的图
    const consumers = anchor ? consumersOf(graph, anchor) : []
    // 改写过时 graph 是 original 的超集（在它基础上克隆加节点），只遍历 graph 就不会漏也不会留旧连线
    for (const [id, node] of Object.entries(graph)) {
      // 不是最后一段就去掉出图节点：图直接接给下一段，不落盘
      if (!last && (node.class_type === 'SaveImage' || node.class_type === 'PreviewImage')) continue
      merged[prefix + id] = { ...node, inputs: { ...node.inputs } }
    }
    // 段内部的连线加前缀
    for (const [id, node] of Object.entries(merged)) {
      if (!id.startsWith(prefix)) continue
      for (const [k, v] of Object.entries(node.inputs)) {
        if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && v[0] in graph)
          node.inputs[k] = [prefix + v[0], v[1]]
      }
    }
    if (anchor) {
      const anchorId = prefix + anchor
      if (upstream) {
        // 上游的图直接接进来：删掉锚点，把它原来的消费者改成吃上游的输出
        delete merged[anchorId]
        for (const [id, k] of consumers) {
          const node = merged[prefix + id]
          if (node && node.inputs[k] !== undefined) node.inputs[k] = [upstream[0], upstream[1]]
        }
      } else {
        const node = merged[anchorId]
        if (node) node.inputs.image = o.image ?? IMAGE_PLACEHOLDER
      }
    }
    const out = wiring.output
    upstream = out ? [prefix + out[0], out[1]] : undefined
  })
  return merged
}

/**
 * 新建链时的默认段：优先挑「要原图 → 再重画」这种真的能连起来的组合（去背景 → 图生图），
 * 也就是用户最常搭的那条；凑不出来时退回第一个要原图的工作流，再不行给一段普通工作流。
 * 按工作流的特征挑，不按 id 写死：内置工作流改名、用户自己加了同类工作流都还能用
 */
export function defaultChainSteps(workflows: ComfyWorkflow[]): string[] {
  const needsImage = workflows.filter((w) => needsInputImage(w.graph))
  const hasPrompt = (w: ComfyWorkflow) => JSON.stringify(w.graph).includes('{{prompt}}')
  // 第一段不吃提示词（去背景这类），第二段吃提示词（图生图）：先用纯处理，再接重画
  const pure = needsImage.filter((w) => !hasPrompt(w))
  const withPrompt = needsImage.filter(hasPrompt)
  if (pure[0] && withPrompt[0]) return [pure[0].id, withPrompt[0].id]
  if (needsImage[0]) return [needsImage[0].id]
  return workflows[0] ? [workflows[0].id] : []
}
