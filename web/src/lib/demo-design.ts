/**
 * 在线演示里的 UI 设计：设计存在内存里（图片是 data URL，太大放不进 localStorage），
 * AI 对话按关键词套用示例界面（主菜单 / 背包），图片用 canvas 画出示意图，模拟「生成」的过程。
 */
const randomId = () => crypto.randomUUID()
import {
  DesignImage,
  emptyRoot,
  importComponent,
  type Design,
  type DesignMeta,
  type DesignProject,
  type ImageSource,
} from '@shared/design'
import { normalizeTree, type Widget } from '@shared/umg'

type Job = NonNullable<Full['job']>
type Full = Design & { job: import('@shared/design').DesignJob | null }

const designs = new Map<string, Full>()
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const now = () => new Date().toISOString()
const fail = (msg: string): never => {
  throw new Error(msg)
}

// ---- 示意图：按图片 id 里的关键词画 ----

function draw(id: string, w: number, h: number): string {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d')!
  const gold = '#d9b25f'
  const rr = (x: number, y: number, ww: number, hh: number, r: number) => {
    g.beginPath()
    g.roundRect(x, y, ww, hh, r)
  }
  if (/bg/.test(id)) {
    const grd = g.createRadialGradient(w / 2, h * 0.45, 50, w / 2, h / 2, w * 0.7)
    grd.addColorStop(0, '#3b2a4f')
    grd.addColorStop(0.55, '#1a1424')
    grd.addColorStop(1, '#07060a')
    g.fillStyle = grd
    g.fillRect(0, 0, w, h)
    for (let i = 0; i < 160; i++) {
      g.fillStyle = `rgba(255,${200 + Math.random() * 55},${150 + Math.random() * 80},${Math.random() * 0.6})`
      g.beginPath()
      g.arc(Math.random() * w, Math.random() * h, Math.random() * 2.2, 0, 7)
      g.fill()
    }
    // 远山
    g.fillStyle = '#0d0a13'
    g.beginPath()
    g.moveTo(0, h)
    for (let x = 0; x <= w; x += w / 12) g.lineTo(x, h * 0.72 - Math.sin(x / 140) * 60 - Math.random() * 50)
    g.lineTo(w, h)
    g.fill()
  } else if (/highlight|glow/.test(id)) {
    g.shadowColor = '#ffcf6b'
    g.shadowBlur = 18
    g.strokeStyle = '#ffd98a'
    g.lineWidth = 4
    rr(14, 14, w - 28, h - 28, 14)
    g.stroke()
    g.shadowBlur = 0
    g.strokeStyle = 'rgba(255,240,200,0.9)'
    g.lineWidth = 1.5
    rr(14, 14, w - 28, h - 28, 14)
    g.stroke()
  } else if (/title/.test(id)) {
    const grd = g.createLinearGradient(0, 0, 0, h)
    grd.addColorStop(0, '#2b2236')
    grd.addColorStop(1, '#120e18')
    g.fillStyle = grd
    g.beginPath()
    g.moveTo(40, h / 2)
    g.lineTo(90, 16)
    g.lineTo(w - 90, 16)
    g.lineTo(w - 40, h / 2)
    g.lineTo(w - 90, h - 16)
    g.lineTo(90, h - 16)
    g.closePath()
    g.fill()
    g.strokeStyle = gold
    g.lineWidth = 3
    g.stroke()
    g.fillStyle = gold
    for (const x of [24, w - 24]) {
      g.beginPath()
      g.moveTo(x, h / 2 - 14)
      g.lineTo(x + (x < w / 2 ? 14 : -14), h / 2)
      g.lineTo(x, h / 2 + 14)
      g.lineTo(x - (x < w / 2 ? 14 : -14), h / 2)
      g.fill()
    }
  } else if (/btn|button/.test(id)) {
    const hover = /hover/.test(id)
    const press = /press/.test(id)
    const grd = g.createLinearGradient(0, 0, 0, h)
    grd.addColorStop(0, press ? '#2a1f12' : hover ? '#6b4a22' : '#4a3520')
    grd.addColorStop(1, press ? '#3a2a16' : hover ? '#3d2a14' : '#2a1d10')
    rr(4, 4, w - 8, h - 8, 12)
    g.fillStyle = grd
    g.fill()
    g.strokeStyle = hover ? '#ffd98a' : gold
    g.lineWidth = 3
    g.stroke()
    rr(10, 10, w - 20, h - 20, 8)
    g.strokeStyle = 'rgba(217,178,95,0.35)'
    g.lineWidth = 1.5
    g.stroke()
  } else if (/slot|cell/.test(id)) {
    rr(3, 3, w - 6, h - 6, 8)
    g.fillStyle = 'rgba(20,16,26,0.92)'
    g.fill()
    g.strokeStyle = '#6d5a3a'
    g.lineWidth = 2.5
    g.stroke()
  } else if (/panel|frame/.test(id)) {
    rr(6, 6, w - 12, h - 12, 18)
    g.fillStyle = 'rgba(18,14,24,0.94)'
    g.fill()
    g.strokeStyle = gold
    g.lineWidth = 4
    g.stroke()
    rr(16, 16, w - 32, h - 32, 10)
    g.strokeStyle = 'rgba(217,178,95,0.3)'
    g.lineWidth = 1.5
    g.stroke()
  } else if (/fill/.test(id)) {
    const grd = g.createLinearGradient(0, 0, 0, h)
    grd.addColorStop(0, '#ff6b5a')
    grd.addColorStop(1, '#a3241a')
    rr(0, 0, w, h, h / 2)
    g.fillStyle = grd
    g.fill()
  } else {
    // 图标：一颗宝石
    g.translate(w / 2, h / 2)
    const s = Math.min(w, h) / 2 - 6
    const grd = g.createLinearGradient(-s, -s, s, s)
    grd.addColorStop(0, '#9be7ff')
    grd.addColorStop(1, '#3b6cff')
    g.fillStyle = grd
    g.beginPath()
    g.moveTo(0, -s)
    g.lineTo(s * 0.8, -s * 0.2)
    g.lineTo(0, s)
    g.lineTo(-s * 0.8, -s * 0.2)
    g.closePath()
    g.fill()
    g.strokeStyle = 'rgba(255,255,255,0.7)'
    g.lineWidth = 2
    g.stroke()
  }
  return c.toDataURL('image/png')
}

