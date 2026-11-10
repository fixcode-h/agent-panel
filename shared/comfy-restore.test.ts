/**
 * 画质修复类内置工作流（shared/comfy-restore.ts）：都吃一张输入图、能接进工作流链、模型文件都在清单里。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { checkChain } from './comfy-chain.ts'
import { builtinTemplates } from './comfy-templates.ts'
import { esrganGraph, seedvr2Graph } from './comfy-restore.ts'
import { BUILTIN_WORKFLOWS, IMAGE_PLACEHOLDER, LOCAL_MODELS, localFile, needsInputImage } from './local-image.ts'

const restore = BUILTIN_WORKFLOWS.filter((w) => w.id.startsWith('restore-'))

test('画质修复工作流：四个都在，吃输入图，单独和接在去背景后面都能组链', () => {
  assert.deepEqual(
    restore.map((w) => w.id),
    ['restore-esrgan-2x', 'restore-esrgan-denoise', 'restore-esrgan-4x', 'restore-seedvr2'],
  )
  const removeBg = BUILTIN_WORKFLOWS.find((w) => w.id === 'game-remove-bg')!
  for (const w of restore) {
    assert.equal(needsInputImage(w.graph), true, w.id)
    assert.equal(w.kind, 'both')
    assert.deepEqual(checkChain([{ workflow: w }]), [], w.id)
    assert.deepEqual(checkChain([{ workflow: removeBg }, { workflow: w }]), [], `去背景 → ${w.id}`)
    // 依赖的文件都能在模型清单里找到，缺文件时工作流页能标出来
    assert.ok(w.assets.length >= 1, w.id)
  }
})

test('Real-ESRGAN：4 倍模型放大后按倍数缩回，1 倍就是只去噪', () => {
  const g2 = esrganGraph(IMAGE_PLACEHOLDER, 2)
  assert.equal(g2.model.inputs.model_name, localFile('realesrgan-x4')!.file)
  assert.equal(g2.down.inputs.scale_by, 0.5)
  assert.deepEqual(g2.save.inputs.images, ['down', 0])
  assert.equal(esrganGraph(IMAGE_PLACEHOLDER, 1).down.inputs.scale_by, 0.25)
  const g4 = esrganGraph(IMAGE_PLACEHOLDER, 4)
  assert.equal(g4.down, undefined)
  assert.deepEqual(g4.save.inputs.images, ['up', 0])
})

test('SeedVR2：照官方模板接线，1 步采样，调色参照缩放后的原图', () => {
  const g = seedvr2Graph(IMAGE_PLACEHOLDER)
  assert.equal(g.unet.inputs.unet_name, localFile('seedvr2-3b')!.file)
  assert.equal(g.vae.inputs.vae_name, localFile('seedvr2-vae')!.file)
  assert.deepEqual(g.sample.inputs.positive, ['cond', 0])
  assert.deepEqual(g.sample.inputs.negative, ['cond', 1])
  assert.equal(g.sample.inputs.steps, 1)
  assert.deepEqual(g.post.inputs.original_resized_images, ['resize', 0])
  assert.equal(g.sample.inputs.seed, '{{seed}}')
})

test('处理类模型不出现在文生图模板里', () => {
  const names = builtinTemplates(LOCAL_MODELS).map((t) => t.name)
  for (const id of ['realesrgan', 'seedvr2-3b', 'birefnet']) assert.ok(!names.includes(`builtin:${id}`), id)
})
