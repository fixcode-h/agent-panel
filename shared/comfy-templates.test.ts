import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  builtinTemplates,
  filterTemplates,
  normalizeLinks,
  noteUrls,
  templateAssets,
  templatePreview,
  templateToWorkflow,
  type ComfyTemplateMeta,
  type UiGraph,
} from './comfy-templates.ts'
import { LOCAL_MODELS, checkWorkflow } from './local-image.ts'

const meta = (patch: Partial<ComfyTemplateMeta>): ComfyTemplateMeta => ({
  name: 'x',
  title: 'X',
  description: '',
  category: 'Image',
  tags: [],
  models: [],
  size: 0,
  date: '',
  username: 'ComfyUI',
  usage: 0,
  openSource: true,
  source: 'comfy',
  ...patch,
})

/** 一个最小的 SDXL 界面格式工作流（和官方 image_sdxl_simple 的结构一致） */
const sdxl: UiGraph = {
  nodes: [
    {
      id: 3,
      type: 'KSampler',
      inputs: [
        { name: 'model', link: 1 },
        { name: 'positive', link: 2 },
        { name: 'negative', link: 3 },
        { name: 'latent_image', link: 4 },
      ],
      widgets_values: [0, 'randomize', 25, 7, 'dpmpp_2m', 'karras', 1],
    },
    { id: 4, type: 'CheckpointLoaderSimple', widgets_values: ['sd_xl_base_1.0.safetensors'] },
    { id: 5, type: 'EmptyLatentImage', widgets_values: [1024, 1024, 1] },
    { id: 6, type: 'CLIPTextEncode', inputs: [{ name: 'clip', link: 5 }], widgets_values: ['a cat'] },
    { id: 7, type: 'CLIPTextEncode', inputs: [{ name: 'clip', link: 6 }], widgets_values: ['blurry'] },
    {
      id: 8,
      type: 'VAEDecode',
      inputs: [
        { name: 'samples', link: 7 },
        { name: 'vae', link: 8 },
      ],
    },
    { id: 9, type: 'SaveImage', inputs: [{ name: 'images', link: 9 }], widgets_values: ['out'] },
    {
      id: 10,
      type: 'MarkdownNote',
      widgets_values: [
        '- [sd_xl_base_1.0.safetensors](https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors) (6.46 GB)',
      ],
    },
  ],
  links: [
    [1, 4, 0, 3, 0, 'MODEL'],
    [2, 6, 0, 3, 1, 'CONDITIONING'],
    [3, 7, 0, 3, 2, 'CONDITIONING'],
    [4, 5, 0, 3, 3, 'LATENT'],
    [5, 4, 1, 6, 0, 'CLIP'],
    [6, 4, 1, 7, 0, 'CLIP'],
    [7, 3, 0, 8, 0, 'LATENT'],
    [8, 4, 2, 8, 1, 'VAE'],
    [9, 8, 0, 9, 0, 'IMAGE'],
  ],
}

test('links 的数组和对象两种写法都能读', () => {
  assert.deepEqual(normalizeLinks([[1, 2, 0, 3, 1, 'MODEL']])[0], {
    id: 1,
    origin_id: 2,
    origin_slot: 0,
    target_id: 3,
    target_slot: 1,
    type: 'MODEL',
  })
  const object = normalizeLinks([{ id: 2, origin_id: 4, origin_slot: 1, target_id: 5, target_slot: 2 }])[0]
  assert.equal(object.origin_id, 4)
  assert.equal(object.target_id, 5)
})

test('模板筛选：搜索、分类、来源、就绪状态和排序', () => {
  const list = [
    meta({ name: 'a', title: 'Z-Image Turbo', tags: ['Text to Image'], usage: 10, date: '2026-01-01' }),
    meta({ name: 'b', title: 'Flux Fill', tags: ['Inpainting'], usage: 999, date: '2026-03-01', size: 100 }),
    meta({
      name: 'c',
      title: '面板内置',
      source: 'builtin',
      category: 'builtin',
      usage: 0,
      ready: true,
      size: 200,
    }),
  ]
  const q = {
    category: 'all',
    query: '',
    source: 'all' as const,
    ready: 'all' as const,
    sort: 'recommended' as const,
  }
  assert.deepEqual(
    filterTemplates(list, q).map((m) => m.name),
    ['c', 'b', 'a'],
  )
  assert.deepEqual(
    filterTemplates(list, { ...q, query: 'inpainting' }).map((m) => m.name),
    ['b'],
  )
  assert.deepEqual(
    filterTemplates(list, { ...q, category: 'Image', source: 'comfy' }).map((m) => m.name),
    ['b', 'a'],
  )
  assert.deepEqual(
    filterTemplates(list, { ...q, ready: 'ready' }).map((m) => m.name),
    ['c'],
  )
  assert.deepEqual(
    filterTemplates(list, { ...q, sort: 'newest' }).map((m) => m.name),
    ['b', 'a', 'c'],
  )
  assert.deepEqual(
    filterTemplates(list, { ...q, sort: 'smallest' }).map((m) => m.name),
    ['b', 'c', 'a'],
  )
})