// ---- 示例界面 ----

const canvasSlot = (
  x: number,
  y: number,
  w: number,
  h: number,
  a: [number, number, number, number] = [0, 0, 0, 0],
  al: [number, number] = [0, 0],
  auto = false,
) => ({
  LayoutData: {
    Offsets: { Left: x, Top: y, Right: w, Bottom: h },
    Anchors: { Minimum: { X: a[0], Y: a[1] }, Maximum: { X: a[2], Y: a[3] } },
    Alignment: { X: al[0], Y: al[1] },
  },
  bAutoSize: auto,
})
const img = (id: string, w: number, h: number, extra: Record<string, unknown> = {}) => ({
  ResourceObject: `img:${id}`,
  ImageSize: { X: w, Y: h },
  ...extra,
})
const text = (Name: string, Text: string, Size: number, color = '#F3E3B8FF', extra: Record<string, unknown> = {}) => ({
  Type: 'TextBlock',
  Name,
  Properties: {
    Text,
    Font: {
      TypefaceFontName: 'Bold',
      Size,
      OutlineSettings: { OutlineSize: Size > 40 ? 2 : 0, OutlineColor: '#2A1A08FF' },
    },
    ColorAndOpacity: color,
    Justification: 'Center',
    ...extra,
  },
})
const menuButton = (name: string, label: string) => ({
  Type: 'Button',
  Name: `Btn_${name}`,
  Slot: { Padding: { Left: 0, Top: 0, Right: 0, Bottom: 22 }, Size: { SizeRule: 'Fill', Value: 1 } },
  Properties: {
    WidgetStyle: {
      Normal: img('btn_normal', 480, 96, { DrawAs: 'Box', Margin: { Left: 0.1, Top: 0.25, Right: 0.1, Bottom: 0.25 } }),
      Hovered: img('btn_hover', 480, 96, { DrawAs: 'Box', Margin: { Left: 0.1, Top: 0.25, Right: 0.1, Bottom: 0.25 } }),
      Pressed: img('btn_pressed', 480, 96, {
        DrawAs: 'Box',
        Margin: { Left: 0.1, Top: 0.25, Right: 0.1, Bottom: 0.25 },
      }),
      Disabled: img('btn_normal', 480, 96, {
        DrawAs: 'Box',
        Margin: { Left: 0.1, Top: 0.25, Right: 0.1, Bottom: 0.25 },
        TintColor: '#FFFFFF80',
      }),
    },
  },
  Children: [text(`Txt_${name}`, label, 26)],
})

