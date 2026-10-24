import assert from 'node:assert/strict'
import test from 'node:test'
import { tmpdir } from 'node:os'
import { MAX_TOOL_WIDGETS, emptyRoot, type Design } from '../shared/design.ts'
import { designMcpApi, openDesignSession, type DesignFiles } from './design-mcp.ts'

const design = (): Design => ({
  id: 'd1',
  projectId: 'p1',
  kind: 'game',
  title: 'T',
  designSize: { X: 1920, Y: 1080 },
  style: '',
  root: emptyRoot('game'),
  components: [],
  images: [],
  annotations: [],
  messages: [],
  rev: 0,
  concept: {
    images: [
      {
        id: 'c1_1',
        file: 'a.png',
        width: 1920,
        height: 1080,
        prompt: 'p',
        negative: '',
        round: 1,
        source: 'cli',
        at: '',
      },
    ],
    selected: 'c1_1',
    approved: '',
  },
  createdAt: '',
  updatedAt: '',
})

/** 开一个会话，返回调工具的函数 */
function open(opts: { conceptOnly?: boolean } = {}, files: Partial<DesignFiles> = {}) {
  const m = openDesignSession(
    design(),
    () => {},
    { dir: tmpdir(), attachments: [], imagePath: () => undefined, conceptPath: () => undefined, ...files },
    opts,
  )
  const token = m.url.split('/').pop()!
  const app = designMcpApi()
  let id = 0
  const call = async (name: string, args: unknown) => {
    const r = await app.request(`/design/${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
    })
    const j = (await r.json()) as { result: { content: { text: string }[]; isError?: boolean } }
    return { text: j.result.content[0].text, error: !!j.result.isError }
  }
  return { call, session: m.session, close: m.close }
}

const text = (name: string) => ({ Type: 'TextBlock', Name: name, Text: name })

test('一次提交太多控件会被退回，让 AI 分几次提交', async () => {
  const { call, session, close } = open()
  const many = Array.from({ length: MAX_TOOL_WIDGETS }, (_, i) => text(`T${i}`))
  const r = await call('replace_widget', {
    name: 'RootCanvas',
    widget: { Type: 'CanvasPanel', Name: 'RootCanvas', Children: many },
  })
  assert.ok(r.error)
  assert.match(r.text, /一次最多 30 个控件/)
  assert.equal(session.applied, 0, '退回的不应用')
  // 骨架加上分块填充就可以
  assert.ok(
    !(
      await call('replace_widget', {
        name: 'RootCanvas',
        widget: { Type: 'CanvasPanel', Name: 'RootCanvas', Children: [{ Type: 'VerticalBox', Name: 'Box' }] },
      })
    ).error,
  )
  assert.ok(!(await call('add_widgets', { items: many.slice(0, 10).map((w) => ({ parent: 'Box', widget: w })) })).error)
  close()
})

test('先出原画阶段不能搭界面，只记下要出的原画', async () => {
  const { call, session, close } = open({ conceptOnly: true })
  const r = await call('add_widgets', { items: [{ parent: 'RootCanvas', widget: text('A') }] })
  assert.ok(r.error)
  assert.match(r.text, /先出原画/)
  assert.ok((await call('generate_concepts', { prompt: 'a dark fantasy inventory', base: 'nope' })).error, '没有的原画')
  const ok = await call('generate_concepts', {
    prompt: 'a dark fantasy inventory',
    negative: 'blurry',
    count: 9,
    base: 'c1_1',
  })
  assert.ok(!ok.error)
  assert.deepEqual(session.concepts, [
    { prompt: 'a dark fantasy inventory', negative: 'blurry', count: 4, base: 'c1_1' },
  ])
  close()
})

test('复制、包裹、查找控件，改错了能撤回', async () => {
  const { call, session, close } = open()
  await call('add_widgets', {
    items: [{ parent: 'RootCanvas', widget: { Type: 'VerticalBox', Name: 'List', Children: [text('Row')] } }],
  })
  assert.ok(!(await call('duplicate_widgets', { items: [{ name: 'Row' }, { name: 'Row', to: 'Row_Last' }] })).error)
  const names = () => session.state.root.Children![0].Children!.map((w) => w.Name)
  assert.deepEqual(names(), ['Row', 'Row_Last', 'Row_1'])
  assert.ok(!(await call('wrap_widget', { name: 'List', type: 'SizeBox', as: 'ListSize' })).error)
  assert.equal(session.state.root.Children![0].Name, 'ListSize')
  assert.match((await call('find_widgets', { query: 'row_l' })).text, /Row_Last（TextBlock，「Row」，在 List 里）/)
  assert.ok((await call('wrap_widget', { name: 'List', type: 'TextBlock' })).error, '只能用面板包裹')
  await call('undo', {})
  assert.equal(session.state.root.Children![0].Name, 'List', '撤回了包裹')
  await call('undo', { steps: 5 })
  assert.equal(session.state.root.Children?.length ?? 0, 0, '撤回到这一轮开始')
  close()
})

test('截图交给页面画，返回文件和控件位置，提醒跑出画面的控件', async () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex')
  const { call, session, close } = open(
    {},
    {
      capture: async (_s, target) => {
        assert.equal(target, '')
        return {
          png,
          rects: [
            { name: 'Panel', type: 'Image', x: 10, y: 20, w: 300, h: 200 },
            { name: 'Far', type: 'Image', x: 1900, y: 0, w: 200, h: 50 },
          ],
        }
      },
    },
  )
  const r = await call('screenshot', {})
  assert.ok(!r.error, r.text)
  assert.match(r.text, /已截图 .*screenshot-1\.png/)
  assert.match(r.text, /跑出画面的控件：Far/)
  assert.match(r.text, /Panel（Image）10,20 300×200/)
  assert.equal(session.shots.length, 1)
  // 页面没打开时把准确原因原样告诉 AI，不追加和原因无关的提示
  const off = open({}, { capture: async () => Promise.reject(new Error('截图失败：设计页面没有打开')) })
  const err = await off.call('screenshot', {})
  assert.ok(err.error)
  assert.equal(err.text, '截图失败：设计页面没有打开')
  off.close()
  close()
})

test('画布位置的简写：大小写、别名、写在控件上都认，只改一部分时其他的保留', async () => {
  const { call, session, close } = open()
  const slot = (name: string) => {
    let hit: any
    const find = (w: any) => (w.Name === name ? (hit = w) : (w.Children ?? []).forEach(find))
    find(session.state.root)
    return hit.Slot.LayoutData
  }
  const r = await call('add_widgets', {
    items: [
      {
        parent: 'RootCanvas',
        widget: { Type: 'Image', Name: 'A', Slot: { anchor: 'top-left', x: 40, y: 32, w: 320, h: 72 } },
      },
      {
        parent: 'RootCanvas',
        widget: {
          Type: 'Image',
          Name: 'B',
          Slot: { Anchor: 'bottom-right', X: -24, Y: '-24', Width: 200, Height: '60px' },
        },
      },
      { parent: 'RootCanvas', widget: { Type: 'Image', Name: 'C', x: 10, y: 20, w: 30, h: 40 } },
      { parent: 'RootCanvas', widget: { Type: 'Image', Name: 'D', Slot: { pos: [5, 6], size: [70, 80] } } },
    ],
  })
  assert.ok(!r.error, r.text)
  assert.deepEqual(slot('A').Offsets, { Left: 40, Top: 32, Right: 320, Bottom: 72 })
  assert.deepEqual(slot('B').Offsets, { Left: -24, Top: -24, Right: 200, Bottom: 60 })
  assert.deepEqual(slot('B').Anchors.Minimum, { X: 1, Y: 1 })
  assert.deepEqual(slot('C').Offsets, { Left: 10, Top: 20, Right: 30, Bottom: 40 })
  assert.deepEqual(slot('D').Offsets, { Left: 5, Top: 6, Right: 70, Bottom: 80 })
  // 有的模型把对象参数写成 JSON 字符串
  const r2 = await call('add_widgets', {
    items: JSON.stringify([
      { parent: 'RootCanvas', widget: { Type: 'Image', Name: 'E', Slot: JSON.stringify({ x: 1, y: 2, w: 3, h: 4 }) } },
    ]),
  })
  assert.ok(!r2.error, r2.text)
  assert.deepEqual(slot('E').Offsets, { Left: 1, Top: 2, Right: 3, Bottom: 4 })
  // 只挪位置：锚点和大小不变，不会变回 100×40
  assert.ok(!(await call('update_widgets', { items: [{ name: 'B', slot: { x: -50, y: -60 } }] })).error)
  assert.deepEqual(slot('B').Offsets, { Left: -50, Top: -60, Right: 200, Bottom: 60 })
  assert.deepEqual(slot('B').Anchors.Minimum, { X: 1, Y: 1 })
  // 只改大小：位置不变
  assert.ok(!(await call('update_widgets', { items: [{ name: 'A', slot: { w: 500 } }] })).error)
  assert.deepEqual(slot('A').Offsets, { Left: 40, Top: 32, Right: 500, Bottom: 72 })
  close()
})
