import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BUILTIN_WORKFLOWS,
  LOCAL_FILES,
  LOCAL_MODELS,
  PYTHON_RANGE,
  PYTHON_SUPPORT,
  PYTHON_VERSIONS,
  autoPlaceholders,
  checkWorkflow,
  fillWorkflow,
  imageUse,
  localSize,
  localWorkflow,
  parsePythonProbe,
  pickWorkflow,
  pythonIssueText,
  pythonSupport,
  torchIndexes,
  type ComfyWorkflow,
} from '../shared/local-image.ts'
import { t } from '../shared/i18n.ts'
import { localPrompts } from '../shared/design.ts'
import { blank, hasAlpha, removeFlatBackground } from './image.ts'

test('内置工作流都能通过检查，占位符换成实际的值', () => {
  for (const wf of BUILTIN_WORKFLOWS) {
    assert.deepEqual(checkWorkflow(wf.graph), [], wf.id)
    // 处理类工作流（纯插值放大）不依赖任何模型，写了模型的就必须在清单里
    if (wf.model)
      assert.ok(
        LOCAL_MODELS.some((m) => m.id === wf.model),
        wf.id,
      )
  }
  const g = fillWorkflow(BUILTIN_WORKFLOWS[0].graph, {
    prompt: 'a sword',
    negative: 'blurry',
    width: 1024,
    height: 768,
    count: 2,
    seed: 42,
  })
  const s = JSON.stringify(g)
  assert.ok(s.includes('"a sword"') && !s.includes('{{'))
  assert.equal(g.latent.inputs.width, 1024)
  assert.equal(g.latent.inputs.batch_size, 2)
  assert.equal(g.sample.inputs.seed, 42)
})

test('出图尺寸按比例换算成 64 的倍数', () => {
  assert.deepEqual(localSize(100, 100, 1024), { width: 1024, height: 1024 })
  const wide = localSize(1920, 1080, 1024)
  assert.ok(wide.width > wide.height && wide.width % 64 === 0 && wide.height % 64 === 0)
})

test('自动模式按图片用途和分类选工作流，模型没下载的跳过', () => {
  const all = () => true
  assert.equal(pickWorkflow(BUILTIN_WORKFLOWS, 'auto', 'game', 'icon', all)?.id, 'game-icon')
  assert.equal(pickWorkflow(BUILTIN_WORKFLOWS, 'auto', 'web', 'icon', all)?.id, 'web-icon')
  const onlyKlein = (w: { model: string }) => w.model === 'flux2-klein'
  assert.equal(pickWorkflow(BUILTIN_WORKFLOWS, 'auto', 'game', 'icon', onlyKlein)?.id, 'game-fast')
  assert.equal(pickWorkflow(BUILTIN_WORKFLOWS, 'game-panel', 'game', 'icon', () => false)?.id, 'game-panel')
  assert.equal(imageUse({ width: 96, height: 96, transparent: true }, 'game'), 'icon')
  assert.equal(imageUse({ width: 600, height: 400, transparent: true, nineSlice: {} }, 'game'), 'panel')
  assert.equal(imageUse({ width: 1920, height: 1080, transparent: false }, 'game'), 'background')
})

test('导入的工作流自动换上占位符', () => {
  const g = autoPlaceholders({
    '3': {
      class_type: 'KSampler',
      inputs: { seed: 5, positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0], model: ['4', 0] },
    },
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'x.safetensors' } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: 'cat', clip: ['4', 1] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: 'bad', clip: ['4', 1] } },
    '9': { class_type: 'SaveImage', inputs: { images: ['8', 0] } },
  })
  assert.equal(g['6'].inputs.text, '{{prompt}}')
  assert.equal(g['7'].inputs.text, '{{negative}}')
  assert.equal(g['5'].inputs.width, '{{width}}')
  assert.equal(g['3'].inputs.seed, '{{seed}}')
  assert.match(checkWorkflow(g).join(), /8/)
})

test('SDXL 用压缩的关键词，新模型用完整描述', () => {
  const full = 'Game UI asset: a sword\nCrisp.\nNegative prompt (none of these may appear): blurry, text.'
  const short = { subject: 'a sword', style: 'dark fantasy', chroma: true }
  const a = localPrompts(full, true, short)
  assert.ok(!a.prompt.includes('Negative') && a.negative === 'blurry, text')
  const b = localPrompts(full, false, short)
  assert.match(b.prompt, /^a sword, game ui asset, dark fantasy/)
  assert.match(b.prompt, /green background/)
})

