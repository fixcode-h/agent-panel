import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  addTemplate,
  canDownload,
  downloadTemplate,
  downloadUrl,
  safeTemplateName,
  templateCatalog,
  templateDetail,
  type TemplateDeps,
} from './comfy-templates.ts'
import { LOCAL_MODELS, type ComfyWorkflow } from '../shared/local-image.ts'

const empty = path.join(tmpdir(), 'agent-panel-no-such-models')

test('模板名和下载地址做校验：不让拼出目录外，也不下非 Hugging Face 的链接', () => {
  assert.equal(safeTemplateName('image_sdxl_simple'), true)
  assert.equal(safeTemplateName('../secret'), false)
  assert.equal(safeTemplateName('a/b'), false)
  assert.equal(
    downloadUrl('https://huggingface.co/Comfy-Org/x/resolve/main/a.safetensors'),
    'https://huggingface.co/Comfy-Org/x/resolve/main/a.safetensors',
  )
  assert.equal(downloadUrl('https://hf-mirror.com/x'), undefined)
  assert.equal(downloadUrl('http://huggingface.co/x'), undefined)
  assert.equal(downloadUrl('https://example.com/a.safetensors'), undefined)
  const base = { dir: 'checkpoints' as const, file: 'a.safetensors', gb: 1 }
  assert.equal(canDownload({ ...base, url: 'https://huggingface.co/x/a.safetensors' }), true)
  assert.equal(canDownload({ ...base, file: '../a.safetensors', url: 'https://huggingface.co/x/a.safetensors' }), false)
  assert.equal(canDownload({ ...base, url: 'https://modelscope.cn/a.safetensors' }), false)
})

test('模板列表：内置模板在前，官方快照离线可浏览', async () => {
  const catalog = await templateCatalog(empty)
  const builtin = catalog.templates.filter((t) => t.source === 'builtin')
  assert.equal(builtin.length, LOCAL_MODELS.filter((m) => m.family !== 'birefnet').length)
  // 每个文生图模型都要有一条自己的内置模板，不能漏掉某个模型（处理类模型不是文生图，走得是工作流和链，没有模板）
  for (const m of LOCAL_MODELS.filter((x) => x.family !== 'birefnet'))
    assert.ok(
      builtin.some((t) => t.name === `builtin:${m.id}`),
      m.id,
    )
  assert.equal(builtin[0].ready, false, '文件不存在时标成缺模型')
  assert.ok(catalog.templates.some((t) => t.source === 'comfy' && t.category === 'Image'))
  assert.equal(catalog.cached, false)
})

test('内置模板详情直接给接口格式的节点图和依赖文件', async () => {
  const detail = await templateDetail('builtin:z-image-turbo', empty)
  assert.ok(detail.graph)
  assert.equal(detail.template.source, 'builtin')
  assert.deepEqual(detail.assets.map((a) => `${a.dir}/${a.file}`).sort(), [
    'diffusion_models/z_image_turbo_bf16.safetensors',
    'text_encoders/qwen_3_4b.safetensors',
    'vae/ae.safetensors',
  ])
  assert.ok(detail.assets.every((a) => a.have === false))
})

const deps = (saved: ComfyWorkflow[] = []): TemplateDeps => ({
  saveWorkflow: async (wf) => {
    saved.push(wf)
  },
  nodeInfo: async () => undefined,
  modelsDir: () => empty,
  download: (files, label, skipped) => ({ files, label, skipped }),
})

test('添加内置模板：复制一份成自己的游戏工作流，依赖跟着带过去', async () => {
  const saved: ComfyWorkflow[] = []
  const wf = await addTemplate('builtin:z-image-turbo', 'game', deps(saved))
  assert.equal(wf.kind, 'game')
  assert.equal(wf.model, 'z-image-turbo')
  assert.ok(wf.assets.length > 0)
  assert.equal(wf.builtin, undefined)
  assert.equal(saved[0].id, wf.id)
})

test('下载模板依赖：只挑缺的、能下的文件，其余记成跳过', async () => {
  const r = await downloadTemplate('builtin:z-image-turbo', deps())
  assert.equal(r.files.length, 3)
  assert.equal(r.skipped, 0)
  assert.ok((r.job as { files: unknown[] }).files.length === 3)
})
