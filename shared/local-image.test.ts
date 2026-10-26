import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BUILTIN_WORKFLOWS,
  IMAGE_INPUT_LATENT,
  IMAGE_INPUT_NODE,
  IMAGE_PLACEHOLDER,
  IMG2IMG_DENOISE,
  UPSCALE_FACTOR,
  checkWorkflow,
  comfyFilenamePrefix,
  comfyImportFile,
  comfyQueueEntry,
  comfyQueueLists,
  comfySavePrefix,
  fillWorkflow,
  imageToImage,
  importableWorkflow,
  inpaintWorkflow,
  markSavePrefix,
  needsInputImage,
  pickWorkflow,
  workflowInKind,
  type ComfyWorkflow,
} from './local-image.ts'

const wf = (id: string) => BUILTIN_WORKFLOWS.find((w) => w.id === id)!

test('局部重绘工作流：原图和蒙版读进来，采样器改成从蒙版 latent 取样', () => {
  const g = inpaintWorkflow(wf('game-concept').graph, { image: 'panel-1.png', mask: 'mask-1.png' })!
  assert.equal(g['ip_image'].class_type, 'LoadImage')
  assert.deepEqual(g['ip_image'].inputs, { image: 'panel-1.png' })
  assert.deepEqual(g['ip_mask'].inputs, { image: 'mask-1.png' })
  assert.equal(g['ip_encode'].class_type, 'VAEEncode')
  assert.deepEqual(g['ip_encode'].inputs.pixels, ['ip_image', 0])
  assert.deepEqual(g['ip_encode'].inputs.vae, ['vae', 0])
  assert.equal(g['ip_masknode'].class_type, 'ImageToMask')
  assert.deepEqual(g['ip_masknode'].inputs, { image: ['ip_mask', 0], channel: 'red' })
  assert.equal(g['ip_set'].class_type, 'SetLatentNoiseMask')
  assert.deepEqual(g['ip_set'].inputs, { samples: ['ip_encode', 0], mask: ['ip_masknode', 0] })
  assert.deepEqual(g['sample'].inputs.latent_image, ['ip_set', 0])
})

test('SDXL / FLUX.1 工作流的 VAE 从 CheckpointLoaderSimple 取', () => {
  const g = inpaintWorkflow(wf('game-pixel').graph, { image: 'a.png', mask: 'b.png' })!
  assert.deepEqual(g['ip_encode'].inputs.vae, ['ckpt', 2])
  assert.deepEqual(g['sample'].inputs.latent_image, ['ip_set', 0])
})

test('找不到采样器或 VAE 的工作流不做局部重绘', () => {
  assert.equal(inpaintWorkflow({}, { image: 'a.png', mask: 'b.png' }), undefined)
  assert.equal(
    inpaintWorkflow(
      { save: { class_type: 'SaveImage', inputs: { images: ['x', 0], filename_prefix: 'a' } } },
      { image: 'a.png', mask: 'b.png' },
    ),
    undefined,
  )
})

test('局部重绘工作流填完占位符后描述还在', () => {
  const g = inpaintWorkflow(wf('game-concept').graph, { image: 'a.png', mask: 'b.png' })!
  const filled = fillWorkflow(g, {
    prompt: 'a cozy tavern',
    negative: 'text',
    width: 1024,
    height: 576,
    count: 1,
    seed: 7,
  })
  assert.equal(filled['pos'].inputs.text, 'a cozy tavern')
  assert.deepEqual(filled['ip_image'].inputs, { image: 'a.png' })
})

const graph: ComfyWorkflow['graph'] = {
  pos: { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } },
  save: { class_type: 'SaveImage', inputs: { images: ['pos', 0], filename_prefix: 'agent-panel' } },
}

test('队列兼容新旧两种格式', () => {
  const old = comfyQueueLists({
    queue_running: [[0, 'a']],
    queue_pending: [
      [1, 'b'],
      [2, 'c'],
    ],
  })
  assert.deepEqual(old.running, [[0, 'a']])
  assert.equal(old.pending.length, 2)

  const next = comfyQueueLists({ Running: [{ prompt_id: 'a' }], Pending: [{ prompt_id: 'b' }] })
  assert.deepEqual(next.running, [{ prompt_id: 'a' }])
  assert.deepEqual(next.pending, [{ prompt_id: 'b' }])

  assert.deepEqual(comfyQueueLists(undefined), { running: [], pending: [] })
  assert.deepEqual(comfyQueueLists('bad'), { running: [], pending: [] })
})

