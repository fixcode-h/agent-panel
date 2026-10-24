import assert from 'node:assert/strict'
import test from 'node:test'
import type { Design, DesignMessage } from './design.ts'
import type { Widget } from './umg.ts'
import {
  analysisButtonState,
  buildDesignAnalysisPrompt,
  conversationTrace,
  designStateSummary,
  parseDesignAnalysis,
  stripAnalysisJson,
} from './design-analysis.ts'

const widget = (
  Type: Widget['Type'],
  Name: string,
  children: Widget[] = [],
  Properties: Record<string, any> = {},
): Widget => ({
  id: Name.toLowerCase(),
  Type,
  Name,
  Properties,
  ...(children.length ? { Children: children } : {}),
})

const design = (over: Partial<Design> = {}): Design => ({
  id: 'd1',
  projectId: 'p1',
  kind: 'game',
  title: '背包',
  designSize: { X: 1920, Y: 1080 },
  style: '',
  root: widget('CanvasPanel', 'Root', [widget('Image', 'PanelBg'), widget('TextBlock', 'Title', [], { Text: '' })]),
  components: [],
  images: [],
  annotations: [],
  animations: [],
  messages: [],
  concept: { images: [], selected: '', approved: '' },
  rev: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
})

test('解析分析回复：结论和 JSON 分开，中文的 area / priority 也能认出来', () => {
  const text = `整体结构可用，但图片没有九宫格。\n\n\`\`\`json\n${JSON.stringify({
    summary: '结构可用',
    findings: [
      {
        area: '对话过程',
        title: '重复 check',
        detail: '同一版树连续检查了两次',
        evidence: 'check 调用 2 次',
        suggestion: '每块只检查一次',
        priority: '高',
      },
      { area: 'ui', title: '缺少九宫格', evidence: 'PanelBg 没有 nineSlice' },
    ],
  })}\n\`\`\``
  const a = parseDesignAnalysis(text)
  assert.equal(a.summary, '整体结构可用，但图片没有九宫格。')
  assert.equal(a.findings.length, 2)
  assert.deepEqual(
    a.findings.map((f) => [f.area, f.title, f.priority]),
    [
      ['process', '重复 check', 'high'],
      ['ui', '缺少九宫格', 'medium'],
    ],
  )
  assert.equal(a.findings[1].detail, '')
})

test('解析分析回复：兼容 suggestions 字段和没有代码块的 JSON', () => {
  const a = parseDesignAnalysis(
    `先看结论和依据\n{"suggestions":[{"area":"capability","title":"补自动校验","priority":"low"}]}`,
  )
  assert.equal(a.summary, '先看结论和依据')
  assert.equal(a.findings[0].area, 'capability')
  assert.equal(a.findings[0].priority, 'low')
})

test('没有 JSON 的分析回复整段当结论，不丢内容', () => {
  const a = parseDesignAnalysis('  控件树没有大问题，但对话里有重复等待。  ')
  assert.equal(a.summary, '控件树没有大问题，但对话里有重复等待。')
  assert.deepEqual(a.findings, [])
})

test('stripAnalysisJson 去掉代码块或裸 JSON，但留下结论', () => {
  assert.equal(stripAnalysisJson('结论\n\n```json\n{"findings":[]}\n```'), '结论')
  assert.equal(stripAnalysisJson('```json\n{"a":1}\n```'), '')
  assert.equal(stripAnalysisJson('结论\n\n{"findings":[{"title":"x"}]}'), '结论')
})

test('设计状态摘要列出控件、默认文字、图片和没引用的图', () => {
  const d = design({
    root: widget('CanvasPanel', 'Root', [
      widget('Image', 'PanelBg', [], { Brush: { ResourceObject: 'img:bg' } }),
      widget('TextBlock', 'Title'),
      widget('TextBlock', 'Title'),
      widget('Image', 'Unused'),
    ]),
    components: [{ Name: 'Slot', DesignSize: { X: 96, Y: 96 }, Root: widget('Image', 'SlotBg') }],
    images: [
      {
        id: 'bg',
        name: 'panel_bg',
        prompt: '',
        negative: '',
        width: 400,
        height: 200,
        transparent: false,
        variants: [],
        selected: 0,
        status: 'idle',
      },
      {
        id: 'unused',
        name: 'unused_icon',
        prompt: '',
        negative: '',
        width: 64,
        height: 64,
        transparent: true,
        nineSlice: { Left: 0.1, Top: 0.1, Right: 0.1, Bottom: 0.1 },
        variants: [],
        selected: 0,
        status: 'failed',
      },
    ],
  })
  const s = designStateSummary(d)
  assert.match(s, /设计稿尺寸：1920×1080/)
  assert.match(s, /主界面 5 个，子控件 1 个（Slot），合计 6 个/)
  assert.match(s, /重复的控件名：Title/)
  assert.match(s, /默认文字的文本控件：Title/)
  assert.match(s, /图片：2 张，已生成 0 张，生成中\/排队 0 张，失败 1 张；设了九宫格 1 张/)
  assert.match(s, /没被控件树引用的图片：unused_icon（unused，64×64）/)
  assert.match(s, /原画：候选 0 张，还没有确认模板/)
})

test('对话记录带上工具名、参数、输出和耗时，便于指出哪一步在等', () => {
  const messages: DesignMessage[] = [
    {
      id: 'm1',
      role: 'agent',
      text: '在等切图',
      at: '',
      parts: [
        {
          text: '',
          tools: [
            { kind: 'other', name: 'MCP', label: 'design · sleep', input: '30', output: '还在生成', ms: 30000 },
            { kind: 'other', name: 'MCP', label: 'design · check', failed: true },
          ],
        },
      ],
    },
  ]
  const t = conversationTrace(messages)
  assert.match(t, /AI：在等切图/)
  assert.match(t, /MCP · design · sleep 参数：30 → 还在生成，耗时 30 秒/)
  assert.match(t, /MCP · design · check（失败）/)
})

test('分析按钮状态：空闲可分析、分析中变取消、普通执行中不可点', () => {
  assert.equal(analysisButtonState({}), 'analyze')
  assert.equal(analysisButtonState({ running: true, mode: 'analyze' }), 'stop')
  assert.equal(analysisButtonState({ running: true, mode: 'chat' }), 'busy')
  assert.equal(analysisButtonState({ sending: true }), 'disabled')
  assert.equal(analysisButtonState({ asking: true }), 'disabled')
})

test('分析提示词写明三段、只读工具和当前设计数据', () => {
  const p = buildDesignAnalysisPrompt(design({ style: '暗黑奇幻' }), [])
  assert.match(p, /这一轮只分析/)
  assert.match(p, /对话过程（area 写 process）/)
  assert.match(p, /UI 结果（area 写 ui）/)
  assert.match(p, /AI 生成能力（area 写 capability）/)
  assert.match(p, /get_design、get_tree/)
  assert.match(p, /find_widgets、check、screenshot、inspect_image、view_image/)
  assert.match(p, /暗黑奇幻/)
  assert.match(p, /1920×1080/)
})
