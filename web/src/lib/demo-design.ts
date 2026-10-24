/**
 * 在线演示里的 UI 设计：设计存在内存里（图片是 data URL，太大放不进 localStorage），
 * AI 对话按关键词套用示例界面（主菜单 / 背包），图片用 canvas 画出示意图，模拟「生成」的过程。
 */
const randomId = () => crypto.randomUUID()
import {
  DesignImage,
  addToParts,
  emptyConcept,
  type ReplyPart,
  emptyRoot,
  importComponent,
  SavedStyleInput,
  type SavedStyle,
  type Design,
  type DesignMeta,
  type DesignProject,
  type DesignVersion,
  type ImageSource,
} from '@shared/design'
import { normalizeTree, walk, type Widget } from '@shared/umg'
import { DesignData } from '@shared/design-data'
import { BUILTIN_STYLES, isBuiltinStyle } from '@shared/styles'
import { parseDesignAnalysis } from '@shared/design-analysis'
import type { ToolUse } from '@shared/schema'
import { demoMs } from './demo-speed'

type Job = NonNullable<Full['job']>
type Full = Design & { job: import('@shared/design').DesignJob | null }

const designs = new Map<string, Full>()
/** 运行中收不下的消息：这一轮结束后按顺序接着跑（和真服务端一样），带上对话里那条消息的 id */
const pendingChats = new Map<
  string,
  { id: string; text: string; source: ImageSource; count: number; run?: DemoRun }[]
>()
type DemoRun = { cli: string; model: string; effort: string }
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, demoMs(ms)))
const now = () => new Date().toISOString()
const fail = (msg: string): never => {
  throw new Error(msg)
}

/** 把用户的一条要求记进演示的对话：文字、标注、附件、引用、回答和选的风格，和真服务端一样；返回消息 id */
function pushUser(d: Full, body: Record<string, any>, delivery?: 'steer' | 'held' | 'next' | 'lost') {
  if (body.style) d.style = body.style
  const id = randomId()
  d.messages.push({
    id,
    role: 'user',
    text: String(body.text ?? ''),
    at: now(),
    ...(body.annotations?.length ? { annotations: body.annotations } : {}),
    ...(body.attachments?.length ? { attachments: body.attachments } : {}),
    ...(body.refs?.length ? { refs: body.refs } : {}),
    ...(body.answers?.length ? { answers: body.answers } : {}),
    ...(body.style && body.styleName ? { style: body.styleName } : {}),
    ...(delivery ? { delivery: { how: delivery, at: now() } } : {}),
  })
  d.updatedAt = now()
  return id
}

/** 这一轮结束了：有排队的消息就接着开下一轮；消息上从「结束后自动处理」改成「按新的一轮处理」 */
function flushPending(d: Full) {
  if (d.job?.status === 'running') return
  const rest = pendingChats.get(d.id)
  const next = rest?.shift()
  if (!next) return
  if (!rest?.length) pendingChats.delete(d.id)
  d.messages = d.messages.map((m) => (m.id === next.id ? { ...m, delivery: { how: 'next' as const, at: now() } } : m))
  void runChat(d, next.text, next.source, next.count, next.run)
}

// ---- 示意图：按图片 id 里的关键词画 ----

/** 演示用的原画：按设计稿比例画一张整屏的示意图，几张之间换配色和布局 */
function drawConcept(k: number, w: number, h: number): string {
  const c = document.createElement('canvas')
  // 画小一点就够看，data URL 也小
  const s = Math.min(1, 960 / w)
  c.width = Math.round(w * s)
  c.height = Math.round(h * s)
  const W = c.width
  const H = c.height
  const g = c.getContext('2d')!
  const hues = [265, 20, 190, 140]
  const hue = hues[k % hues.length]
  const grd = g.createLinearGradient(0, 0, W, H)
  grd.addColorStop(0, `hsl(${hue} 45% 22%)`)
  grd.addColorStop(1, `hsl(${hue + 30} 50% 8%)`)
  g.fillStyle = grd
  g.fillRect(0, 0, W, H)
  const panel = (x: number, y: number, ww: number, hh: number) => {
    g.fillStyle = `hsla(${hue} 30% 12% / 0.85)`
    g.strokeStyle = `hsl(${hue + 40} 70% 65%)`
    g.lineWidth = 2
    g.beginPath()
    g.roundRect(x, y, ww, hh, 10)
    g.fill()
    g.stroke()
  }
  // 顶栏
  panel(W * 0.02, H * 0.03, W * 0.96, H * 0.09)
  // 左右两种布局交替：左边列表右边详情，或者中间一排按钮
  if (k % 2 === 0) {
    panel(W * 0.03, H * 0.16, W * 0.55, H * 0.78)
    for (let r = 0; r < 4; r++)
      for (let col = 0; col < 5; col++) panel(W * (0.05 + col * 0.105), H * (0.2 + r * 0.18), W * 0.09, H * 0.15)
    panel(W * 0.61, H * 0.16, W * 0.36, H * 0.78)
  } else {
    for (let i = 0; i < 3; i++) panel(W * 0.35, H * (0.32 + i * 0.17), W * 0.3, H * 0.12)
  }
  g.fillStyle = `hsl(${hue + 40} 80% 75%)`
  g.font = `600 ${Math.round(H * 0.045)}px sans-serif`
  g.fillText(`Concept ${k + 1}`, W * 0.04, H * 0.09)
  return c.toDataURL('image/png')
}

