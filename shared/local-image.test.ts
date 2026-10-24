import assert from 'node:assert/strict'
import test from 'node:test'
import { BUILTIN_WORKFLOWS, fillWorkflow, inpaintWorkflow } from './local-image.ts'

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
