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