/** 演示里的「先出原画」：回复一句，再一张张「画」出三张候选 */
async function runConcepts(
  d: Full,
  text: string,
  run = { cli: 'claude', model: 'claude-opus-4-1', effort: 'high' },
  count = 3,
) {
  const job: Job = { status: 'running', phase: 'design', text: '', outChars: 0, attempt: 1, startedAt: Date.now(), run }
  d.job = job
  await sleep(700)
  d.messages.push({
    id: randomId(),
    role: 'agent',
    text: `先出 ${count} 张整屏原画给你挑${count > 1 ? '，布局和配色各不相同' : ''}。可以在图上标注再让我改，满意了点「用这张做模板」。`,
    at: now(),
    run,
  })
  job.phase = 'concepts'
  const cur = d.concept ?? emptyConcept()
  const round = Math.max(0, ...cur.images.map((i) => i.round)) + 1
  const progress = { want: count, got: 0 }
  job.concepts = progress
  for (let k = 0; k < count; k++) {
    await sleep(900 + Math.random() * 600)
    const c = d.concept ?? emptyConcept()
    const img = {
      id: `c${round}_${k + 1}`,
      file: drawConcept(k + round - 1, d.designSize.X, d.designSize.Y),
      width: d.designSize.X,
      height: d.designSize.Y,
      prompt: text,
      negative: '',
      round,
      source: 'cli' as const,
      at: now(),
    }
    d.concept = { images: [...c.images, img], selected: k === 0 ? img.id : c.selected, approved: '' }
    progress.got++
  }
  job.status = 'done'
  flushPending(d)
}

