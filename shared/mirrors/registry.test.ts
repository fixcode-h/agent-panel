import assert from 'node:assert/strict'
import test from 'node:test'
import { mirrorUrl, mirrorUrls, toMirror } from './registry.ts'

test('镜像：开着时镜像在前、官方兜底；关着只给官方；完整官方地址能换成镜像', () => {
  assert.deepEqual(mirrorUrls('npm', 'a/-/a-1.tgz', true), [
    'https://registry.npmmirror.com/a/-/a-1.tgz',
    'https://registry.npmjs.org/a/-/a-1.tgz',
  ])
  assert.deepEqual(mirrorUrls('npm', '/a', false), ['https://registry.npmjs.org/a'])
  assert.equal(mirrorUrl('huggingface', 'x/resolve/main/m.onnx', true), 'https://hf-mirror.com/x/resolve/main/m.onnx')
  assert.equal(toMirror('huggingface', 'https://huggingface.co/x/y', true), 'https://hf-mirror.com/x/y')
  assert.equal(toMirror('huggingface', 'https://example.com/x', true), 'https://example.com/x')
  assert.equal(toMirror('huggingface', 'https://huggingface.co/x/y', false), 'https://huggingface.co/x/y')
})