test('旧版队列项是数组：序号、prompt_id、节点图和 extra_data 都在', () => {
  const e = comfyQueueEntry(
    [
      3,
      'prompt-1',
      graph,
      { agent_panel: { source: 'design', workflowId: 'game-icon', name: '游戏图标 · 道具与技能', use: 'icon' } },
    ],
    'running',
  )
  assert.equal(e?.id, 'prompt-1')
  assert.equal(e?.number, 3)
  assert.equal(e?.status, 'running')
  assert.equal(e?.source, 'design')
  assert.equal(e?.workflowId, 'game-icon')
  assert.equal(e?.workflowName, '游戏图标 · 道具与技能')
  assert.equal(e?.use, 'icon')
  assert.deepEqual(e?.prompt, graph)
})

test('新版队列项是对象：没有来源信息时从 SaveImage 前缀里认名字', () => {
  const e = comfyQueueEntry(
    {
      prompt_id: 'prompt-2',
      number: 7,
      prompt: {
        save: { class_type: 'SaveImage', inputs: { images: ['x', 0], filename_prefix: 'agent-panel/网页插画' } },
      },
    },
    'pending',
  )
  assert.equal(e?.id, 'prompt-2')
  assert.equal(e?.source, undefined)
  assert.equal(e?.workflowName, '网页插画')

  // 节点图拿不到时这一项没法展示，直接跳过
  assert.equal(comfyQueueEntry({ prompt_id: 'x', prompt: '' }, 'pending'), undefined)
  assert.equal(comfyQueueEntry(null, 'pending'), undefined)
})

test('提交前把 SaveImage 前缀换成工作流名，名字里的路径和非法字符清理掉', () => {
  assert.equal(comfyFilenamePrefix('游戏图标 · 道具与技能'), 'agent-panel/游戏图标 · 道具与技能')
  assert.equal(comfyFilenamePrefix('a/b:c*?"<>|'), 'agent-panel/a b c')
  assert.equal(comfyFilenamePrefix('   '), 'agent-panel/workflow')
  assert.equal(comfyFilenamePrefix('x'.repeat(100)), `agent-panel/${'x'.repeat(40)}`)

  const marked = markSavePrefix(graph, '网页插画')
  assert.equal(comfySavePrefix(marked), 'agent-panel/网页插画')
  assert.deepEqual(marked.pos, graph.pos)
  // 不修改传进来的图
  assert.equal(comfySavePrefix(graph), 'agent-panel')
})

test('导入到 ComfyUI 的工作流换成能直接跑的示例值', () => {
  const wf = BUILTIN_WORKFLOWS.find((w) => w.id === 'game-icon')!
  const g = importableWorkflow(wf)
  const text = JSON.stringify(g)
  assert.equal(text.includes('{{'), false)
  assert.equal(comfySavePrefix(g), `agent-panel/${wf.name}`)
  const positive = Object.values(g).find((n) => n.class_type === 'CLIPTextEncode')!
  assert.equal(typeof positive.inputs.text, 'string')
  assert.equal(positive.inputs.text, wf.description)
  const latent = Object.values(g).find((n) => /Empty.*LatentImage/.test(n.class_type))!
  assert.equal(latent.inputs.width, 1024)
  assert.equal(latent.inputs.height, 1024)
  assert.equal(latent.inputs.batch_size, 1)
  const sample = Object.values(g).find((n) => typeof n.inputs.seed === 'number')
  assert.equal(typeof sample?.inputs.seed, 'number')
})

test('导入文件名保留工作流名和 id：重复导入覆盖同一个文件', () => {
  assert.equal(
    comfyImportFile({ id: 'game-icon', name: '游戏图标 · 道具与技能' }),
    '游戏图标 · 道具与技能-game-icon.json',
  )
  assert.equal(comfyImportFile({ id: 'wf_a/b', name: 'a/b:c' }), 'a b c-wf_ab.json')
  assert.equal(comfyImportFile({ id: 'x', name: '   ' }), 'workflow-x.json')
})

test('去背景工作流：LoadImage → RemoveBackground → InvertMask → JoinImageWithAlpha', () => {
  const g = wf('game-remove-bg').graph
  assert.equal(g.image.class_type, 'LoadImage')
  assert.equal(g.image.inputs.image, IMAGE_PLACEHOLDER)
  // 模型文件必须是 ComfyUI 的 background_removal 目录里那个名字，写错节点会报找不到模型
  assert.equal(g.model.class_type, 'LoadBackgroundRemovalModel')
  assert.equal(g.model.inputs.bg_removal_name, 'birefnet.safetensors')
  assert.deepEqual(g.remove.inputs.bg_removal_model, ['model', 0])
  assert.deepEqual(g.remove.inputs.image, ['image', 0])
  // RemoveBackground 出的是前景 mask，JoinImageWithAlpha 内部按 1-mask 算 alpha，所以要 InvertMask
  assert.deepEqual(g.invert.inputs.mask, ['remove', 0])
  assert.deepEqual(g.alpha.inputs, { image: ['image', 0], alpha: ['invert', 0] })
  assert.deepEqual(g.save.inputs.images, ['alpha', 0])
  assert.deepEqual(checkWorkflow(g), [])
  assert.ok(needsInputImage(g))
})