/** 演示里的「只重绘蒙版区域」：在这张原画的基础上多出一张候选 */
async function runInpaint(d: Full, base: { id: string; prompt: string }, text: string) {
  const job: Job = {
    status: 'running',
    phase: 'concepts',
    text: '',
    outChars: 0,
    attempt: 1,
    startedAt: Date.now(),
  }
  d.job = job
  const cur = d.concept ?? emptyConcept()
  const round = Math.max(0, ...cur.images.map((i) => i.round)) + 1
  const progress = { want: 1, got: 0 }
  job.concepts = progress
  await sleep(1200)
  const c = d.concept ?? emptyConcept()
  const img = {
    id: `c${round}_1`,
    file: drawConcept(round + 2, d.designSize.X, d.designSize.Y),
    width: d.designSize.X,
    height: d.designSize.Y,
    prompt: [base.prompt, text].filter(Boolean).join('\n'),
    negative: '',
    round,
    base: base.id,
    source: 'local' as const,
    at: now(),
  }
  d.concept = { images: [...c.images, img], selected: img.id, approved: '' }
  progress.got++
  job.status = 'done'
  flushPending(d)
}

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
  } else if (/sword/.test(id)) {
    g.save()
    g.translate(w / 2, h / 2)
    g.rotate(-Math.PI / 4)
    const s = Math.min(w, h) * 0.34
    const grd = g.createLinearGradient(0, -s, 0, s)
    grd.addColorStop(0, '#e8eefc')
    grd.addColorStop(1, '#7c8aa8')
    g.fillStyle = grd
    g.beginPath()
    g.moveTo(0, -s)
    g.lineTo(s * 0.16, -s * 0.55)
    g.lineTo(s * 0.16, s * 0.35)
    g.lineTo(-s * 0.16, s * 0.35)
    g.lineTo(-s * 0.16, -s * 0.55)
    g.closePath()
    g.fill()
    g.strokeStyle = '#d9b25f'
    g.lineWidth = 3
    g.beginPath()
    g.moveTo(-s * 0.45, s * 0.35)
    g.lineTo(s * 0.45, s * 0.35)
    g.stroke()
    g.fillStyle = '#4a3520'
    g.fillRect(-s * 0.09, s * 0.35, s * 0.18, s * 0.42)
    g.restore()
  } else if (/potion/.test(id)) {
    const s = Math.min(w, h) * 0.3
    g.save()
    g.translate(w / 2, h / 2)
    g.fillStyle = '#b9c6d8'
    g.fillRect(-s * 0.2, -s, s * 0.4, s * 0.4)
    const grd = g.createLinearGradient(0, -s * 0.4, 0, s)
    grd.addColorStop(0, '#8ef0c0')
    grd.addColorStop(1, '#1f8a63')
    g.fillStyle = grd
    g.beginPath()
    g.arc(0, s * 0.25, s * 0.62, 0, Math.PI * 2)
    g.fill()
    g.strokeStyle = 'rgba(255,255,255,0.7)'
    g.lineWidth = 2
    g.stroke()
    g.restore()
  } else if (/scroll/.test(id)) {
    const s = Math.min(w, h) * 0.32
    g.save()
    g.translate(w / 2, h / 2)
    g.fillStyle = '#e6d7b0'
    g.fillRect(-s * 0.55, -s * 0.8, s * 1.1, s * 1.6)
    g.fillStyle = '#c2a878'
    g.beginPath()
    g.roundRect(-s * 0.75, -s, s * 1.5, s * 0.28, s * 0.14)
    g.roundRect(-s * 0.75, s * 0.72, s * 1.5, s * 0.28, s * 0.14)
    g.fill()
    g.strokeStyle = '#8a7550'
    g.lineWidth = 2
    for (let i = 0; i < 3; i++) {
      g.beginPath()
      g.moveTo(-s * 0.35, -s * 0.35 + i * s * 0.35)
      g.lineTo(s * 0.35, -s * 0.35 + i * s * 0.35)
      g.stroke()
    }
    g.restore()
  } else if (/lock/.test(id)) {
    const s = Math.min(w, h) * 0.3
    g.save()
    g.translate(w / 2, h / 2)
    g.strokeStyle = '#c7d2e0'
    g.lineWidth = s * 0.22
    g.beginPath()
    g.arc(0, -s * 0.35, s * 0.55, Math.PI, 0)
    g.stroke()
    g.fillStyle = '#8492a6'
    g.beginPath()
    g.roundRect(-s * 0.85, -s * 0.3, s * 1.7, s * 1.35, s * 0.22)
    g.fill()
    g.fillStyle = '#3b4656'
    g.beginPath()
    g.arc(0, s * 0.3, s * 0.2, 0, 7)
    g.fill()
    g.restore()
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

/** 网页 UI 的演示：一个产品首页（导航栏、头图、三张功能卡片、页脚） */
function webTemplate() {
  const txt = (Name: string, Text: string, more: Record<string, unknown> = {}) => ({
    Type: 'Text',
    Name,
    Properties: { Text, ...more },
  })
  const card = {
    Type: 'Frame',
    Name: 'Card',
    Properties: {
      Gap: 10,
      Padding: { Left: 24, Top: 24, Right: 24, Bottom: 24 },
      Background: '#FFFFFFFF',
      Radius: 16,
      BorderWidth: 1,
      BorderColor: '#E7E5E4FF',
      Shadow: 'sm',
      Width: 'fill',
      Hover: { Shadow: 'lg', BorderColor: '#FDBA74FF' },
    },
    Children: [
      { Type: 'Picture', Name: 'Icon', Properties: { Src: 'img:feature_icon', Width: 48, Height: 48, Radius: 12 } },
      txt('Title', '实时协作', { Tag: 'h3', FontSize: 20, FontWeight: 600 }),
      txt('Desc', '多人同时编辑同一个看板，改动秒级同步，再也不用来回发文件。', {
        FontSize: 15,
        Color: '#57534EFF',
      }),
    ],
  }
  const feature = (name: string) => ({
    Type: 'UserWidget',
    Name: name,
    Class: 'FeatureCard',
    Properties: { Width: 'fill' },
  })
  const root = {
    Type: 'Frame',
    Name: 'Page',
    Properties: { Width: 'fill', Height: 'fill', Background: '#FAFAF9FF', Overflow: 'auto' },
    Children: [
      {
        Type: 'Frame',
        Name: 'Nav',
        Properties: {
          Direction: 'row',
          AlignItems: 'center',
          JustifyContent: 'between',
          Padding: { Left: 64, Top: 20, Right: 64, Bottom: 20 },
          Width: 'fill',
          Mobile: { Padding: { Left: 20, Top: 16, Right: 20, Bottom: 16 } },
        },
        Children: [
          txt('Logo', 'Flowboard', { FontSize: 22, FontWeight: 700 }),
          {
            Type: 'Frame',
            Name: 'Links',
            Properties: { Direction: 'row', Gap: 28, AlignItems: 'center' },
            Children: [
              // 手机上只留按钮
              txt('Link_Product', '产品', {
                Color: '#44403CFF',
                Href: '#product',
                Mobile: { Visibility: 'Collapsed' },
              }),
              txt('Link_Pricing', '价格', {
                Color: '#44403CFF',
                Href: '#pricing',
                Mobile: { Visibility: 'Collapsed' },
              }),
              txt('Link_Docs', '文档', { Color: '#44403CFF', Href: '#docs', Mobile: { Visibility: 'Collapsed' } }),
              {
                Type: 'WebButton',
                Name: 'Btn_Signup',
                Properties: { Text: '免费试用', Background: '#1C1917FF', Hover: { Background: '#44403CFF' } },
              },
            ],
          },
        ],
      },
      {
        Type: 'Frame',
        Name: 'Hero',
        Properties: {
          Direction: 'row',
          Gap: 48,
          AlignItems: 'center',
          Padding: { Left: 64, Top: 56, Right: 64, Bottom: 56 },
          Width: 'fill',
          // 手机上左文右图改成上下排
          Mobile: { Direction: 'column', Gap: 28, Padding: { Left: 20, Top: 24, Right: 20, Bottom: 32 } },
        },
        Children: [
          {
            Type: 'Frame',
            Name: 'HeroText',
            Properties: { Gap: 20, Width: 'fill' },
            Children: [
              txt('Headline', '让团队的每个项目都井井有条', {
                Tag: 'h1',
                FontSize: 52,
                FontWeight: 700,
                LineHeight: 1.15,
                Mobile: { FontSize: 34 },
              }),
              txt('Subline', '看板、文档和讨论放在一起，任务进展一目了然。超过 12,000 个团队在用。', {
                FontSize: 18,
                Color: '#57534EFF',
              }),
              {
                Type: 'Frame',
                Name: 'Actions',
                Properties: { Direction: 'row', Gap: 12 },
                Children: [
                  {
                    Type: 'WebButton',
                    Name: 'Btn_Start',
                    Properties: {
                      Text: '开始使用',
                      FontSize: 16,
                      Background: '#EA580CFF',
                      Padding: { Left: 24, Top: 12, Right: 24, Bottom: 12 },
                      Radius: 10,
                    },
                  },
                  {
                    Type: 'WebButton',
                    Name: 'Btn_Demo',
                    Properties: {
                      Text: '观看演示',
                      FontSize: 16,
                      Color: '#1C1917FF',
                      Background: '#FFFFFFFF',
                      BorderWidth: 1,
                      BorderColor: '#D6D3D1FF',
                      Padding: { Left: 24, Top: 12, Right: 24, Bottom: 12 },
                      Radius: 10,
                    },
                  },
                ],
              },
            ],
          },
          {
            Type: 'Picture',
            Name: 'HeroArt',
            Properties: {
              Src: 'img:hero_art',
              Width: 560,
              Height: 400,
              Radius: 20,
              Mobile: { Width: 'fill', Height: 240 },
            },
          },
        ],
      },
      {
        Type: 'Frame',
        Name: 'Features',
        Properties: {
          Direction: 'row',
          Gap: 24,
          Padding: { Left: 64, Top: 8, Right: 64, Bottom: 64 },
          Width: 'fill',
          Mobile: { Direction: 'column', Gap: 16, Padding: { Left: 20, Top: 0, Right: 20, Bottom: 32 } },
        },
        Children: [feature('Feature_1'), feature('Feature_2'), feature('Feature_3')],
      },
      { Type: 'Divider', Name: 'FooterLine' },
      txt('Footer', '© 2026 Flowboard · 隐私政策 · 联系我们', {
        FontSize: 13,
        Color: '#A8A29EFF',
        TextAlign: 'center',
      }),
    ],
  }
  return {
    reply: '做好了产品首页：顶部导航、左文右图的头图区、三张功能卡片（做成了子控件 FeatureCard）和页脚。',
    style: 'clean modern SaaS, warm neutral palette with orange accent, soft lighting',
    data: { sets: [] },
    root,
    components: [{ Name: 'FeatureCard', DesignSize: { X: 400, Y: 220 }, Root: card }],
    images: [
      {
        id: 'hero_art',
        name: 'Hero_Art',
        prompt: 'isometric illustration of a tidy project board with cards and avatars, warm orange accents',
        width: 560,
        height: 400,
        transparent: false,
      },
      {
        id: 'feature_icon',
        name: 'Feature_Icon',
        prompt: 'flat rounded app icon of two overlapping chat bubbles, orange gradient',
        width: 96,
        height: 96,
        transparent: true,
      },
    ],
  }
}

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
    data: { sets: [] },
    root,
    components: [],
    images,
  }
}