test('纯色底抠成透明，场景图不动', () => {
  const img = blank(40, 40, [250, 250, 250, 255])
  for (let y = 10; y < 30; y++) for (let x = 10; x < 30; x++) img.data.set([200, 30, 30, 255], (y * 40 + x) * 4)
  const out = removeFlatBackground(img)
  assert.ok(hasAlpha(out))
  assert.equal(out.data[3], 0)
  assert.equal(out.data[(20 * 40 + 20) * 4 + 3], 255)
  // 边上颜色杂乱（场景）：不抠
  const scene = blank(40, 40)
  for (let i = 0; i < scene.data.length; i += 4)
    scene.data.set([(i * 37) % 255, (i * 91) % 255, (i * 13) % 255, 255], i)
  assert.equal(removeFlatBackground(scene), scene)
})

test('Python 版本判定按共享的范围：3.10~3.14 可用，范围外和 3.14.1 不行', () => {
  assert.deepEqual(pythonSupport('3.10.4'), { ok: true })
  assert.deepEqual(pythonSupport('3.12.10'), { ok: true })
  assert.deepEqual(pythonSupport('3.13.2'), { ok: true })
  assert.deepEqual(pythonSupport('3.14'), { ok: true })
  assert.deepEqual(pythonSupport('3.14.0'), { ok: true })
  assert.deepEqual(pythonSupport('3.9.13'), { ok: false, issue: 'too-old' })
  assert.deepEqual(pythonSupport('3.15.0'), { ok: false, issue: 'too-new' })
  // torchvision 的 requires-python 排除了 3.14.1，装不上
  assert.deepEqual(pythonSupport('3.14.1'), { ok: false, issue: 'blocked' })
  // 范围、候选顺序都只有这一处定义
  assert.equal(PYTHON_RANGE, `${PYTHON_SUPPORT.min} ~ ${PYTHON_SUPPORT.max}`)
  assert.deepEqual(PYTHON_VERSIONS, ['3.14', '3.13', '3.12', '3.11', '3.10'])
})

test('解析探测 Python 的输出：版本一行、解释器路径一行', () => {
  assert.deepEqual(parsePythonProbe('3.14.0\r\nC:\Python314\python.exe\r\n'), {
    version: '3.14.0',
    path: 'C:\Python314\python.exe',
  })
  assert.deepEqual(parsePythonProbe('3.13.7\n/usr/bin/python3.13\n'), {
    version: '3.13.7',
    path: '/usr/bin/python3.13',
  })
  // 没装或者跑不起来：命令的输出不是版本，当作没探到
  assert.deepEqual(parsePythonProbe('   '), { version: undefined, path: undefined })
  assert.deepEqual(parsePythonProbe('Traceback (most recent call last):\n'), {
    version: undefined,
    path: undefined,
  })
})

test('版本不支持的说明带上范围和建议版本', () => {
  assert.equal(
    pythonIssueText('3.15.0', 'too-new'),
    t('Python {v} 太新了：PyTorch 还没有这个版本的安装包，目前支持到 {range}', { v: '3.15.0', range: PYTHON_RANGE }),
  )
  assert.equal(
    pythonIssueText('3.14.1', 'blocked'),
    t('Python {v} 装不上：ComfyUI 的依赖还没有这个版本的安装包，请改用 {recommend}', {
      v: '3.14.1',
      recommend: PYTHON_SUPPORT.recommend,
    }),
  )
  assert.ok(pythonIssueText('3.9.13', 'too-old').includes(PYTHON_SUPPORT.min))
})

test('装 PyTorch 开了镜像先用国内的，失败再回退官方源；苹果只走 PyPI', () => {
  const [first, second] = torchIndexes('cuda', true)
  assert.ok(first.includes('mirror.sjtu.edu.cn'), '开了镜像时第一条是国内镜像')
  assert.equal(second, 'https://download.pytorch.org/whl/cu130', '镜像装不上时回退官方源')
  assert.deepEqual(torchIndexes('cuda', false), ['https://download.pytorch.org/whl/cu130'])
  // 苹果芯片的 torch 在 PyPI 上，没有单独的索引
  assert.deepEqual(torchIndexes('mps', true), [''])
})