function menuTemplate() {
  const root = {
    Type: 'CanvasPanel',
    Name: 'RootCanvas',
    Children: [
      {
        Type: 'Image',
        Name: 'Background',
        Slot: canvasSlot(0, 0, 0, 0, [0, 0, 1, 1]),
        Properties: { Brush: img('bg_main', 1920, 1080) },
      },
      {
        Type: 'Image',
        Name: 'TitlePlate',
        Slot: canvasSlot(0, 110, 920, 200, [0.5, 0, 0.5, 0], [0.5, 0]),
        Properties: { Brush: img('title_plate', 920, 200) },
      },
      {
        ...text('Title', 'ETERNAL REALM', 54, '#F6D58CFF', {
          ShadowColorAndOpacity: '#000000AA',
          ShadowOffset: { X: 0, Y: 3 },
        }),
        Slot: canvasSlot(0, 210, 0, 0, [0.5, 0, 0.5, 0], [0.5, 0.5], true),
      },
      {
        Type: 'VerticalBox',
        Name: 'MenuBox',
        Slot: canvasSlot(0, 110, 480, 380, [0.5, 0.5, 0.5, 0.5], [0.5, 0.5]),
        Children: [
          {
            Type: 'Overlay',
            Name: 'StartGroup',
            Slot: { Padding: { Left: 0, Top: 0, Right: 0, Bottom: 22 }, Size: { SizeRule: 'Fill', Value: 1 } },
            Children: [
              { ...menuButton('Start', '开始游戏'), Slot: {} },
              {
                Type: 'Image',
                Name: 'Highlight',
                Slot: { Padding: { Left: -16, Top: -14, Right: -16, Bottom: -14 } },
                Properties: {
                  Visibility: 'HitTestInvisible',
                  Brush: img('highlight', 520, 130, {
                    DrawAs: 'Box',
                    Margin: { Left: 0.12, Top: 0.3, Right: 0.12, Bottom: 0.3 },
                  }),
                },
              },
            ],
          },
          menuButton('Settings', '设置'),
          menuButton('Quit', '退出'),
        ],
      },
      {
        ...text('Version', 'v1.0.0', 14, '#8A8070FF', { Justification: 'Right' }),
        Slot: canvasSlot(-40, -30, 0, 0, [1, 1, 1, 1], [1, 1], true),
      },
    ],
  }
  const images = [
    {
      id: 'bg_main',
      name: 'MainMenu_BG',
      prompt: 'dark fantasy night landscape with distant mountains and floating embers, moody purple tones',
      width: 1920,
      height: 1080,
      transparent: false,
    },
    {
      id: 'title_plate',
      name: 'Title_Plate',
      prompt: 'ornate dark stone title plaque with gold trim, elongated hexagon shape',
      width: 920,
      height: 200,
      transparent: true,
    },
    {
      id: 'btn_normal',
      name: 'Button_Normal',
      prompt: 'carved bronze menu button background with gold border, empty center',
      width: 480,
      height: 96,
      transparent: true,
      nineSlice: { Left: 0.1, Top: 0.25, Right: 0.1, Bottom: 0.25 },
    },
    {
      id: 'btn_hover',
      name: 'Button_Hovered',
      prompt: 'same button, brighter bronze with glowing gold border',
      width: 480,
      height: 96,
      transparent: true,
      nineSlice: { Left: 0.1, Top: 0.25, Right: 0.1, Bottom: 0.25 },
    },
    {
      id: 'btn_pressed',
      name: 'Button_Pressed',
      prompt: 'same button, pressed, darker inset',
      width: 480,
      height: 96,
      transparent: true,
      nineSlice: { Left: 0.1, Top: 0.25, Right: 0.1, Bottom: 0.25 },
    },
    {
      id: 'highlight',
      name: 'Button_Highlight',
      prompt: 'thin glowing golden selection frame with soft outer glow, hollow center',
      width: 520,
      height: 130,
      transparent: true,
      nineSlice: { Left: 0.12, Top: 0.3, Right: 0.12, Bottom: 0.3 },
    },
  ]
  return {
    reply:
      '做好了暗黑奇幻风格的主菜单：背景、标题牌、三个按钮（按钮三种状态各一张图，九宫格拉伸），「开始游戏」外面叠了一个独立的高亮框。',
    style: 'dark fantasy, carved bronze and stone with gold trim, soft magical glow',
    root,
    components: [],
    images,
  }
}