function inventoryTemplate() {
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
                Properties: {
                  EntryWidgetClass: 'WBP_ItemSlot',
                  NumEntries: 20,
                  NumColumns: 5,
                  SlotPadding: { Left: 6, Top: 6, Right: 6, Bottom: 6 },
                  // 画板按 Items 的行数画格子：真的有物品、选中、锁定和空格子
                  DataSet: 'Items',
                },
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
  // 20 行：前 14 个格子有物品，第一格选中、第 14 格锁定，剩下 6 个空格子
  const items = [
    ['icon_gem', 3],
    ['icon_sword', 1],
    ['icon_potion', 12],
    ['icon_scroll', 5],
    ['icon_gem', 99],
    ['icon_sword', 2],
    ['icon_potion', 4],
    ['icon_scroll', 1],
    ['icon_gem', 7],
    ['icon_sword', 1],
    ['icon_potion', 24],
    ['icon_scroll', 3],
    ['icon_gem', 1],
    ['icon_sword', 6],
  ] as const
  const rows = [
    ...items.map(([icon, count], i) => ({
      icon: `img:${icon}`,
      count,
      selected: i === 0,
      locked: i === 13,
    })),
    ...Array.from({ length: 6 }, () => ({ icon: '', count: 0, selected: false, locked: false })),
  ]
  return {
    reply:
      '做好了背包：左边 5×4 的格子（每个格子是子控件 WBP_ItemSlot），右边是选中物品的图标、名字和说明。' +
      '格子按运行时数据显示：物品图标、数量、选中高亮和锁定标记都在子控件里，用 Items 这份假数据驱动，选中态不再单独贴在画布上。',
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
              Name: 'Highlight',
              Properties: {
                // 选中时高亮框才显示：状态在子控件里，由数据决定
                RenderOpacity: 0,
                Brush: img('slot_highlight', 112, 112),
                States: [
                  {
                    Name: 'Selected',
                    When: { Field: 'selected', Equals: true },
                    Properties: { RenderOpacity: 1 },
                  },
                ],
              },
            },
            {
              Type: 'Image',
              Name: 'Icon',
              Slot: { Padding: { Left: 14, Top: 14, Right: 14, Bottom: 14 } },
              Properties: { Brush: img('icon_gem', 84, 84), DataField: 'icon' },
            },
            {
              Type: 'TextBlock',
              Name: 'Count',
              Slot: {
                Padding: { Left: 0, Top: 0, Right: 7, Bottom: 3 },
                HorizontalAlignment: 'HAlign_Right',
                VerticalAlignment: 'VAlign_Bottom',
              },
              Properties: {
                Text: 'x1',
                Font: { TypefaceFontName: 'Bold', Size: 16 },
                ColorAndOpacity: '#F3E3B8FF',
                ShadowOffset: { X: 1, Y: 1 },
                ShadowColorAndOpacity: '#000000CC',
                Justification: 'Right',
                DataField: 'count',
              },
            },
            {
              Type: 'Image',
              Name: 'Lock',
              Slot: { HorizontalAlignment: 'HAlign_Center', VerticalAlignment: 'VAlign_Center' },
              Properties: {
                Visibility: 'Hidden',
                Brush: img('lock_icon', 44, 44),
                States: [
                  {
                    Name: 'Locked',
                    When: { Field: 'locked', Equals: true },
                    Properties: { Visibility: 'Visible' },
                  },
                ],
              },
            },
          ],
        },
      },
    ],
    data: {
      sets: [
        {
          id: 'items',
          name: 'Items',
          label: '背包物品',
          fields: [
            { key: 'icon', label: '图标', type: 'image', widget: 'WBP_ItemSlot / Icon' },
            { key: 'count', label: '数量', type: 'number', widget: 'WBP_ItemSlot / Count' },
            { key: 'selected', label: '选中', type: 'boolean', widget: 'WBP_ItemSlot / Highlight' },
            { key: 'locked', label: '锁定', type: 'boolean', widget: 'WBP_ItemSlot / Lock' },
          ],
          rows,
        },
      ],
    },
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
        id: 'slot_highlight',
        name: 'Item_Slot_Selected',
        prompt: 'golden selection frame that fits the inventory slot, soft glow',
        width: 112,
        height: 112,
        transparent: true,
      },
      {
        id: 'icon_gem',
        name: 'Icon_Gem',
        prompt: 'glowing blue crystal gem icon',
        width: 84,
        height: 84,
        transparent: true,
      },
      { id: 'icon_sword', name: 'Icon_Sword', prompt: 'silver sword icon', width: 84, height: 84, transparent: true },
      {
        id: 'icon_potion',
        name: 'Icon_Potion',
        prompt: 'green healing potion bottle icon',
        width: 84,
        height: 84,
        transparent: true,
      },
      {
        id: 'icon_scroll',
        name: 'Icon_Scroll',
        prompt: 'rolled parchment scroll icon',
        width: 84,
        height: 84,
        transparent: true,
      },
      { id: 'lock_icon', name: 'Icon_Lock', prompt: 'padlock lock icon', width: 44, height: 44, transparent: true },
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
    data: DesignData.parse(tpl.data),
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
  // 背包：格子按运行时假数据渲染，打开就能看到物品、选中、锁定和空格子
  const inv = inventoryTemplate()
  const invAt = now()
  const invD: Full = {
    id: 'demo-design-inventory',
    projectId,
    kind: 'game',
    title: '背包',
    designSize: { X: 1920, Y: 1080 },
    style: inv.style,
    data: DesignData.parse(inv.data),
    root: normalizeTree(inv.root),
    components: inv.components.map((c) => ({ ...c, Root: normalizeTree(c.Root) })),
    annotations: [],
    images: inv.images.map((i) =>
      DesignImage.parse({
        ...i,
        variants: [{ file: draw(i.id, i.width, i.height), source: 'cli', width: i.width, height: i.height, at: invAt }],
      }),
    ),
    messages: [
      {
        id: randomId(),
        role: 'user',
        text: '做一个暗黑奇幻风格的背包界面：左边 5×4 的格子，格子里要有物品图标、数量和选中/锁定状态',
        at: invAt,
      },
      {
        id: randomId(),
        role: 'agent',
        text: inv.reply,
        at: invAt,
        images: inv.images.map((i) => i.id),
        run: { cli: 'claude', model: 'claude-opus-4-1', effort: 'high' },
      },
    ],
    rev: 1,
    createdAt: invAt,
    updatedAt: invAt,
    job: null,
  }
  designs.set(invD.id, invD)
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
  // 整体风格还没定、这次也没说：和真实的一样先问风格
  if (!d.style.trim() && !/风格|style|参考|截图/i.test(text)) {
    await sleep(600)
    d.messages.push({
      id: randomId(),
      role: 'agent',
      text: '动手之前先定一下整体风格，后面所有图片都按它来。',
      at: now(),
      run,
      questions: [
        {
          text: '想要什么整体风格？',
          header: '风格',
          multiSelect: false,
          options: [
            ...demoStyleList
              .filter((x) => x.kind === d.kind)
              .map((x) => ({ label: x.name, desc: x.summary, style: x.en })),
            ...(d.kind === 'web'
              ? [
                  {
                    label: '简约科技',
                    desc: '大量留白、细线条、蓝紫渐变点缀',
                    style: 'minimal tech, generous whitespace, thin lines, blue-violet gradient accents',
                  },
                  {
                    label: '温暖手作',
                    desc: '米色纸张质感、手绘插画、圆润字体',
                    style: 'warm handmade, beige paper texture, hand-drawn illustrations, rounded type',
                  },
                ]
              : [
                  {
                    label: '日系卡通',
                    desc: '明亮配色、圆润描边、Q 版可爱',
                    style: 'bright japanese cartoon, rounded thick outlines, cute chibi, saturated pastel palette',
                  },
                  {
                    label: '科幻全息',
                    desc: '深蓝底、青色发光线框、半透明面板',
                    style: 'sci-fi hologram, deep navy background, cyan glowing wireframes, translucent glass panels',
                  },
                ]),
          ].slice(0, 4),
        },
        {
          text: '主色调偏向哪种？',
          header: '配色',
          multiSelect: true,
          options: [
            { label: '冷色', desc: '蓝、青、紫为主，沉静克制', style: '' },
            { label: '暖色', desc: '金、橙、红为主，热烈醒目', style: '' },
            { label: '中性', desc: '黑白灰为主，点缀一种强调色', style: '' },
          ],
        },
      ],
    })
    d.updatedAt = now()
    job.status = 'done'
    flushPending(d)
    return
  }
  addVersion(d, `AI 修改前：${text.slice(0, 24)}`, true)
  const tpl =
    d.kind === 'web' ? webTemplate() : /背包|物品|inventory/i.test(text) ? inventoryTemplate() : menuTemplate()
  // 演示流式输出：和真的一样按顺序来——思考、调设计工具、再说明
  let parts: ReplyPart[] = []
  for (const ch of '先看一下现在的控件树和图片，再按要求调整布局、列出需要的图片。'.match(/.{1,3}/g) ?? []) {
    await sleep(40)
    job.parts = parts = addToParts(parts, { type: 'thinking', text: ch, delta: true })
  }
  const calls = [
    ['create_components', tpl.components.map((c) => c.Name).join(', ')],
    ['replace_widget', tpl.root.Name ?? 'Root'],
    ['add_images', tpl.images.map((i) => i.id).join(', ')],
    ['check', ''],
  ]
  for (const [name, arg] of calls) {
    await sleep(260)
    const tool: ToolUse = {
      kind: 'other',
      name: 'MCP',
      label: `design · ${name}`,
      detail: '',
      input: arg,
      output: '好了',
    }
    job.parts = parts = addToParts(parts, { type: 'tool', tool })
  }
  for (const ch of tpl.reply.match(/.{1,4}/g) ?? []) {
    await sleep(60)
    job.parts = parts = addToParts(parts, { type: 'text', text: ch, delta: true })
    job.text += ch
    job.outChars += 4
  }
  d.root = normalizeTree(tpl.root)
  d.components = tpl.components.map((c) => ({ ...c, Root: normalizeTree(c.Root) }))
  d.data = DesignData.parse(tpl.data)
  d.style = d.style || tpl.style
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
    parts,
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
  flushPending(d)
}

