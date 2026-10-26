import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BUILTIN_WORKFLOWS,
  IMAGE_INPUT_LATENT,
  IMAGE_INPUT_NODE,
  IMAGE_PLACEHOLDER,
  checkWorkflow,
  imageToImage,
  workflowInKind,
  type ComfyWorkflow,
} from './local-image.ts'
import {
  ComfyChain,
  chainGraph,
  chainNeedsImage,
  chainNotes,
  chainPrefix,
  checkChain,
  defaultChainSteps,
} from './comfy-chain.ts'
import { t } from './i18n.ts'

const wf = (id: string): ComfyWorkflow => BUILTIN_WORKFLOWS.find((w) => w.id === id)!
const steps = (...ids: string[]) => ids.map((id) => ({ workflow: wf(id) }))
const merge = (list: ReturnType<typeof steps>, image?: string) => chainGraph(list, { image, makeImg2Img: imageToImage })
/** 合并后的节点 id */
const at = (i: number, id: string) => `${chainPrefix(i)}${id}`
const loaders = (g: ComfyWorkflow['graph']) =>
  Object.entries(g)
    .filter(([, n]) => n.class_type === 'LoadImage')
    .map(([id]) => id)

test('两段链：下游的用图节点直接吃上游的出口，中间图不落盘', () => {
  // 图生图 → 去背景：先按描述重画，再把主体抠成透明底
  const g = merge(steps('game-img2img', 'game-remove-bg'), 'panel-1.png')
  // 只有第一段的锚点还是 LoadImage，填的是外部传进来的图
  assert.deepEqual(loaders(g), [at(0, IMAGE_INPUT_NODE)])
  assert.equal(g[at(0, IMAGE_INPUT_NODE)].inputs.image, 'panel-1.png')
  // 上游出口是第 0 段的解码节点（图生图没有额外的后处理）
  assert.equal(g[at(0, 'decode')].class_type, 'VAEDecode')
  // 第二段：RemoveBackground 的 image 输入 + JoinImageWithAlpha 的 image 输入都改成接上游
  assert.deepEqual(g[at(1, 'remove')].inputs.image, [at(0, 'decode'), 0])
  assert.deepEqual(g[at(1, 'alpha')].inputs.image, [at(0, 'decode'), 0])
  // 只有最后一段保留 SaveImage
  const saves = Object.entries(g).filter(([, n]) => n.class_type === 'SaveImage')
  assert.deepEqual(
    saves.map(([id]) => id),
    [at(1, 'save')],
  )
  // 中间图不落盘：除了最后一段，没有别的 SaveImage
  assert.equal(JSON.stringify(g).includes(IMAGE_PLACEHOLDER), false)
})

test('去背景 → 图生图：去背景的输出接到图生图的 VAEEncode', () => {
  const g = merge(steps('game-remove-bg', 'game-img2img'), 'panel-1.png')
  assert.equal(g[at(0, 'alpha')].class_type, 'JoinImageWithAlpha')
  // 第二段的 LoadImage 锚点被删掉，编码节点直接吃上游的透明底图
  assert.equal(g[at(1, IMAGE_INPUT_NODE)], undefined)
  assert.deepEqual(g[at(1, IMAGE_INPUT_LATENT)].inputs.pixels, [at(0, 'alpha'), 0])
  // 第一段的出图节点被去掉
  assert.equal(g[at(0, 'save')], undefined)
})

test('纯文生图的段放在链尾也能接上：现场改写成图生图', () => {
  const g = merge(steps('game-remove-bg', 'game-icon'), 'panel-1.png')
  // 第 1 段原本是纯文生图，合并时加了 VAEEncode 并把采样器的 latent 换掉
  const latent = g[at(1, IMAGE_INPUT_LATENT)]
  assert.equal(latent.class_type, 'VAEEncode')
  assert.deepEqual(latent.inputs.pixels, [at(0, 'alpha'), 0])
  assert.deepEqual(g[at(1, 'sample')].inputs.latent_image, [at(1, IMAGE_INPUT_LATENT), 0])
  // denoise 降到 1 以下，保留上游的构图
  assert.ok(Number(g[at(1, 'sample')].inputs.denoise) < 1)
  // 只剩最后一段的出图节点
  assert.equal(g[at(0, 'save')], undefined)
  assert.ok(g[at(1, 'save')])
})

test('链的第一段要不要原图：处理类工作流要，纯文生图不要', () => {
  assert.equal(chainNeedsImage(steps('game-remove-bg', 'game-img2img')), true)
  assert.equal(chainNeedsImage(steps('game-img2img')), true)
  assert.equal(chainNeedsImage(steps('game-icon', 'game-remove-bg')), false)
})