function inventoryTemplate() {
  const slots = Array.from({ length: 20 }, (_, i) => ({
    Type: 'UserWidget',
    Name: `Slot_${i}`,
    Class: 'WBP_ItemSlot',
    Slot: { Row: Math.floor(i / 5), Column: i % 5 },
  }))
  const root = {
    Type: 'CanvasPanel',
    Name: 'RootCanvas',
    Children: [
      {
        Type: 'Border',
        Name: 'InventoryPanel',
        Slot: canvasSlot(0, 0, 1240, 720, [0.5, 0.5, 0.5, 0.5], [0.5, 0.5]),
        Properties: {
          Background: img('panel_frame', 400, 300, {
            DrawAs: 'Box',
            Margin: { Left: 0.15, Top: 0.15, Right: 0.15, Bottom: 0.15 },
          }),
        },
        Children: [
          {
            Type: 'HorizontalBox',
            Name: 'Content',
            Slot: { Padding: { Left: 48, Top: 48, Right: 48, Bottom: 48 } },
            Children: [
              {
                Type: 'UniformGridPanel',
                Name: 'Grid',
                Slot: { Size: { SizeRule: 'Fill', Value: 1.4 } },
                Properties: { SlotPadding: { Left: 6, Top: 6, Right: 6, Bottom: 6 } },
                Children: slots,
              },
              {
                Type: 'VerticalBox',
                Name: 'DetailBox',
                Slot: { Padding: { Left: 36, Top: 0, Right: 0, Bottom: 0 }, Size: { SizeRule: 'Fill', Value: 1 } },
                Children: [
                  {
                    Type: 'Image',
                    Name: 'ItemIcon',
                    Slot: { HorizontalAlignment: 'HAlign_Center', Padding: { Left: 0, Top: 0, Right: 0, Bottom: 20 } },
                    Properties: { Brush: img('icon_gem', 160, 160) },
                  },
                  text('ItemName', '星辉宝石', 30),
                  {
                    ...text('ItemDesc', '蕴含星光之力的宝石，镶嵌后提升魔法攻击。', 16, '#C9BFA8FF', {
                      AutoWrapText: true,
                      Justification: 'Left',
                    }),
                    Slot: { Padding: { Left: 0, Top: 14, Right: 0, Bottom: 0 } },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  }
  return {
    reply:
      '做好了背包：左边 5×4 的格子（每个格子是子控件 WBP_ItemSlot），右边是选中物品的图标、名字和说明。面板底框用九宫格拉伸。',
    style: 'dark fantasy, carved stone with gold trim',
    root,
    components: [
      {
        Name: 'WBP_ItemSlot',
        DesignSize: { X: 112, Y: 112 },
        Root: {
          Type: 'Overlay',
          Name: 'SlotRoot',
          Children: [
            { Type: 'Image', Name: 'SlotBG', Properties: { Brush: img('slot_bg', 112, 112) } },
            {
              Type: 'Image',
              Name: 'Icon',
              Slot: { Padding: { Left: 14, Top: 14, Right: 14, Bottom: 14 } },
              Properties: { Brush: img('icon_gem', 84, 84) },
            },
          ],
        },
      },
    ],
    images: [
      {
        id: 'panel_frame',
        name: 'Inventory_Panel',
        prompt: 'dark ornate inventory panel frame with gold border',
        width: 400,
        height: 300,
        transparent: true,
        nineSlice: { Left: 0.15, Top: 0.15, Right: 0.15, Bottom: 0.15 },
      },
      {
        id: 'slot_bg',
        name: 'Item_Slot',
        prompt: 'square inventory slot, dark inset with bronze edge',
        width: 112,
        height: 112,
        transparent: true,
      },
      {
        id: 'icon_gem',
        name: 'Icon_Gem',
        prompt: 'glowing blue crystal gem icon',
        width: 160,
        height: 160,
        transparent: true,
      },
    ],
  }
}

// ---- 接口 ----

const metaOf = (d: Full): DesignMeta => ({
  id: d.id,
  projectId: d.projectId,
  kind: d.kind,
  title: d.title,
  createdAt: d.createdAt,
  updatedAt: d.updatedAt,
  running: d.job?.status === 'running',
})

let seeded = false
const DEMO_EN: Record<string, string> = {
  像素风: 'pixel art',
  赛博朋克: 'cyberpunk',
  卡通: 'cartoon',
  写实: 'realistic',
  中国风: 'Chinese traditional style',
  水墨: 'ink wash painting',
}
/** 演示一开始就有一个做好的主菜单，打开就能看到效果 */
// UI 设计自己的项目，和 Agent 的项目分开
const DEMO_PROJECT = 'demo-ui-project'
const projectList: DesignProject[] = []

function seed() {
  if (seeded) return
  seeded = true
  const projectId = DEMO_PROJECT
  projectList.push({
    id: DEMO_PROJECT,
    name: '暗夜远征',
    path: '/home/demo/code/game-client',
    prompts: [
      { id: 'p1', category: 'style', zh: '暗黑奇幻', en: 'dark fantasy', enabled: true },
      { id: 'p2', category: 'style', zh: '手绘质感的游戏 UI', en: 'hand-painted game UI', enabled: true },
      { id: 'p3', category: 'color', zh: '深色底配暗金色描边', en: 'dark base with antique gold trim', enabled: true },
      { id: 'p4', category: 'material', zh: '雕刻的石材', en: 'carved stone', enabled: true },
      { id: 'p5', category: 'material', zh: '发光的符文', en: 'glowing runes', enabled: false },
      { id: 'p6', category: 'light', zh: '边缘微微发光', en: 'subtle rim glow', enabled: true },
      { id: 'p7', category: 'avoid', zh: '不要文字和水印', en: 'no text, no watermark', enabled: true },
    ],
    createdAt: now(),
    updatedAt: now(),
  })
  const tpl = menuTemplate()
  const at = now()
  const d: Full = {
    id: 'demo-design-menu',
    projectId,
    kind: 'game',
    title: '主菜单',
    designSize: { X: 1920, Y: 1080 },
    style: tpl.style,
    root: normalizeTree(tpl.root),
    components: [],
    annotations: [],
    images: tpl.images.map((i) =>
      DesignImage.parse({
        ...i,
        variants: [{ file: draw(i.id, i.width, i.height), source: 'cli', width: i.width, height: i.height, at }],
      }),
    ),
    messages: [
      {
        id: randomId(),
        role: 'user',
        text: '做一个暗黑奇幻风格的游戏主菜单：标题、开始游戏、设置、退出三个按钮，按钮要有高亮框',
        at,
      },
      {
        id: randomId(),
        role: 'agent',
        text: tpl.reply,
        at,
        images: tpl.images.map((i) => i.id),
        run: { cli: 'claude', model: 'claude-opus-4-1', effort: 'high' },
      },
    ],
    rev: 1,
    createdAt: at,
    updatedAt: at,
    job: null,
  }
  designs.set(d.id, d)
}

async function runChat(
  d: Full,
  text: string,
  source: ImageSource,
  count: number,
  run = { cli: 'claude', model: 'claude-opus-4-1', effort: 'high' },
) {
  const job: Job = {
    status: 'running',
    phase: 'design',
    text: '',
    outChars: 0,
    attempt: 1,
    startedAt: Date.now(),
    run,
  }
  d.job = job
  const tpl = /背包|物品|inventory/i.test(text) ? inventoryTemplate() : menuTemplate()
  // 演示流式输出：先思考，再说明
  for (const ch of '先看一下现在的控件树和图片，再按要求调整布局、列出需要的图片。'.match(/.{1,3}/g) ?? []) {
    await sleep(40)
    job.thinking = (job.thinking ?? '') + ch
  }
  for (const ch of tpl.reply.match(/.{1,4}/g) ?? []) {
    await sleep(60)
    job.text += ch
    job.outChars += 4
  }
  // 演示边写边显示 JSON
  const json = JSON.stringify({ root: tpl.root, images: tpl.images }, null, 2)
  for (let i = 0; i < json.length; i += 160) {
    await sleep(30)
    job.out = json.slice(Math.max(0, i + 160 - 3000), i + 160)
    job.outChars = job.text.length + i + 160
  }
  d.root = normalizeTree(tpl.root)
  d.components = tpl.components.map((c) => ({ ...c, Root: normalizeTree(c.Root) }))
  d.style = tpl.style
  for (const im of tpl.images) {
    const old = d.images.find((i) => i.id === im.id)
    const fields = { ...im, status: source.kind === 'none' ? 'idle' : 'pending', error: undefined }
    if (old) Object.assign(old, fields)
    else d.images.push(DesignImage.parse(fields))
  }
  d.rev++
  d.messages.push({
    id: randomId(),
    role: 'agent',
    text: tpl.reply,
    at: now(),
    images: tpl.images.map((i) => i.id),
    run,
  })
  d.updatedAt = now()
  if (source.kind !== 'none')
    await genImages(
      d,
      tpl.images.map((i) => i.id),
      count,
      job,
    )
  job.status = 'done'
}

async function genImages(d: Full, ids: string[], count: number, job: Job) {
  job.phase = 'images'
  job.text = ''
  job.out = undefined
  job.thinking = undefined
  const items = ids.map((id) => {
    const im = d.images.find((i) => i.id === id)
    return { id, name: im?.name ?? id, status: 'waiting' as const, got: 0, want: count }
  })
  job.images = items
  // 和真实的一样：每张图单独一个会话，同时生成 4 张
  let next = 0
  const worker = async () => {
    while (next < ids.length) {
      const n = next++
      const id = ids[n]
      const im = d.images.find((i) => i.id === id)
      const item = items[n] as import('@shared/design').ImageJobItem
      if (!im) continue
      im.status = 'generating'
      item.status = 'generating'
      const before = im.variants.length
      // 每生成一版就放进设计里
      for (let k = 0; k < count; k++) {
        await sleep(700 + Math.random() * 600)
        im.variants.push({
          file: draw(id, im.width, im.height),
          source: 'cli',
          width: im.width,
          height: im.height,
          at: now(),
        })
        im.selected = before
        item.got++
      }
      item.status = 'done'
      im.status = 'idle'
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker))
}

export function demoDesigns(method: string, id: string | undefined, sub: string | undefined, body: any): unknown {
  seed()
  if (id === 'projects') {
    if (!sub) {
      if (method === 'GET') return projectList
      const at = now()
      const p: DesignProject = {
        id: randomId(),
        name: body.name,
        path: body.path ?? '',
        prompts: body.prompts ?? [],
        createdAt: at,
        updatedAt: at,
      }
      projectList.push(p)
      return p
    }
    const p = projectList.find((x) => x.id === sub) ?? fail('项目不存在')
    if (method === 'DELETE') {
      projectList.splice(projectList.indexOf(p), 1)
      for (const d of [...designs.values()]) if (d.projectId === sub) designs.delete(d.id)
      return undefined
    }
    return Object.assign(p, body, { updatedAt: now() })
  }
  // 在线演示没有 CLI：生成时给一组固定的提示词，翻译时查几个常见词
  if (id === 'prompts') {
    if (body.mode === 'translate')
      return {
        prompts: (body.items ?? []).map((x: { category: string; zh: string }) => ({
          category: x.category,
          zh: x.zh,
          en: DEMO_EN[x.zh] ?? x.zh,
        })),
      }
    return {
      prompts: [
        { category: 'style', zh: '日式动漫风格', en: 'Japanese anime style' },
        { category: 'style', zh: '扁平化图标', en: 'flat icon design' },
        { category: 'color', zh: '明亮的高饱和配色', en: 'bright saturated colors' },
        { category: 'color', zh: '蓝白主色调', en: 'blue and white color scheme' },
        { category: 'material', zh: '光滑的玻璃质感', en: 'glossy glass material' },
        { category: 'light', zh: '柔和的顶光', en: 'soft top lighting' },
        { category: 'layout', zh: '元素居中，四周留白', en: 'centered with even padding' },
        { category: 'avoid', zh: '不要写实照片感', en: 'not photorealistic' },
      ].filter((x) => !(body.existing ?? []).includes(x.zh)),
    }
  }
  if (id === 'browser') {
    if (sub === 'reveal' || sub === 'install' || sub === 'reload') fail('在线演示不能打开本机的浏览器和目录')
    return {
      connected: true,
      version: '1.0.0',
      latestVersion: '1.0.0',
      browsers: [{ id: 'chrome', name: 'Chrome' }],
      extensionDir: '',
      tabs: [
        { id: '101', site: 'gemini', title: 'Gemini', url: 'https://gemini.google.com/app' },
        { id: '102', site: 'chatgpt', title: 'ChatGPT', url: 'https://chatgpt.com/' },
      ],
    }
  }
  if (!id) {
    if (method === 'GET') return [...designs.values()].map(metaOf)
    const at = now()
    const d: Full = {
      id: randomId(),
      projectId: body.projectId,
      kind: body.kind ?? 'game',
      title: body.title,
      designSize: body.designSize ?? { X: 1920, Y: 1080 },
      style: '',
      root: emptyRoot(),
      components: [],
      images: [],
      annotations: [],
      messages: [],
      rev: 0,
      createdAt: at,
      updatedAt: at,
      job: null,
    }
    designs.set(d.id, d)
    return d
  }
  const d = designs.get(id) ?? fail('设计不存在')
  if (!sub) {
    if (method === 'GET') return d
    if (method === 'DELETE') {
      designs.delete(id)
      return undefined
    }
    // 保存：图片的生成结果以「服务端」为准
    const byId = new Map(d.images.map((i) => [i.id, i]))
    d.images = (body.images as typeof d.images).map((i) => {
      const old = byId.get(i.id)
      return old
        ? {
            ...old,
            name: i.name,
            prompt: i.prompt,
            width: i.width,
            height: i.height,
            transparent: i.transparent,
            nineSlice: i.nineSlice,
            selected: i.selected,
          }
        : i
    })
    Object.assign(d, {
      annotations: body.annotations ?? [],
      title: body.title,
      designSize: body.designSize,
      style: body.style,
      root: body.root as Widget,
      components: body.components,
    })
    d.updatedAt = now()
    return d
  }
  if (sub === 'chat') {
    if (d.job?.status === 'running') fail('正在处理上一个请求，等它完成或先停止')
    d.messages.push({
      id: randomId(),
      role: 'user',
      text: body.text,
      at: now(),
      ...(body.annotations?.length ? { annotations: body.annotations } : {}),
    })
    void runChat(d, body.text, body.source, body.count ?? 1, body.run)
    return d
  }
  if (sub === 'copy') {
    const at = now()
    const c: Full = {
      ...structuredClone({ ...d, job: null }),
      id: randomId(),
      projectId: body.projectId ?? d.projectId,
      title: `${d.title} 副本`,
      messages: [],
      annotations: [],
      rev: 0,
      createdAt: at,
      updatedAt: at,
    }
    designs.set(c.id, c)
    return c
  }
  if (sub === 'move') {
    d.projectId = body.projectId
    return metaOf(d)
  }
  if (sub === 'stop') {
    if (d.job) d.job.status = 'done'
    return d.job
  }
  if (sub === 'images') {
    const data = String(body.data)
    const old = body.imageId ? d.images.find((i) => i.id === body.imageId) : undefined
    const v = { file: data, source: 'upload' as const, width: 0, height: 0, at: now() }
    if (old) {
      old.variants.push(v)
      old.selected = old.variants.length - 1
    } else
      d.images.push(
        DesignImage.parse({
          id: randomId().slice(0, 8),
          name: String(body.name ?? 'Image')
            .replace(/\.\w+$/, '')
            .replace(/[^\w]/g, '_'),
          variants: [v],
        }),
      )
    return d
  }
  if (sub === 'export-to-project') fail('在线演示不能写本机目录')
  return d
}

/** 生成单张图片：/designs/:id/images/:imageId/generate */
export function demoGenerate(id: string, imageId: string, body: any) {
  const d = designs.get(id) ?? fail('设计不存在')
  const job: Job = { status: 'running', phase: 'images', text: '', outChars: 0, attempt: 1, startedAt: Date.now() }
  d.job = job
  const im = d.images.find((i) => i.id === imageId) ?? fail('图片不存在')
  im.status = 'pending'
  void genImages(d, [imageId], body.count ?? 1, job).then(() => (job.status = 'done'))
  return d
}

/** 「控件」列表：/designs/projects/:pid/components */
export function demoProjectComponents(pid: string) {
  seed()
  return [...designs.values()]
    .filter((d) => d.projectId === pid && d.components.length)
    .map((d) => ({
      designId: d.id,
      title: d.title,
      components: d.components,
      images: d.images.flatMap((i) => {
        const v = i.variants[i.selected] ?? i.variants.at(-1)
        return v ? [{ id: i.id, file: v.file, width: v.width, height: v.height }] : []
      }),
    }))
}

/** 把别的设计的子控件加进来：/designs/:id/components/import（演示里的图片是 data URL，不用复制文件） */
export function demoImportComponent(id: string, body: any) {
  const d = designs.get(id) ?? fail('设计不存在')
  const src = designs.get(body.from) ?? fail('设计不存在')
  const r = importComponent(d, src, String(body.name ?? ''))
  if ('error' in r) return fail(r.error)
  d.components = r.components
  d.images = r.images
  d.rev++
  return d
}