/** 演示里的「AI 分析」：读当前设计的控件和图片，给三段结论，不改设计 */
async function runAnalysis(d: Full, run = { cli: 'claude', model: 'claude-opus-4-1', effort: 'high' }) {
  const job: Job = {
    status: 'running',
    phase: 'design',
    mode: 'analyze',
    text: '',
    outChars: 0,
    attempt: 1,
    startedAt: Date.now(),
    run,
  }
  d.job = job
  await sleep(400)
  let parts: ReplyPart[] = []
  for (const ch of '先看控件树、图片和最近的工具调用，再给结论。'.match(/.{1,3}/g) ?? []) {
    await sleep(24)
    job.parts = parts = addToParts(parts, { type: 'thinking', text: ch, delta: true })
  }
  for (const [name, arg] of [
    ['get_design', ''],
    ['get_tree', ''],
    ['check', ''],
    ['screenshot', ''],
  ]) {
    await sleep(180)
    job.parts = parts = addToParts(parts, {
      type: 'tool',
      tool: {
        kind: 'other',
        name: 'MCP',
        label: `design · ${name}`,
        detail: '',
        input: arg,
        output: name === 'check' ? '检查完成' : '好了',
      },
    })
  }
  const tools = [...d.messages]
    .reverse()
    .flatMap((m) => (m.parts ?? []).flatMap((p) => p.tools as ToolUse[]))
    .slice(0, 5)
    .map((t) => t.label)
  const noSlice = d.images.filter((i) => !i.nineSlice)
  const unused = d.images.filter((i) => !JSON.stringify(d.root).includes(`img:${i.id}`))
  const summary = `这个「${d.title}」的结构基本可用，但对话里有重复等待和检查，图片的九宫格设置也不完整。建议先补自动校验，再调整对话节奏。`
  const findings = [
    {
      area: 'process',
      title: '同一状态上重复检查',
      detail: '改完一处又反复调 check / get_tree，期间没有新的改动，工具输出也没有带来新信息，拖慢了一轮。',
      evidence: tools.length
        ? `最近一轮的工具调用：${tools.join('、')}；其中 check 在同一版控件树上出现了不止一次。`
        : '这一轮还没有改动的工具调用，只有需求描述；可以先让 AI 搭完骨架再统一检查。',
      suggestion: '每改完一个区域只调一次 check；同一版控件树不要连续 get_tree，需要看结果时直接看上一次的输出。',
      priority: 'medium',
    },
    {
      area: 'process',
      title: '等待切图的方式浪费了时间',
      detail: '切图还在生成时反复等待再回来查询，期间没有推进别的区域，整个对话被一张图卡住。',
      evidence: `当前设计有 ${d.images.length} 张图片，其中 ${d.images.filter((i) => i.status === 'pending' || i.status === 'generating').length} 张还在排队或生成。`,
      suggestion: '切图生成期间继续搭下一块控件，等一轮结束再统一检查；不要用 sleep 反复轮询生成状态。',
      priority: 'medium',
    },
    {
      area: 'ui',
      title: '图片缺少九宫格设置',
      detail: '面板和按钮这类要拉伸的图没有 nineSlice，换分辨率或拉宽后会变形。',
      evidence: noSlice.length
        ? `${noSlice.length} 张图片没有 nineSlice，例如 ${noSlice
            .slice(0, 3)
            .map((i) => `${i.name}（${i.width}×${i.height}）`)
            .join('、')}。`
        : '所有图片都设置了 nineSlice。',
      suggestion:
        '给面板底框、按钮底图、进度条这类要拉伸的图片设置 nineSlice，并把画刷 DrawAs 改成 Box、Margin 用同样的比例。',
      priority: 'medium',
    },
    {
      area: 'ui',
      title: unused.length ? '有图片没有被控件引用' : '控件层级和命名可以再统一',
      detail: unused.length
        ? '列了图但没有用到控件上，导出后会多出没用上的贴图。'
        : '树的层级清楚，但按钮、图标和图标的命名还可以统一成同一套前缀。',
      evidence: unused.length
        ? `没有引用的图片：${unused
            .slice(0, 4)
            .map((i) => i.name)
            .join('、')}。`
        : `当前设计 ${d.title} 的控件树里引用的图片和图片列表一致。`,
      suggestion: unused.length
        ? '把没引用的图片用上，或者从图片列表里删掉，保证每张图都能在树里找到用处。'
        : '按钮统一用 Btn_ 前缀、图标统一用 Icon_ 前缀，子控件名和它们的根控件保持一致。',
      priority: 'medium',
    },
    {
      area: 'capability',
      title: '生成后自动跑一遍结构校验',
      detail: '现在要等 AI 自己想起来调 check；把校验挂到每轮结束前，能稳定拦住默认文字、越界和未引用图片。',
      evidence: `当前设计有 ${d.messages.length} 条消息，最近一轮才出现 check；不是每次改动后都有校验。`,
      suggestion:
        '在提示词里要求「每次改完一个区域后调 check，最后必须再调一次」，并把默认文字、控件越界、图片未引用作为必须修掉的问题。',
      priority: 'high',
    },
    {
      area: 'capability',
      title: '把常用布局写进系统提示词',
      detail: '背包、列表、技能栏这些固定结构每次都在重新描述，容易漏掉 EntryWidgetClass、网格列数这类属性。',
      evidence: `当前设计的控件树有 ${JSON.stringify(d.root).length} 个字符，结构主要靠这一轮对话临时描述。`,
      suggestion:
        '在提示词里补上背包格子、技能栏、列表页的模板写法（控件类型、EntryWidgetClass、列数、间距），让 AI 直接按模板搭。',
      priority: 'medium',
    },
    {
      area: 'capability',
      title: '切图按用途分组生成',
      detail: '同类小图标一张张生成很慢，尺寸也不统一；可以按 sheet 分组，大图再单独生成。',
      evidence: `当前有 ${d.images.length} 张图片，其中透明小图 ${d.images.filter((i) => i.transparent).length} 张。`,
      suggestion:
        '把尺寸相同的物品、技能、货币图标放进同一个 sheet 批量生成，面板底框和按钮底图继续单张生成并设置 nineSlice。',
      priority: 'low',
    },
  ]
  const reply = `\`\`\`json\n${JSON.stringify({ summary, findings })}\n\`\`\``
  const analysis = parseDesignAnalysis(reply)
  for (const ch of summary.match(/.{1,4}/g) ?? []) {
    await sleep(24)
    job.parts = parts = addToParts(parts, { type: 'text', text: ch, delta: true })
    job.text += ch
    job.outChars += 4
  }
  d.messages.push({
    id: randomId(),
    role: 'agent',
    text: analysis.summary || summary,
    at: now(),
    run,
    parts,
    analysis,
  })
  d.updatedAt = now()
  job.status = 'done'
  flushPending(d)
}