test('MOSS-Image 模型：文件都在清单里，地址都在官方仓库', () => {
  const m = LOCAL_MODELS.find((x) => x.id === 'moss-image')!
  assert.equal(m.family, 'moss')
  assert.equal(m.license, 'Apache-2.0')
  assert.equal(m.base, 1024)
  assert.equal(m.natural, true)
  assert.ok(m.vram >= 16)
  for (const id of m.files) {
    const f = LOCAL_FILES.find((x) => x.id === id)
    assert.ok(f, id)
    assert.match(f.url, /^https:\/\/huggingface\.co\/Comfy-Org\/MOSS-Image\/resolve\/main\//)
  }
})

test('MOSS-Image 走 {{layout}} 占位符，不写 {{prompt}} 也能通过检查', () => {
  const g = BUILTIN_WORKFLOWS.find((w) => w.id === 'game-moss-layout')!.graph
  assert.deepEqual(checkWorkflow(g), [])
  const nodes = Object.values(g)
  const clip = nodes.find((n) => n.class_type === 'CLIPLoader')!
  assert.equal(clip.inputs.type, 'moss_image')
  assert.match(String(clip.inputs.clip_name), /qwen3\.5_9b/)
  const pos = nodes.find((n) => n.class_type === 'CLIPTextEncode' && n.inputs.text === '{{layout}}')
  assert.ok(pos)
  assert.equal(
    nodes.find((n) => n.class_type === 'UNETLoader')?.inputs.unet_name,
    'moss_image_sft_int8_convrot.safetensors',
  )
  assert.equal(nodes.find((n) => n.class_type === 'VAELoader')?.inputs.vae_name, 'flux2-vae_small.safetensors')
  // 官方模板的跳过层引导：第 22 层，前 50% 步数生效
  const slg = nodes.find((n) => n.class_type === 'SkipLayerGuidanceDiTSimple')!
  assert.equal(slg.inputs.single_layers, '22')
  assert.equal(slg.inputs.start_percent, 0)
  assert.equal(slg.inputs.end_percent, 0.5)
  assert.deepEqual(slg.inputs.model, ['unet', 0])
  // 25 步、CFG 2.5、er_sde
  const ks = nodes.find((n) => n.class_type === 'KSampler')!
  assert.equal(ks.inputs.steps, 25)
  assert.equal(ks.inputs.cfg, 2.5)
  assert.equal(ks.inputs.sampler_name, 'er_sde')
  assert.deepEqual(ks.inputs.model, ['slg', 0])
})

test('导入带 {{layout}} 的工作流不会被自动占位符改成 {{prompt}}', () => {
  const g = autoPlaceholders({
    pos: { class_type: 'CLIPTextEncode', inputs: { text: '{{layout}}' } },
    sample: { class_type: 'KSampler', inputs: { positive: ['pos', 0], seed: 1 } },
    latent: { class_type: 'EmptyFlux2LatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
    save: { class_type: 'SaveImage', inputs: { images: ['pos', 0] } },
  })
  assert.equal(g.pos.inputs.text, '{{layout}}')
})

test('MOSS-Image 的 bf16 版本用自己那一套文件', () => {
  const m = LOCAL_MODELS.find((x) => x.id === 'moss-image-bf16')!
  const g = localWorkflow(m, { prompt: 'p', negative: 'n', width: 1024, height: 1024, count: 1, seed: 1 })
  assert.equal(g.unet.inputs.unet_name, 'moss_image_sft_bf16.safetensors')
  assert.equal(g.clip.inputs.clip_name, 'qwen3.5_9b_bf16.safetensors')
  assert.equal(g.vae.inputs.vae_name, 'flux2-vae_small.safetensors')
})

test('fillWorkflow：有布局 JSON 时替换 {{layout}}，没有时回退成描述', () => {
  const g = BUILTIN_WORKFLOWS.find((w) => w.id === 'game-moss-layout')!.graph
  const values = {
    prompt: 'a game menu',
    negative: 'blurry',
    width: 1024,
    height: 1024,
    count: 1,
    seed: 7,
  }
  const filled = fillWorkflow(g, { ...values, layout: '{"items":[]}' })
  assert.ok(Object.values(filled).some((n) => n.class_type === 'CLIPTextEncode' && n.inputs.text === '{"items":[]}'))
  const fallback = fillWorkflow(g, values)
  assert.ok(Object.values(fallback).some((n) => n.class_type === 'CLIPTextEncode' && n.inputs.text === 'a game menu'))
  assert.equal(JSON.stringify(fallback).includes('{{layout}}'), false)
})

test('有布局时优先选能接 {{layout}} 的工作流，没有时保持原来的顺序', () => {
  const hasLayout = (w: { graph: ComfyWorkflow['graph'] }) => JSON.stringify(w.graph).includes('{{layout}}')
  assert.equal(
    pickWorkflow(BUILTIN_WORKFLOWS, 'auto', 'game', 'concept', () => true, hasLayout)?.id,
    'game-moss-layout',
  )
  assert.equal(pickWorkflow(BUILTIN_WORKFLOWS, 'auto', 'game', 'concept', () => true)?.id, 'game-concept')
  // 别的用途不会因为有布局就跳到 concept 工作流
  assert.equal(pickWorkflow(BUILTIN_WORKFLOWS, 'auto', 'game', 'icon', () => true, hasLayout)?.id, 'game-icon')
})