test('checkChain：段数、出图节点、节点类型的问题都报出来', () => {
  assert.deepEqual(checkChain(steps('game-img2img', 'game-remove-bg')), [])
  assert.deepEqual(checkChain(steps('game-remove-bg')), [])
  assert.deepEqual(checkChain([]), [t('链里至少要有一个工作流')])

  // 没有 SaveImage 的段接不上下一段
  const noSave = {
    ...wf('game-remove-bg'),
    graph: Object.fromEntries(
      Object.entries(wf('game-remove-bg').graph).filter(([, n]) => n.class_type !== 'SaveImage'),
    ),
  }
  assert.ok(checkChain([{ workflow: noSave }]).some((e) => e.includes('SaveImage')))

  // 节点类型不存在时，前面的段名会带上
  const bad = { ...wf('game-icon'), graph: { a: { class_type: 'NoSuchNode', inputs: {} } } }
  assert.ok(checkChain([{ workflow: bad }]).some((e) => e.startsWith(`${wf('game-icon').name}：`)))
})

test('chainNotes 提醒去背景放在链中间会丢透明底', () => {
  assert.deepEqual(chainNotes(steps('game-img2img', 'game-remove-bg')), [])
  const notes = chainNotes(steps('game-remove-bg', 'game-img2img'))
  assert.equal(notes.length, 1)
  assert.ok(notes[0].includes(wf('game-remove-bg').name))
})

test('链的数据结构：至少一段、最多 6 段、描述默认空', () => {
  const ok = ComfyChain.safeParse({ id: 'c1', name: '去背景再重画', steps: [{ workflowId: 'game-remove-bg' }] })
  assert.equal(ok.success, true)
  assert.equal(ok.data?.steps[0].prompt, '')
  const many = ComfyChain.safeParse({
    id: 'c2',
    name: 'x',
    steps: Array.from({ length: 7 }, () => ({ workflowId: 'game-upscale' })),
  })
  assert.equal(many.success, false)
  assert.equal(ComfyChain.safeParse({ id: 'c3', name: 'x', steps: [] }).success, false)
})

test('三段链：中间两段都不落盘，只有最后一段有 SaveImage', () => {
  const g = merge(steps('game-img2img', 'game-remove-bg', 'game-upscale'), 'panel-1.png')
  const saves = Object.entries(g).filter(([, n]) => n.class_type === 'SaveImage')
  assert.deepEqual(
    saves.map(([id]) => id),
    [at(2, 'save')],
  )
  // 第二段的输出接给第三段的放大节点
  assert.deepEqual(g[at(2, 'scale')].inputs.image, [at(1, 'alpha'), 0])
})

test('合并后的节点图没有断线：所有连线都指向图里存在的节点', () => {
  const combos = [
    ['game-img2img', 'game-remove-bg'],
    ['game-remove-bg', 'game-img2img'],
    ['game-remove-bg', 'game-icon'],
    ['game-img2img', 'game-remove-bg', 'game-upscale'],
  ]
  for (const ids of combos) {
    const g = merge(steps(...ids), 'panel-1.png')
    for (const [id, node] of Object.entries(g))
      for (const [k, v] of Object.entries(node.inputs))
        if (Array.isArray(v) && typeof v[0] === 'string' && typeof v[1] === 'number')
          assert.ok(v[0] in g, `${ids.join('→')}：${id}.${k} 连到了不存在的 ${String(v[0])}`)
    // 合并后仍然能通过单工作流的检查（节点类型、出图节点、占位符）
    assert.deepEqual(checkWorkflow(g), [], ids.join('→'))
  }
})

test('新建链的默认段：优先「纯处理 → 再重画」，凑不出来退回要原图的那一个', () => {
  const game = BUILTIN_WORKFLOWS.filter((w) => workflowInKind(w, 'game'))
  const steps = defaultChainSteps(game)
  // 默认就是用户要的那条：去背景（不吃提示词）→ 图生图（吃提示词）
  assert.deepEqual(
    steps.map((id) => wf(id).id),
    ['game-remove-bg', 'game-img2img'],
  )
  // 只有纯处理类工作流时给一段
  assert.deepEqual(defaultChainSteps([wf('game-remove-bg')]), ['game-remove-bg'])
  // 一个要原图的都没有时退回第一个，不返回空
  assert.deepEqual(defaultChainSteps([wf('game-icon'), wf('game-button')]), ['game-icon'])
  assert.deepEqual(defaultChainSteps([]), [])
})

test('段的工作流被删掉后：报出那一段，后面的下标不错位', () => {
  // 第 2 段的工作流没了：要单独报出来，不能悄悄跳过
  const problems = checkChain([{ workflow: wf('game-remove-bg') }, { workflow: undefined }])
  assert.equal(problems.length, 1)
  assert.ok(problems[0].includes('2'))

  // 失效的段占住下标：第 1 段仍然算「第一段」，不会因为压缩数组把它的锚点检查错位
  const first = checkChain([{ workflow: undefined }, { workflow: wf('game-img2img') }])
  assert.ok(first.some((e) => e.includes('1')))

  // 第一段的工作流没了时不要原图（否则界面会要求选原图）
  assert.equal(chainNeedsImage([{ workflow: undefined }]), false)
  assert.equal(chainNeedsImage([{ workflow: wf('game-remove-bg') }]), true)
})
