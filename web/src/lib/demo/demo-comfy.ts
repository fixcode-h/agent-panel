/** 演示的本机生图（ComfyUI）接口：模拟安装、下载、模板和工作流，从 demo-backend.ts 拆出来（文件行数上限） */
import {
  BUILTIN_WORKFLOWS,
  ComfyWorkflow,
  comfyImportFile,
  LOCAL_FILES,
  LOCAL_MODELS,
  localModel,
  localFile,
  localWorkflow,
  modelReady,
  type LocalJob,
  type LocalStatus,
} from '@shared/local-image'
import { ComfyChain } from '@shared/comfy-chain'
import {
  builtinTemplates,
  builtinTemplateMeta,
  type ComfyTemplateMeta,
  type TemplateAsset,
} from '@shared/comfy-templates'
import { demoMs } from './demo-speed'
import { fail, parse } from './demo-http'

/** 本机生图的演示：模拟安装、下载的进度，演示里没有真的 ComfyUI */
export const local: LocalStatus = {
  dir: '~/agent-panel/comfyui',
  installed: false,
  running: false,
  external: false,
  url: 'http://127.0.0.1:8188',
  pythons: [
    {
      command: 'py -3.12',
      path: 'C:\\Users\\you\\AppData\\Local\\Programs\\Python\\Python312\\python.exe',
      version: '3.12.10',
      usable: true,
    },
  ],
  gpu: 'cuda',
  gpuName: 'NVIDIA GeForce RTX 4090',
  vram: 24,
  files: [],
}
/** 模板商店的演示：内置模板照实给，官方模板给几条示例（不联网），详情用一张 SDXL 节点图 */
export const DEMO_GRAPH = localWorkflow(localModel('sdxl')!, {
  prompt: '{{prompt}}',
  negative: '{{negative}}',
  width: '{{width}}',
  height: '{{height}}',
  count: '{{count}}',
  seed: '{{seed}}',
})
export const DEMO_ASSETS: Record<string, TemplateAsset[]> = {
  'z-image-turbo': [
    {
      dir: 'diffusion_models',
      file: 'z_image_turbo_bf16.safetensors',
      url: 'https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/diffusion_models/z_image_turbo_bf16.safetensors',
      gb: 11.46,
    },
    {
      dir: 'text_encoders',
      file: 'qwen_3_4b.safetensors',
      url: 'https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/text_encoders/qwen_3_4b.safetensors',
      gb: 7.49,
    },
    {
      dir: 'vae',
      file: 'ae.safetensors',
      url: 'https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors',
      gb: 0.31,
    },
  ],
  image_sdxl_simple: [
    {
      dir: 'checkpoints',
      file: 'sd_xl_base_1.0.safetensors',
      url: 'https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors',
      gb: 6.46,
    },
  ],
}
export const DEMO_OFFICIAL: ComfyTemplateMeta[] = [
  {
    name: 'image_sdxl_simple',
    title: 'SDXL1.0: Text to Image (Simple)',
    description: 'Generate high-quality images from text prompts using the SDXL 1.0 model.',
    category: 'Image',
    tags: ['Image', 'Text to Image'],
    models: ['SDXL'],
    size: 6979321856,
    date: '2024-02-22',
    username: 'ComfyUI',
    usage: 412,
    openSource: true,
    source: 'comfy',
    output: 'image',
    available: true,
  },
  {
    name: 'z-image-turbo',
    title: 'Z-Image-Turbo: Text to Image',
    description: 'An efficient image generation model that supports English and Chinese prompts.',
    category: 'Image',
    tags: ['Image', 'Text to Image'],
    models: ['Z-Image-Turbo'],
    size: 20830591386,
    date: '2025-11-27',
    username: 'ComfyUI',
    usage: 15150,
    openSource: true,
    source: 'comfy',
    output: 'image',
    available: true,
  },
  {
    name: 'image_qwen_image_2_1_image_edit',
    title: 'Qwen Image 2.1: Image Edit',
    description: 'Edit images by feeding reference images through one checkpoint.',
    category: 'Character & Fashion',
    tags: ['Image Edit'],
    models: ['Qwen Image 2.1'],
    size: 26736171418,
    date: '2026-09-20',
    username: 'ComfyUI',
    usage: 17538,
    openSource: true,
    source: 'comfy',
    output: 'image',
    needsInput: true,
    available: true,
  },
  {
    name: 'video_wan2_2_i2v',
    title: 'Wan 2.2 14B Image to Video',
    description: 'Turn a still image into a short video clip.',
    category: 'Video',
    tags: ['Video'],
    models: ['Wan 2.2'],
    size: 28000000000,
    date: '2025-07-28',
    username: 'ComfyUI',
    usage: 9000,
    openSource: true,
    source: 'comfy',
    output: 'video',
    needsInput: true,
    available: true,
  },
]
export const demoBuiltin = () => builtinTemplates(LOCAL_MODELS)
export const demoBuiltinMeta = (): ComfyTemplateMeta[] =>
  demoBuiltin().map((tpl) => {
    const meta = builtinTemplateMeta([tpl])[0]
    const model = tpl.name.startsWith('builtin:') ? tpl.name.slice('builtin:'.length) : ''
    return { ...meta, ready: model ? modelReady(localModel(model)!, local) : false }
  })
