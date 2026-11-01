import assert from 'node:assert/strict'
import test from 'node:test'
import { treeChanges } from './design-diff.ts'
import type { Widget } from './umg.ts'

const w = (id: string, Name: string, extra: Partial<Widget> = {}): Widget => ({
  id,
  Type: 'Image',
  Name,
  Properties: {},
  ...extra,
})

test('treeChanges：按 id 找出新加、删掉、改名和改了哪些属性 / 位置的控件', () => {
  const before = {
    root: w('r', 'Root', {
      Type: 'CanvasPanel',
      Children: [w('a', 'A', { Properties: { RenderOpacity: 1 } }), w('b', 'B'), w('c', 'C')],
    }),
    components: [],
  }
  const after = {
    root: w('r', 'Root', {
      Type: 'CanvasPanel',
      Children: [
        w('a', 'A', { Properties: { RenderOpacity: 0.5 }, Slot: { LayoutData: {} } }),
        w('c', 'Close'),
        w('d', 'New'),
      ],
    }),
    components: [{ Name: 'WBP_X', DesignSize: { X: 1, Y: 1 }, Root: w('x', 'XRoot') }],
  }
  const { list, total } = treeChanges(before, after)
  const brief = list.map(
    (c) => `${c.kind}:${c.tree}:${c.name}${c.keys ? `[${c.keys.join(',')}]` : ''}${c.from ? `<${c.from}` : ''}`,
  )
  assert.deepEqual(brief.sort(), [
    'add::New',
    'add:WBP_X:XRoot',
    'change::A[RenderOpacity,Slot]',
    'remove::B',
    'rename::Close<C',
  ])
  assert.equal(total, 5)
})
