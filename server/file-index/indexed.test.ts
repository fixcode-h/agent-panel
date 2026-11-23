// 插件取索引的帮助函数（server/file-index/indexed.ts）：带 ext 去问、只留 root 下的、换成相对路径；通配里看得出扩展名就取出来
import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import type { PluginFileIndex, PluginFiles } from '../plugins/sdk.ts'
import { extsOfGlob, indexedDirs, indexedTree } from './indexed.ts'

test('indexedTree 带 ext 问、换成相对 root；不在索引里给 undefined；extsOfGlob 认 *.h 和 *.{h,hpp}', async () => {
  const root = path.resolve('/proj/Source')
  const asked: unknown[] = []
  const idx = {
    ready: async () => true,
    has: (p: string) => (p === root ? 'dir' : undefined),
    list: async (_d: string, o: unknown) => {
      asked.push(o)
      return {
        files: [path.join(root, 'A', 'x.h'), path.resolve('/proj/SourceOther/y.h')],
        dirs: [path.join(root, 'A'), path.join(root, 'A', 'B')],
      }
    },
  } as unknown as PluginFileIndex
  const files: PluginFiles = { index: async () => idx, touch: () => {} }
  assert.deepEqual(await indexedTree(files, root, { ext: ['h'] }), ['A/x.h'])
  assert.deepEqual(asked[0], { recursive: true, ext: ['h'] })
  assert.deepEqual(await indexedDirs(files, root), ['A', 'A/B'])
  assert.equal(await indexedTree(files, path.resolve('/elsewhere')), undefined)
  assert.equal(await indexedTree(undefined, root), undefined)
  assert.deepEqual(extsOfGlob('Source/**/*.H'), ['h'])
  assert.deepEqual(extsOfGlob('Source/*.{h,hpp}'), ['h', 'hpp'])
  assert.equal(extsOfGlob('Source/**/Enum*'), undefined)
})
