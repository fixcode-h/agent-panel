import assert from 'node:assert/strict'
import test from 'node:test'
import { DesignImage } from '../shared/design.ts'
import { resetStuckImages } from './design-images.ts'

const img = (id: string, status: DesignImage['status']) =>
  DesignImage.parse({ id, name: id, prompt: '', width: 10, height: 10, status })

test('启动时把上次没出完的图改成失败并写明原因，其余的不动', () => {
  const list = [img('a', 'generating'), img('b', 'pending'), img('c', 'idle'), img('d', 'failed')]
  const out = resetStuckImages(list)
  assert.deepEqual(
    out.map((i) => i.status),
    ['failed', 'failed', 'idle', 'failed'],
  )
  // 原因要写上（中文或英文界面都行）
  assert.ok((out[0].error ?? '').length > 0)
  // 没有卡住的图时原样返回，不复制数组
  const clean = [img('c', 'idle')]
  assert.equal(resetStuckImages(clean), clean)
})

test('撤销删图时带回来的各版：文件还在、名字合法的保留，其余丢掉', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const path = await import('node:path')
  const { tmpdir } = await import('node:os')
  const { restoredVariants } = await import('./design-images.ts')
  const dir = mkdtempSync(path.join(tmpdir(), 'restore-'))
  try {
    writeFileSync(path.join(dir, 'v1.png'), 'x')
    const v = (file: string) => ({ file, width: 10, height: 10, source: 'cli' as const, at: '' })
    const out = await restoredVariants(
      [
        { id: 'gone', variants: [v('v1.png'), v('missing.png'), v('../evil.png')] },
        { id: 'known', variants: [v('v1.png')] },
      ],
      new Map([['known', {}]]),
      dir,
    )
    assert.deepEqual(
      out.get('gone')!.map((x) => x.file),
      ['v1.png'],
    )
    assert.equal(out.has('known'), false, '服务端本来就有的图不在这里处理')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('templateCrop：模板先缩放到设计稿尺寸，再按设计稿坐标裁出切图那一块；落在图外时不裁', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const path = await import('node:path')
  const { tmpdir } = await import('node:os')
  const { encodePng, decodePng } = await import('./image.ts')
  const { templateCrop } = await import('./design-images.ts')
  const dir = mkdtempSync(path.join(tmpdir(), 'crop-'))
  try {
    // 模板是设计稿的一半大小（960×540）：左上 100×100 的设计稿区域是红色
    const w = 960
    const h = 540
    const data = new Uint8Array(w * h * 4)
    for (let i = 0; i < w * h; i++) {
      const red = i % w < 50 && Math.floor(i / w) < 50
      data.set(red ? [255, 0, 0, 255] : [0, 0, 255, 255], i * 4)
    }
    const file = path.join(dir, 'tpl.png')
    writeFileSync(file, encodePng({ width: w, height: h, data }))
    const out = decodePng((await templateCrop(file, { X: 1920, Y: 1080 }, { x: 20, y: 20, w: 60, h: 40 }))!)!
    assert.deepEqual([out.width, out.height], [60, 40])
    assert.deepEqual([...out.data.slice(0, 3)], [255, 0, 0], '裁到的是设计稿坐标里的那一块')
    assert.equal(await templateCrop(file, { X: 1920, Y: 1080 }, { x: 1919, y: 1079, w: 50, h: 50 }), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