async function genImages(d: Full, ids: string[], count: number, job: Job) {
  job.phase = 'images'
  job.text = ''
  job.parts = undefined
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
        // 不跟着 demoMs 缩短：界面检查要截「正在生成图片」这一刻，页面是轮询进度的，太快就看不到了
        await new Promise((r) => setTimeout(r, 1200 + Math.random() * 800))
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
      data: { sets: [] },
      root: emptyRoot(body.kind ?? 'game'),
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
      data: body.data ? DesignData.parse(body.data) : (d.data ?? { sets: [] }),
      root: body.root as Widget,
      components: body.components,
      animations: body.animations ?? d.animations ?? [],
    })
    d.updatedAt = now()
    return d
  }
  if (sub === 'chat') {
    if (d.job?.status === 'running') fail('正在处理上一个请求，等它完成或先停止')
    pushUser(d, body)
    // AI 分析：只读，不套模板、不改设计
    if (body.mode === 'analyze') {
      void runAnalysis(d, body.run)
      return d
    }
    const concept = d.concept ?? emptyConcept()
    // 原画张数用「原画」按钮右键菜单里设的那个数，和每张图生成几版（body.count）分开
    if (
      !concept.approved &&
      (body.concept || (body.annotations ?? []).some((a: { target: string }) => a.target.startsWith('concept:')))
    )
      void runConcepts(d, body.text, body.run, body.conceptCount ?? 3)
    else void runChat(d, body.text, body.source, body.count ?? 1, body.run)
    return d
  }
  // 原画：选中、确认模板、删掉；带图片数据的是上传，带蒙版的是局部重绘
  if (sub === 'concept') {
    const c = d.concept ?? emptyConcept()
    if (body.mask) {
      if (d.job?.status === 'running') fail('正在处理上一个请求，等它完成或先停止')
      const base = c.images.find((i) => i.id === body.id) ?? fail('没有这张原画')
      void runInpaint(d, base, String(body.text ?? ''))
      return d
    }
    if (body.data) {
      const round = Math.max(0, ...c.images.map((i) => i.round)) + 1
      const img = {
        id: `c${round}_1`,
        file: String(body.data),
        width: d.designSize.X,
        height: d.designSize.Y,
        prompt: '',
        negative: '',
        round,
        source: 'upload' as const,
        at: now(),
      }
      d.concept = { ...c, images: [...c.images, img], selected: img.id }
      return d
    }
    const cid = String(body.id ?? '')
    if (body.action === 'select') d.concept = { ...c, selected: cid }
    else if (body.action === 'approve') d.concept = { ...c, approved: cid, selected: cid || c.selected }
    else if (body.action === 'remove') {
      const images = c.images.filter((i) => i.id !== cid)
      d.concept = {
        images,
        selected: c.selected === cid ? (images.at(-1)?.id ?? '') : c.selected,
        approved: c.approved === cid ? '' : c.approved,
      }
    }
    return d
  }
  if (sub === 'capture') return { ok: true }
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
    // 用户点了停止：排着的消息不再自动处理，对话里标明没送出去，让人知道要重新发一次
    const dropped = new Set((pendingChats.get(d.id) ?? []).map((x) => x.id))
    pendingChats.delete(d.id)
    if (dropped.size)
      d.messages = d.messages.map((m) =>
        dropped.has(m.id) ? { ...m, delivery: { how: 'lost' as const, at: now() } } : m,
      )
    if (d.job) d.job.status = 'done'
    return d.job
  }
  // 和真的一样：正在改设计时把整条消息补充给这一轮；收不下就记进对话，这一轮结束后自动接着处理
  if (sub === 'steer') {
    if (d.job?.status === 'running' && d.job.phase === 'design') {
      pushUser(d, body, 'steer')
      return { ...d, steered: true, queued: false }
    }
    if (d.job?.status === 'running') {
      const id = pushUser(d, body, 'held')
      pendingChats.set(d.id, [
        ...(pendingChats.get(d.id) ?? []),
        {
          id,
          text: String(body.text ?? ''),
          source: body.source ?? { kind: 'cli' },
          count: body.count ?? 1,
          run: body.run,
        },
      ])
      return { ...d, steered: false, queued: true }
    }
    // 这一轮刚好结束了：直接开始新的一轮
    pushUser(d, body)
    void runChat(d, String(body.text ?? ''), body.source ?? { kind: 'cli' }, body.count ?? 1, body.run)
    return { ...d, steered: false, queued: false }
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
  void genImages(d, [imageId], body.count ?? 1, job).then(() => {
    job.status = 'done'
    flushPending(d)
  })
  return d
}

