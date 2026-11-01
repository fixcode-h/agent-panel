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
  assert.match(out[0].error ?? '', /重启/)
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