export const demoAssetHave = (file: string) => {
  const f = LOCAL_FILES.find((x) => x.file === file)
  return !!f && local.files.includes(f.id)
}
export const demoAssetsOf = (name: string) =>
  (DEMO_ASSETS[name] ?? demoBuiltin().find((x) => x.name === `builtin:${name}`)?.assets ?? []).map((a) => ({
    ...a,
    have: demoAssetHave(a.file),
  }))
export const demoCatalog = () => ({
  templates: [
    ...demoBuiltinMeta(),
    ...DEMO_OFFICIAL.map((m) => ({ ...m, ready: demoAssetsOf(m.name).every((a) => a.have) })),
  ],
  updatedAt: '',
  cached: false,
})

let demoWorkflows: ComfyWorkflow[] = []
/** 演示里存下来的工作流链 */
let demoChains: ComfyChain[] = []
export function demoLocal(method: string, seg: string[], body: unknown): unknown {
  const [, action, id, sub] = seg
  // 演示里没有真的 ComfyUI：队列一直是空的，导入只返回一个像真的文件名
  if (action === 'queue') return { up: local.running, url: local.url, running: [], pending: [] }
  if (action === 'workflows') {
    if (method === 'POST' && sub === 'import' && id) {
      const wf = [...BUILTIN_WORKFLOWS, ...demoWorkflows].find((w) => w.id === id)
      if (!wf) return fail('找不到工作流')
      return { name: wf.name, filename: comfyImportFile(wf), url: local.url }
    }
    if (id === 'assist') {
      // 演示没有 AI：在参考的工作流上做一点改动，说明一下
      const b = body as { kind: 'game' | 'web'; instruction: string; base?: ComfyWorkflow }
      const base = b.base ?? BUILTIN_WORKFLOWS.find((w) => w.kind === b.kind)!
      return {
        workflow: {
          ...base,
          id: b.base && !b.base.builtin ? b.base.id : `wf_${Date.now().toString(36)}`,
          name: b.base ? `${base.name}（优化）` : b.instruction.slice(0, 20),
          builtin: undefined,
          extra: [base.extra, 'high detail, crisp clean edges'].filter(Boolean).join(' '),
        },
        note: '演示：在参考工作流的基础上加强了清晰度要求（真实环境里由 AI 按你的要求改写节点和参数）。',
      }
    }
    if (method === 'PUT' && id) {
      const wf = { ...parse(ComfyWorkflow, { ...(body as object), id }), builtin: undefined }
      demoWorkflows = demoWorkflows.some((w) => w.id === id)
        ? demoWorkflows.map((w) => (w.id === id ? wf : w))
        : [...demoWorkflows, wf]
      return wf
    }
    if (method === 'DELETE' && id) {
      demoWorkflows = demoWorkflows.filter((w) => w.id !== id)
      return { ok: true }
    }
    const list = [...BUILTIN_WORKFLOWS, ...demoWorkflows]
    const ready = list.filter((w) => !w.model || (localModel(w.model) && modelReady(localModel(w.model)!, local)))
    return { list, ready: ready.map((w) => w.id) }
  }
  // 工作流链：演示里存得住，但试跑不真的出图（没有 ComfyUI），返回一条说清楚的错误
  if (action === 'chains') {
    const workflows = [...BUILTIN_WORKFLOWS, ...demoWorkflows]
    const ready = workflows
      .filter((w) => !w.model || (localModel(w.model) && modelReady(localModel(w.model)!, local)))
      .map((w) => w.id)
    if (method === 'PUT' && id) {
      const chain = parse(ComfyChain, { ...(body as object), id })
      demoChains = demoChains.some((c) => c.id === id)
        ? demoChains.map((c) => (c.id === id ? chain : c))
        : [...demoChains, chain]
      return { chain, list: demoChains }
    }
    if (method === 'DELETE' && id) {
      demoChains = demoChains.filter((c) => c.id !== id)
      return { list: demoChains }
    }
    if (method === 'POST' && sub === 'run') return fail('演示版没有真的 ComfyUI，安装后才能在本地跑工作流链')
    return { list: demoChains, workflows, ready }
  }
  const tick = (steps: string[], done: () => void, total = 0) => {
    const j: LocalJob = (local.job = {
      id: String(Date.now()),
      kind: total ? 'download' : 'install',
      status: 'running',
      step: steps[0],
      log: '',
      progress: total ? { done: 0, total } : undefined,
    })
    let i = 0
    const timer = setInterval(() => {
      i++
      if (j.progress) j.progress.done = Math.min(total, (total * i) / 8)
      const step = steps[Math.min(steps.length - 1, Math.floor((i * steps.length) / 8))]
      if (step !== j.step) j.log += `${j.step}\n`
      j.step = step
      if (i < 8) return
      clearInterval(timer)
      j.status = 'done'
      done()
    }, demoMs(400))
  }
  if (action === 'templates') {
    if (!id || id === 'refresh') return demoCatalog()
    const builtin = demoBuiltin().find((x) => x.name === id)
    const found = demoBuiltinMeta().find((x) => x.name === id) ?? DEMO_OFFICIAL.find((x) => x.name === id)
    if (!found) return fail('找不到模板')
    const meta = found
    const assets = demoAssetsOf(builtin ? builtin.name.slice('builtin:'.length) : id)
    if (sub === 'add') {
      const kind = (body as { kind?: string } | undefined)?.kind === 'web' ? 'web' : 'game'
      const wf: ComfyWorkflow = {
        id: `wf_${Date.now().toString(36)}`,
        name: `${meta.title}（副本）`,
        kind,
        use: 'any',
        description: meta.description,
        model: builtin ? builtin.name.slice('builtin:'.length) : '',
        assets: assets.map((a) => `${a.dir}/${a.file}`),
        extra: '',
        graph: builtin?.graph ?? DEMO_GRAPH,
        origin: 'template',
        updatedAt: '',
      }
      demoWorkflows.push(wf)
      return wf
    }
    if (sub === 'download') {
      const files = assets.filter((a) => !a.have)
      tick(
        files.map((a) => `下载 ${a.file}`),
        () => {
          for (const a of files) {
            const f = LOCAL_FILES.find((x) => x.file === a.file)
            if (f && !local.files.includes(f.id)) local.files.push(f.id)
          }
        },
        files.reduce((n, a) => n + a.gb * 1024 ** 3, 0),
      )
      return { job: local.job, files, skipped: 0 }
    }
    return {
      template: { ...meta, ready: assets.every((a) => a.have) },
      ...(builtin ? { graph: builtin.graph } : { preview: DEMO_GRAPH }),
      assets,
    }
  }
  if (action === 'install' && method === 'POST')
    tick(
      ['检查 Python', '下载 ComfyUI', '创建 Python 虚拟环境', '安装 PyTorch', '安装 ComfyUI 的依赖', '安装完成'],
      () => {
        local.installed = true
        local.venv = {
          command: '~/agent-panel/comfyui/venv/Scripts/python.exe',
          path: '~/agent-panel/comfyui/venv/Scripts/python.exe',
          version: '3.12.10',
          usable: true,
        }
      },
    )
  if (action === 'start') local.running = local.installed
  if (action === 'stop') local.running = false
  if (action === 'cancel' && local.job) local.job.status = 'failed'
  if (action === 'models' && id) {
    const m = localModel(id)
    if (m && sub === 'download')
      tick(
        m.files.map((f) => `下载 ${localFile(f)!.file}`),
        () => (local.files = [...new Set([...local.files, ...m.files])]),
        m.files.reduce((n, f) => n + localFile(f)!.gb * 1024 ** 3, 0),
      )
    if (m && method === 'DELETE') local.files = local.files.filter((f) => !m.files.includes(f))
  }
  return structuredClone(local)
}