/** 「控件」列表：/designs/projects/:pid/components */
export function demoProjectComponents(pid: string) {
  seed()
  return [...designs.values()]
    .filter((d) => d.projectId === pid && d.components.length)
    .map((d) => ({
      designId: d.id,
      kind: d.kind,
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
  d.animations = r.animations
  d.rev++
  return d
}

// ---- 版本（在线演示：放在内存里） ----
const versions = new Map<string, DesignVersion[]>()
function addVersion(d: Full, name: string, auto: boolean) {
  const v: DesignVersion = {
    id: randomId(),
    name,
    at: now(),
    auto,
    snapshot: structuredClone({
      designSize: d.designSize,
      style: d.style,
      root: d.root,
      components: d.components,
      images: d.images,
      animations: d.animations ?? [],
    }),
  }
  versions.set(d.id, [v, ...(versions.get(d.id) ?? [])].slice(0, 40))
  return v
}
const meta = ({ snapshot, ...rest }: DesignVersion) => {
  let widgets = 0
  for (const r of [snapshot.root, ...snapshot.components.map((c) => c.Root)]) walk(r, () => widgets++)
  return { ...rest, widgets }
}

/** /designs/:id/versions[/:vid[/restore]] */
export function demoVersions(
  method: string,
  id: string,
  vid: string | undefined,
  action: string | undefined,
  body: any,
) {
  seed()
  const d = designs.get(id) ?? fail('设计不存在')
  const list = versions.get(id) ?? []
  if (!vid) return method === 'POST' ? meta(addVersion(d, String(body.name || '未命名版本'), false)) : list.map(meta)
  const v = list.find((x) => x.id === vid) ?? fail('版本不存在')
  if (method === 'DELETE') {
    versions.set(
      id,
      list.filter((x) => x !== v),
    )
    return undefined
  }
  if (action === 'restore') {
    addVersion(d, `恢复「${v.name}」之前`, true)
    Object.assign(
      d,
      structuredClone({
        root: v.snapshot.root,
        components: v.snapshot.components,
        designSize: v.snapshot.designSize,
        style: v.snapshot.style,
        animations: v.snapshot.animations ?? [],
      }),
    )
    d.rev++
    return d
  }
  return v
}

/** 演示的风格库：存在内存里，刷新后回到示例 */
const demoStyleList: SavedStyle[] = [
  {
    id: 'style-dark-fantasy',
    name: '暗黑奇幻·石刻金边',
    kind: 'game',
    summary: '深色石刻底框配暗金描边，幽蓝符文微光，整体厚重神秘。',
    en: 'dark fantasy, carved dark stone frames with aged gold trim, faint glowing blue runes, heavy and mysterious mood, soft rim light',
    prompts: [
      { category: 'style', zh: '暗黑奇幻', en: 'dark fantasy' },
      { category: 'material', zh: '石刻底框、暗金描边', en: 'carved stone frames, aged gold trim' },
      { category: 'light', zh: '幽蓝符文微光', en: 'faint glowing blue runes' },
    ],
    createdAt: '2026-10-17T08:00:00.000Z',
    updatedAt: '2026-10-17T08:00:00.000Z',
  },
]

export function demoStyles(method: string, sid: string | undefined, body: any): unknown {
  if (method === 'GET') return [...demoStyleList, ...BUILTIN_STYLES]
  if (isBuiltinStyle(sid ?? '')) fail('内置风格不能修改，复制成自己的再改')
  if (method === 'POST') {
    const at = now()
    const item: SavedStyle = { ...SavedStyleInput.parse(body), id: randomId(), createdAt: at, updatedAt: at }
    demoStyleList.unshift(item)
    return item
  }
  const i = demoStyleList.findIndex((x) => x.id === sid)
  if (i < 0) fail('风格不存在')
  if (method === 'DELETE') {
    demoStyleList.splice(i, 1)
    return undefined
  }
  demoStyleList[i] = { ...demoStyleList[i], ...body, updatedAt: now() }
  return demoStyleList[i]
}

/** 演示里「AI 总结风格」：按设计现有的风格说明拼一个 */
export async function demoExtractStyle(id: string) {
  await sleep(900)
  const d = designs.get(id)
  return {
    name: d?.kind === 'web' ? '温暖简约·橙色点缀' : '暗黑奇幻·铜金符文',
    summary:
      d?.kind === 'web' ? '暖灰底色配橙色强调，圆角卡片，柔和阴影。' : '青铜和石材质感，金色描边，柔和的魔法光晕。',
    en: d?.style || 'dark fantasy, carved bronze and stone with gold trim, soft magical glow',
    prompts: [
      {
        category: 'style',
        zh: d?.kind === 'web' ? '简约现代' : '暗黑奇幻',
        en: d?.kind === 'web' ? 'clean modern' : 'dark fantasy',
      },
      {
        category: 'color',
        zh: d?.kind === 'web' ? '暖灰 + 橙色' : '青铜 + 金色',
        en: d?.kind === 'web' ? 'warm grey with orange accent' : 'bronze and gold',
      },
    ],
  }
}