test('放大工作流：插值放大用真实节点 ImageScaleBy', () => {
  const g = wf('game-upscale').graph
  assert.equal(g.scale.class_type, 'ImageScaleBy')
  assert.equal(g.scale.inputs.scale_by, UPSCALE_FACTOR)
  assert.equal(g.scale.inputs.upscale_method, 'lanczos')
  assert.deepEqual(g.scale.inputs.image, ['image', 0])
  assert.deepEqual(checkWorkflow(g), [])
  // 不依赖任何模型文件，装了 ComfyUI 就能跑
  assert.deepEqual(wf('game-upscale').assets, [])
})

test('图生图工作流：原图 VAE 编码成 latent，采样器降 denoise', () => {
  const g = wf('game-img2img').graph
  assert.equal(g[IMAGE_INPUT_NODE].class_type, 'LoadImage')
  assert.equal(g[IMAGE_INPUT_NODE].inputs.image, IMAGE_PLACEHOLDER)
  assert.equal(g[IMAGE_INPUT_LATENT].class_type, 'VAEEncode')
  assert.deepEqual(g[IMAGE_INPUT_LATENT].inputs.pixels, [IMAGE_INPUT_NODE, 0])
  assert.deepEqual(g.sample.inputs.latent_image, [IMAGE_INPUT_LATENT, 0])
  assert.equal(g.sample.inputs.denoise, IMG2IMG_DENOISE)
  // 还是要有提示词：风格靠描述换，只靠原图换不出新东西
  assert.equal(g.pos.inputs.text, '{{prompt}}')
  assert.deepEqual(checkWorkflow(g), [])
  assert.ok(needsInputImage(g))
})

test('imageToImage 能把任何带采样器和 VAE 的工作流改成图生图', () => {
  const g = imageToImage(wf('game-icon').graph, { image: 'a.png', denoise: 0.3 })!
  assert.equal(g[IMAGE_INPUT_NODE].inputs.image, 'a.png')
  assert.equal(g.sample.inputs.denoise, 0.3)

  // KSampler 之外用 SamplerCustomAdvanced 的工作流：没有 denoise，用 SplitSigmasDenoise 只走后半段
  const custom = imageToImage(wf('game-fast').graph, { image: 'b.png', denoise: 0.5 })!
  const split = Object.values(custom).find((n) => n.class_type === 'SplitSigmasDenoise')!
  assert.equal(split.inputs.denoise, 0.5)
  assert.deepEqual(custom.sample.inputs.sigmas, [Object.keys(custom).find((k) => custom[k] === split)!, 1])
  assert.deepEqual(custom.sample.inputs.latent_image, [IMAGE_INPUT_LATENT, 0])

  // 没有 VAE 的工作流改不了
  assert.equal(imageToImage({ s: { class_type: 'KSampler', inputs: {} } }, { image: 'c.png' }), undefined)
})

test('需要输入图的工作流不参与自动挑选', () => {
  const all = () => true
  for (const use of ['icon', 'button', 'panel', 'background', 'concept', 'illustration', 'any'] as const) {
    const got = pickWorkflow(BUILTIN_WORKFLOWS, 'auto', 'game', use, all)!
    assert.ok(!needsInputImage(got.graph), `${use} 选到了 ${got.id}`)
  }
  // 明确指定时照样能用（界面上手动选了它）
  assert.equal(pickWorkflow(BUILTIN_WORKFLOWS, 'game-remove-bg', 'game', 'any', all)?.id, 'game-remove-bg')
})

test('处理类工作流在游戏和网页两边都列出来', () => {
  assert.ok(workflowInKind(wf('game-remove-bg'), 'game'))
  assert.ok(workflowInKind(wf('game-remove-bg'), 'web'))
  assert.ok(!workflowInKind(wf('game-icon'), 'web'))
})

test('输入图占位符由 fillWorkflow 换成文件名，不传时保持原样', () => {
  const g = wf('game-remove-bg').graph
  const filled = fillWorkflow(g, {
    prompt: 'p',
    negative: '',
    width: 512,
    height: 512,
    count: 1,
    seed: 1,
    image: 'panel-1.png',
  })
  assert.equal(filled.image.inputs.image, 'panel-1.png')
  const kept = fillWorkflow(g, { prompt: 'p', negative: '', width: 512, height: 512, count: 1, seed: 1 })
  assert.equal(kept.image.inputs.image, IMAGE_PLACEHOLDER)
})

test('导入到 ComfyUI 的处理类工作流填上示例图，能直接打开', () => {
  const g = importableWorkflow(wf('game-remove-bg'))
  assert.equal(JSON.stringify(g).includes('{{'), false)
  assert.equal(g.image.inputs.image, 'example.png')
})