test('从模板说明里读出下载地址和大小', () => {
  const urls = noteUrls(sdxl)
  assert.equal(
    urls.get('sd_xl_base_1.0.safetensors')?.url,
    'https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors',
  )
  assert.ok(Math.abs((urls.get('sd_xl_base_1.0.safetensors')?.gb ?? 0) - 6.46) < 0.01)
})

test('依赖解析：加载节点里的文件名、目录和地址', () => {
  const assets = templateAssets(sdxl)
  assert.deepEqual(assets, [
    {
      dir: 'checkpoints',
      file: 'sd_xl_base_1.0.safetensors',
      url: 'https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors',
      gb: 6.46,
    },
  ])
})

test('预览图保留节点、控件和连线', () => {
  const graph = templatePreview(sdxl)
  assert.equal(graph['3'].class_type, 'KSampler')
  assert.deepEqual(graph['3'].inputs.positive, ['6', 0])
  assert.equal(graph['3'].inputs.steps, 25)
  assert.equal(graph['4'].inputs.ckpt_name, 'sd_xl_base_1.0.safetensors')
  assert.equal(graph['10'], undefined, '说明节点不进预览图')
})

test('界面格式转成接口格式：控件名、连线、占位符', () => {
  const wf = templateToWorkflow(sdxl, meta({ title: 'SDXL' }), { kind: 'game', id: 'wf_test' })
  assert.equal(wf.graph['6'].inputs.text, '{{prompt}}')
  assert.equal(wf.graph['7'].inputs.text, '{{negative}}')
  assert.equal(wf.graph['5'].inputs.width, '{{width}}')
  assert.equal(wf.graph['3'].inputs.seed, '{{seed}}')
  assert.deepEqual(wf.graph['3'].inputs.model, ['4', 0])
  assert.equal(wf.graph['3'].inputs.steps, 25)
  assert.equal(wf.graph['3'].inputs.cfg, 7)
  assert.deepEqual(wf.assets, ['checkpoints/sd_xl_base_1.0.safetensors'])
  assert.deepEqual(checkWorkflow(wf.graph), [])
})

test('不认识的节点直接报错，不生成跑不了的工作流', () => {
  const ui: UiGraph = {
    nodes: [
      { id: 1, type: 'MysteryNode', widgets_values: [1] },
      { id: 2, type: 'SaveImage', inputs: [{ name: 'images', link: 1 }], widgets_values: ['x'] },
    ],
    links: [[1, 1, 0, 2, 0, 'IMAGE']],
  }
  assert.throws(() => templateToWorkflow(ui, meta({ title: 'X' }), { kind: 'game', id: 'wf' }), /MysteryNode/)
})

test('子图展开：内部节点加前缀，输出接到外面的节点', () => {
  const ui: UiGraph = {
    definitions: {
      subgraphs: [
        {
          id: 'sg',
          inputs: [{ name: 'text', linkIds: [2] }],
          outputs: [{ name: 'IMAGE', linkIds: [1] }],
          nodes: [
            { id: 1, type: 'CLIPTextEncode', inputs: [{ name: 'text', link: 2 }], widgets_values: ['prompt'] },
            { id: 2, type: 'SaveImage', inputs: [{ name: 'images', link: 1 }], widgets_values: ['x'] },
          ],
          links: [
            [1, 1, 0, 2, 0, 'IMAGE'],
            [2, -10, 0, 1, 0, 'STRING'],
            [3, 1, 0, -20, 0, 'IMAGE'],
          ],
        },
      ],
    },
    nodes: [
      { id: 5, type: 'sg', inputs: [{ name: 'text', link: null }], outputs: [{ name: 'IMAGE', links: [3] }] },
      { id: 9, type: 'SaveImage', inputs: [{ name: 'images', link: 3 }], widgets_values: ['out'] },
    ],
    links: [[3, 5, 0, 9, 0, 'IMAGE']],
  }
  const graph = templatePreview(ui)
  assert.ok(graph['5/1'])
  assert.equal(graph['5/1'].class_type, 'CLIPTextEncode')
  assert.deepEqual(graph['9'].inputs.images, ['5/1', 0])
})

test('内置模板每个模型一条，依赖和占位符都完整', () => {
  const list = builtinTemplates(LOCAL_MODELS)
  assert.equal(list.length, LOCAL_MODELS.length)
  for (const tpl of list) {
    assert.equal(tpl.source, 'builtin')
    assert.ok(tpl.assets.length > 0, tpl.name)
    assert.deepEqual(checkWorkflow(tpl.graph), [], tpl.name)
    assert.ok(JSON.stringify(tpl.graph).includes('{{prompt}}'), tpl.name)
  }
})
