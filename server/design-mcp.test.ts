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
function open(opts: { conceptOnly?: boolean } = {}, files: Partial<DesignFiles> = {}, d: Design = design()) {
  const m = openDesignSession(
    d,
    () => {},
    { dir: tmpdir(), attachments: [], imagePath: () => undefined, conceptPath: () => undefined, ...files },
    opts,
  )
  const token = m.url.split('/').pop()!
  const app = designMcpApi()
  let id = 0
  const post = async (method: string, params: unknown) => {
    const r = await app.request(`/design/${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    })
    return r.json()
  }
  const call = async (name: string, args: unknown) => {
    const j = (await post('tools/call', { name, arguments: args })) as {
      result: { content: { text: string }[]; isError?: boolean }
    }
    return { text: j.result.content[0].text, error: !!j.result.isError }
  }
  const list = async () => {
    const j = (await post('tools/list', {})) as { result: { tools: { name: string; description: string }[] } }
    return j.result.tools
  }
  return { call, list, session: m.session, close: m.close }
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

test('四条硬规则写在工具说明里，设计 Agent 每轮都看得到', async () => {
  const { list, close } = open()
  const tools = await list()
  const desc = (name: string) => tools.find((t) => t.name === name)?.description ?? ''
  // 截图失败：只问一次、不重复调用、视觉结论改成待验证
  assert.match(desc('screenshot'), /只向用户说一次「请打开这个设计页」/)
  assert.match(desc('screenshot'), /本轮不要再调 screenshot/)
  assert.match(desc('screenshot'), /待验证项/)
  assert.match(desc('view_image'), /source "screenshot:<第几张>"/)
  assert.match(desc('view_image'), /放大确认一次/)
  // 出图状态：读一两次、生成中怎么汇报、失败只重试一次
  assert.match(desc('get_design'), /只调它一两次/)
  assert.match(desc('get_design'), /背景在出图，我先做其他项，本轮验收不含背景/)
  assert.match(desc('get_design'), /只重试一次/)
  assert.match(desc('get_design'), /new 为 true 的是本轮 add_images 刚列或重出的图/)
  assert.match(desc('get_design'), /这一轮结束才出图，本轮不要等它的状态/)
  assert.match(desc('add_images'), /2048×1152/)
  assert.match(desc('add_images'), /≤ 2048/)
  assert.match(desc('add_images'), /去掉「高分辨率」/)
  // 引用与传参
  assert.match(desc('inspect_image'), /image:<id>、concept:<id>、screenshot:<n>/)
  assert.match(desc('update_widgets'), /不要写成字符串/)
  assert.match(desc('add_images'), /不要写成字符串/)
  // 改完回读，check 不是完成条件
  assert.match(desc('update_widgets'), /回读/)
  assert.match(desc('update_widgets'), /上一轮没生效/)
  assert.match(desc('get_tree'), /回读被改控件/)
  assert.match(desc('check'), /不是完成条件/)
  assert.match(desc('check'), /改完后的全屏截图/)
  close()
})

test('get_design 返回图片的生成状态和失败原因，供 AI 判断要不要等或重出', async () => {
  const d = design()
  d.images = [
    {
      id: 'bg',
      name: '背景',
      prompt: 'p',
      negative: '',
      width: 1920,
      height: 1080,
      transparent: false,
      variants: [],
      selected: 0,
      status: 'failed',
      error: '出图失败',
    },
    {
      id: 'icon',
      name: '图标',
      prompt: 'p',
      negative: '',
      width: 96,
      height: 96,
      transparent: true,
      variants: [],
      selected: 0,
      status: 'generating',
    },
  ]
  const { call, close } = open({}, {}, d)
  const info = JSON.parse((await call('get_design', {})).text) as {
    images: { id: string; generated: boolean; status: string; error?: string }[]
  }
  assert.equal(info.images[0].status, 'failed')
  assert.equal(info.images[0].error, '出图失败')
  assert.equal(info.images[1].status, 'generating')
  assert.equal(info.images[1].error, undefined)
  close()
})

test('本轮 add_images 的图在 get_design 里是 pending、new，不会拿旧的 failed 当重试结果', async () => {
  const d = design()
  d.images = [
    {
      id: 'bg',
      name: '旧背景',
      prompt: '旧描述',
      negative: '',
      width: 2048,
      height: 1152,
      transparent: false,
      variants: [],
      selected: 0,
      status: 'failed',
      error: '上一轮失败',
    },
  ]
  const { call, close } = open({}, {}, d)
  const before = JSON.parse((await call('get_design', {})).text) as {
    images: { id: string; status: string; size: string }[]
  }
  assert.equal(before.images[0].status, 'failed', '这一轮还没重出时看到的是上一次的结果')
  assert.equal(before.images[0].size, '2048x1152')
  await call('add_images', {
    images: [
      { id: 'bg', name: '新背景', prompt: '新描述', negative: '', width: 1920, height: 1080, transparent: false },
    ],
  })
  await call('add_images', { images: [{ id: 'icon', name: '图标', prompt: '新描述', width: 96, height: 96 }] })
  const after = JSON.parse((await call('get_design', {})).text) as {
    images: {
      id: string
      name: string
      status: string
      new?: boolean
      error?: string
      size: string
      generated: boolean
    }[]
    newImages: string[]
  }
  const bg = after.images.find((i) => i.id === 'bg')!
  assert.equal(bg.status, 'pending', '本轮重出的图不再显示上一次的 failed')
  assert.equal(bg.new, true)
  assert.equal(bg.error, undefined)
  assert.equal(bg.name, '新背景', '名字用本轮新写的')
  assert.equal(bg.size, '1920x1080', '尺寸用本轮新写的，不是上一次的 2048x1152')
  assert.equal(bg.generated, false, '重出的图还没生成，画布上还是上一版')
  const icon = after.images.find((i) => i.id === 'icon')!
  assert.equal(icon.status, 'pending')
  assert.equal(icon.new, true)
  assert.equal(icon.generated, false)
  assert.deepEqual(after.newImages, ['bg', 'icon'])
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

test('改控件的结果里直接列出位置变了的控件，不用截图回读', async () => {
  const { call, close } = open()
  const add = await call('add_widgets', {
    items: [
      {
        parent: 'RootCanvas',
        widget: {
          Type: 'Image',
          Name: 'Panel',
          Slot: { anchor: 'center', x: 0, y: 0, w: 400, h: 200 },
          Brush: { ImageSize: { X: 400, Y: 200 } },
        },
      },
    ],
  })
  assert.ok(!add.error, add.text)
  // 居中锚点 + 居中对齐：左上角在 (1920-400)/2, (1080-200)/2
  assert.match(add.text, /位置或大小变了的控件/)
  assert.match(add.text, /Panel（Image）760,440 400×200/)
  const moved = await call('update_widgets', { items: [{ name: 'Panel', slot: { x: 100 } }] })
  assert.match(moved.text, /Panel（Image）860,440 400×200/)
  // 只改不影响位置的属性：不列
  const tint = await call('update_widgets', { items: [{ name: 'Panel', properties: { RenderOpacity: 0.5 } }] })
  assert.doesNotMatch(tint.text, /位置或大小变了/)
  // 跑出画面的直接点名
  const off = await call('update_widgets', { items: [{ name: 'Panel', slot: { x: 1000 } }] })
  assert.match(off.text, /跑出画面：Panel/)
  close()
})

test('get_layout 不开页面算出整棵树的位置，文字标估算；页面没开时截图退回位置表', async () => {
  const { call, close } = open({}, { capture: async () => Promise.reject(new Error('截图失败：设计页面没有打开')) })
  await call('add_widgets', {
    items: [
      {
        parent: 'RootCanvas',
        widget: { Type: 'TextBlock', Name: 'Title', Text: '背包', Slot: { x: 40, y: 32, w: 0, h: 0 } },
      },
      { parent: 'RootCanvas', widget: { Type: 'Image', Name: 'Icon', Slot: { x: 10, y: 10, w: 64, h: 64 } } },
    ],
  })
  await call('update_widgets', { items: [{ name: 'Title', slot: { bAutoSize: true } }] })
  const all = await call('get_layout', {})
  assert.ok(!all.error, all.text)
  assert.match(all.text, /Icon（Image）10,10 64×64/)
  assert.match(all.text, /Title（TextBlock）≈40,32/)
  const one = await call('get_layout', { names: ['Icon', 'Nope'] })
  assert.doesNotMatch(one.text, /Title/)
  assert.match(one.text, /没找到.*Nope/)
  const shot = await call('screenshot', {})
  assert.ok(shot.error)
  assert.match(shot.text, /^截图失败：设计页面没有打开/)
  assert.match(shot.text, /Icon（Image）10,10 64×64/)
  close()
})

test('网页设计不算位置，交给截图', async () => {
  const d = design()
  d.kind = 'web'
  d.root = emptyRoot('web')
  const { call, close } = open({}, {}, d)
  const r = await call('get_layout', {})
  assert.ok(r.error)
  assert.match(r.text, /screenshot/)
  close()
})

test('画布插槽的部分更新只改写到的字段：单轴拉伸、对齐点、锚点都保留', async () => {
  const { call, session, close } = open()
  const slotOf = (name: string) => {
    let hit: any
    const walk = (w: any) => {
      if (w.Name === name) hit = w
      for (const c of w.Children ?? []) walk(c)
    }
    walk(session.state.root)
    return hit.Slot.LayoutData
  }
  const add = (widget: object) => call('add_widgets', { items: [{ parent: 'RootCanvas', widget }] })
  // 顶栏：只横向拉伸，高 80；只改高度后仍然只横向拉伸
  assert.ok(
    !(await add({ Type: 'Border', Name: 'TopBar', Slot: { anchor: 'top-stretch', y: 0, h: 80, margin: [0, 0, 0, 0] } }))
      .error,
  )
  assert.deepEqual(slotOf('TopBar').Anchors, { Minimum: { X: 0, Y: 0 }, Maximum: { X: 1, Y: 0 } })
  await call('update_widgets', { items: [{ name: 'TopBar', slot: { h: 120 } }] })
  assert.deepEqual(slotOf('TopBar').Anchors, { Minimum: { X: 0, Y: 0 }, Maximum: { X: 1, Y: 0 } })
  assert.equal(slotOf('TopBar').Offsets.Bottom, 120)
  // 铺满的控件改上边距：生效，不再被吞掉
  await add({ Type: 'Border', Name: 'Bg', Slot: { anchor: 'stretch', margin: [10, 10, 10, 10] } })
  await call('update_widgets', { items: [{ name: 'Bg', slot: { y: 50 } }] })
  assert.deepEqual(slotOf('Bg').Offsets, { Left: 10, Top: 50, Right: 10, Bottom: 10 })
  // 拉伸方向写宽度：报错说清楚，不悄悄变成 100×40
  const bad = await call('update_widgets', { items: [{ name: 'Bg', slot: { w: 300 } }] })
  assert.ok(bad.error)
  assert.match(bad.text, /拉伸/)
  // 对齐点 0.5 的控件只改宽度：对齐点不动
  await add({ Type: 'Image', Name: 'Mid', Slot: { anchor: 'center', w: 200, h: 100 } })
  await call('update_widgets', { items: [{ name: 'Mid', slot: { w: 300 } }] })
  assert.deepEqual(slotOf('Mid').Alignment, { X: 0.5, Y: 0.5 })
  assert.equal(slotOf('Mid').Offsets.Right, 300)
  // top-center 这类写法都认；认不出的报错
  await add({ Type: 'Image', Name: 'Tc', Slot: { anchor: 'top-center', y: 20, w: 50, h: 50 } })
  assert.deepEqual(slotOf('Tc').Anchors.Minimum, { X: 0.5, Y: 0 })
  const typo = await add({ Type: 'Image', Name: 'Typo', Slot: { anchor: 'upper-left' } })
  assert.ok(typo.error)
  assert.match(typo.text, /认不出「upper」/)
  // 只换锚点：贴到新锚点上，宽高沿用
  await call('update_widgets', { items: [{ name: 'Tc', slot: { anchor: 'bottom-right' } }] })
  assert.deepEqual(slotOf('Tc').Offsets, { Left: 0, Top: 0, Right: 50, Bottom: 50 })
  assert.deepEqual(slotOf('Tc').Alignment, { X: 1, Y: 1 })
  close()
})

test('插槽写错当场报错；子控件尺寸存成数字；replace 的半个插槽和原来的合并', async () => {
  const { call, session, close } = open()
  await call('add_widgets', {
    items: [
      { parent: 'RootCanvas', widget: { Type: 'VerticalBox', Name: 'Col', Slot: { x: 0, y: 0, w: 300, h: 300 } } },
    ],
  })
  const wh = await call('add_widgets', {
    items: [{ parent: 'Col', widget: { Type: 'Image', Name: 'A', Slot: { w: 200, h: 40 } } }],
  })
  assert.ok(wh.error)
  assert.match(wh.text, /没有位置和宽高/)
  const mid = await call('add_widgets', {
    items: [{ parent: 'Col', widget: { Type: 'Image', Name: 'B', Slot: { h: 'middle', v: 'centre', fill: 'auto' } } }],
  })
  assert.ok(!mid.error, mid.text)
  const b = session.state.root.Children!.find((w) => w.Name === 'Col')!.Children![0]
  assert.deepEqual(
    [b.Slot!.HorizontalAlignment, b.Slot!.VerticalAlignment, b.Slot!.Size.SizeRule],
    ['HAlign_Center', 'VAlign_Center', 'Automatic'],
  )
  const wrong = await call('update_widgets', { items: [{ name: 'B', slot: { h: 'leftish' } }] })
  assert.ok(wrong.error)
  await call('create_components', {
    items: [{ name: 'WBP_X', size: { X: 64, Y: 64 }, root: { Type: 'Overlay', Name: 'R' } }],
  })
  await call('resize_components', { items: [{ name: 'WBP_X', size: { X: '200', Y: '100' } }] })
  assert.deepEqual(session.state.components[0].DesignSize, { X: 200, Y: 100 })
  await call('replace_widget', {
    items: [{ name: 'Col', widget: { Type: 'HorizontalBox', Name: 'Row', Slot: { x: 20 } } }],
  })
  const row = session.state.root.Children!.find((w) => w.Name === 'Row')!
  assert.deepEqual(row.Slot!.LayoutData.Offsets, { Left: 20, Top: 0, Right: 300, Bottom: 300 })
  close()
})

test('undo 也撤回 set_design 改的风格和尺寸，不再撤掉更早的控件修改', async () => {
  const { call, session, close } = open()
  await call('add_widgets', {
    items: [{ parent: 'RootCanvas', widget: { Type: 'Image', Name: 'Keep', Slot: { x: 0, y: 0, w: 10, h: 10 } } }],
  })
  await call('set_design', { style: 'pixel art', designSize: { X: 1280, Y: 720 } })
  const r = await call('undo', {})
  assert.ok(!r.error, r.text)
  assert.equal(session.style, undefined)
  assert.equal(session.designSize, undefined)
  assert.ok(
    session.state.root.Children!.some((w) => w.Name === 'Keep'),
    '更早加的控件还在',
  )
  close()
})

test('违反放法、子树重名、名字格式当场报错；删控件时清掉引用它的动画轨道并说明', async () => {
  const { call, session, close } = open()
  await call('add_widgets', {
    items: [
      {
        parent: 'RootCanvas',
        widget: {
          Type: 'Border',
          Name: 'Box',
          Slot: { x: 0, y: 0, w: 100, h: 100 },
          Children: [{ Type: 'Image', Name: 'Pic' }],
        },
      },
    ],
  })
  const one = await call('add_widgets', { items: [{ parent: 'Box', widget: { Type: 'Image', Name: 'Second' } }] })
  assert.ok(one.error)
  assert.match(one.text, /只能放一个子控件/)
  const dup = await call('add_widgets', {
    items: [
      {
        parent: 'RootCanvas',
        widget: {
          Type: 'VerticalBox',
          Name: 'Col',
          Slot: { x: 0, y: 200, w: 100, h: 100 },
          Children: [
            { Type: 'TextBlock', Name: 'Label', Text: 'a' },
            { Type: 'TextBlock', Name: 'Label', Text: 'b' },
          ],
        },
      },
    ],
  })
  assert.ok(dup.error)
  assert.match(dup.text, /重名的：Label/)
  const badName = await call('create_components', {
    items: [{ name: 'Slot Item', size: { X: 10, Y: 10 }, root: { Type: 'Overlay', Name: 'R' } }],
  })
  assert.ok(badName.error)
  await call('add_animations', { items: [{ name: 'Anim_Pop', presets: [{ preset: 'pop-in', widgets: ['Pic'] }] }] })
  assert.equal(session.state.animations?.length, 1)
  const rm = await call('remove_widgets', { names: ['Box'] })
  assert.ok(!rm.error, rm.text)
  assert.match(rm.text, /动画 Anim_Pop/)
  assert.equal(session.state.animations?.length, 0)
  close()
})

test('inspect_image 坐标写错时返回说明，不再 500；region 夹到图片范围里', async () => {
  const { encodePng } = await import('./image.ts')
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const path = await import('node:path')
  const dir = mkdtempSync(path.join(tmpdir(), 'inspect-'))
  const file = path.join(dir, 'a.png')
  writeFileSync(file, encodePng({ width: 20, height: 20, data: Buffer.alloc(20 * 20 * 4, 255) }))
  const { call, close } = open({}, { attachments: [{ name: 'a.png', path: file }] })
  const bad = await call('inspect_image', { source: 'attachment:1', points: [{ x: '10px' }] })
  assert.ok(bad.error)
  assert.match(bad.text, /points 的第 1 个点/)
  const out = await call('inspect_image', { source: 'attachment:1', region: { x: 15, y: 15, w: 30, h: 30 } })
  assert.ok(!out.error, out.text)
  assert.deepEqual(JSON.parse(out.text).region, { x: 15, y: 15, w: 5, h: 5 })
  close()
})

test('set_data 不合法时整批不改，并告诉 AI 是哪个集合、哪一行、哪个字段', async () => {
  const { call, session, close } = open()
  const r = await call('set_data', {
    sets: [{ name: 'Items', fields: [{ key: 'count', type: 'number' }], rows: [{ count: 1 }, { count: [2] }] }],
  })
  assert.ok(r.error)
  assert.match(r.text, /第 1 个集合（Items） 第 2 行 的 count/)
  assert.equal(session.data, undefined, '有一项不合法就都不改')
  const ok = await call('set_data', { sets: [{ name: 'Items', fields: [{ key: 'count' }], rows: [{ count: 1 }] }] })
  assert.ok(!ok.error)
  assert.equal((session.data as Design['data'])?.sets[0]?.rows.length, 1)
  close()
})
