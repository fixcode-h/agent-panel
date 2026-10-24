import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BUILTIN_WORKFLOWS,
  comfyFilenamePrefix,
  comfyImportFile,
  comfyQueueEntry,
  comfyQueueLists,
  comfySavePrefix,
  fillWorkflow,
  importableWorkflow,
  inpaintWorkflow,
  markSavePrefix,
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
