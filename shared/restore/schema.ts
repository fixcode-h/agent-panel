import { z } from 'zod'

/**
 * 照原画一比一还原（设计稿：项目文件 designs/UI设计-原画还原重设计-设计稿.md）。
 * 六步：原画 → 拆解 → 切图 → 搭建 → 校验 → 交付。每一步交一版（决策卡 + 这一步的产物），用户确认才进下一步；
 * 改了上游，下游标成「要更新」。整个还原的「单一真相」是元素表：位置由算法量出来、用户可以拖，确认后锁定，
 * 控件树由元素表编译出来，模型只给类型、名字、分组和文字内容，不提交坐标
 */

export const RESTORE_STEPS = ['source', 'elements', 'assets', 'build', 'verify', 'deliver'] as const
export type RestoreStep = (typeof RESTORE_STEPS)[number]

export const ELEMENT_KINDS = [
  'background',
  'panel',
  'button',
  'slot',
  'icon',
  'text',
  'bar',
  'input',
  'decoration',
  'other',
] as const
export type ElementKind = (typeof ELEMENT_KINDS)[number]
/** 能装别的元素的类型：搭建时变成容器 */
export const CONTAINER_KINDS: readonly ElementKind[] = ['background', 'panel', 'button', 'slot', 'bar', 'input']

export const Box = z.object({ x: z.number(), y: z.number(), w: z.number().min(1), h: z.number().min(1) })
export type Box = z.infer<typeof Box>

export const ElementText = z.object({
  content: z.string().max(400).default(''),
  /** 字的像素高度（原画像素，按笔画量的，不是字号） */
  px: z.number().min(1).default(16),
  color: z.string().default('#FFFFFFFF'),
  align: z.enum(['left', 'center', 'right']).default('left'),
  bold: z.boolean().default(false),
})
export type ElementText = z.infer<typeof ElementText>

export const RestoreElement = z.object({
  id: z.string(),
  kind: z.enum(ELEMENT_KINDS).default('other'),
  /** 控件名：英文 PascalCase 加类型前缀（Btn_Start、Icon_Gem），模型起、用户可以改 */
  name: z.string().max(80).default(''),
  /** 原画像素 */
  box: Box,
  /** 0~1：算法检测的把握；低于 0.6 的在图上画黄框 */
  confidence: z.number().min(0).max(1).default(1),
  source: z.enum(['detect', 'ai', 'user', 'psd']).default('detect'),
  text: ElementText.optional(),
  /** 重复组（背包格子这类大小一样、等间距排开的）：同组的搭成一个子控件 */
  repeat: z.string().optional(),
  /** 用户删掉的不再出现（重新检测时也跳过同一块） */
  hidden: z.boolean().optional(),
  /** PSD 图层：这个元素的像素直接取自图层文件（设计目录 images/ 下），不从合成图里抠 */
  layer: z.string().optional(),
  /** PSD 按钮组里 @hover / @pressed / @disabled 的图层文件：搭建时按钮这几态用它们，不再从常态派生 */
  states: z
    .object({ hover: z.string().optional(), pressed: z.string().optional(), disabled: z.string().optional() })
    .optional(),
  /** 切图那一步给它的图片 id（设计的 images 里）、拼回去和原画那一块的相似度 */
  image: z.string().optional(),
  sim: z.number().optional(),
  /** 搭建那一步给它的控件名 */
  widget: z.string().optional(),
})
export type RestoreElement = z.infer<typeof RestoreElement>

export const RepeatGroup = z.object({
  id: z.string(),
  name: z.string().default(''),
  rows: z.number().int().min(1),
  cols: z.number().int().min(1),
  /** 格子大小和间距（原画像素） */
  cell: z.object({ w: z.number(), h: z.number() }),
  gap: z.object({ x: z.number(), y: z.number() }),
  origin: z.object({ x: z.number(), y: z.number() }),
})
export type RepeatGroup = z.infer<typeof RepeatGroup>

/** 决策卡：每一步交的那一版最上面那张卡，要注意的条目由面板按分数算，不靠模型自己写 */
export const StepCard = z.object({
  conclusion: z.string().default(''),
  todo: z.string().default(''),
  warnings: z.array(z.string()).max(6).default([]),
  /** 相比上一版改了什么（第 2 版起） */
  diff: z.string().default(''),
  /** 这一步的分数：覆盖率、相似度、偏差…… */
  metrics: z.array(z.object({ label: z.string(), value: z.string(), ok: z.boolean().optional() })).default([]),
  /** 模型这一步说的话（标注时的说明） */
  note: z.string().default(''),
})
export type StepCard = z.infer<typeof StepCard>

export const StepVersion = z.object({
  n: z.number().int().min(1),
  at: z.string(),
  card: StepCard,
  /** 这一版提交时用户写的意见 */
  feedback: z.string().default(''),
})
export type StepVersion = z.infer<typeof StepVersion>

export const StepState = z.object({
  status: z.enum(['todo', 'running', 'review', 'done', 'stale', 'failed']).default('todo'),
  versions: z.array(StepVersion).max(50).default([]),
  error: z.string().optional(),
})
export type StepState = z.infer<typeof StepState>

/** 校验：每个元素和搭出来的控件差多少 */
export const ElementCheck = z.object({
  element: z.string(),
  widget: z.string().default(''),
  dx: z.number().default(0),
  dy: z.number().default(0),
  dw: z.number().default(0),
  dh: z.number().default(0),
  /** 切图和原画那一块的相似度 */
  sim: z.number().optional(),
  ok: z.boolean(),
  /** 用户点了「接受差异」 */
  accepted: z.boolean().optional(),
  /** 哪里不对（给人看的） */
  why: z.string().default(''),
})
export type ElementCheck = z.infer<typeof ElementCheck>

export const RestoreScore = z.object({
  total: z.number(),
  posOk: z.number(),
  posTotal: z.number(),
  assetSim: z.number(),
  textOk: z.number(),
  textTotal: z.number(),
  passed: z.boolean(),
  items: z.array(ElementCheck).default([]),
  /** 自动修了几处（结构推断带来的偏差，按元素框重新编译） */
  fixed: z.number().default(0),
})
export type RestoreScore = z.infer<typeof RestoreScore>

/** 控件状态（按钮四态、格子选中 / 锁定）：从常态派生，或原画、PSD 里本来就有 */
export const StateRule = z.object({
  brightness: z.number().default(0),
  saturate: z.number().default(1),
  opacity: z.number().default(1),
  offsetY: z.number().default(0),
  glow: z.boolean().default(false),
})
export type StateRule = z.infer<typeof StateRule>
export const StateRow = z.object({
  /** 控件名（按钮）或重复组的子控件名 */
  target: z.string(),
  state: z.enum(['normal', 'hover', 'pressed', 'disabled', 'selected', 'locked', 'empty']),
  source: z.enum(['art', 'derived', 'upload', 'psd']).default('derived'),
  rule: StateRule.optional(),
  /** 这个状态用的图片 id */
  image: z.string().optional(),
})
export type StateRow = z.infer<typeof StateRow>

export const RestoreSource = z.object({
  kind: z.enum(['image', 'psd', 'concept']),
  /** 设计目录 images/ 下的原画文件（PNG；PSD 是合成图） */
  file: z.string(),
  name: z.string().default(''),
  width: z.number().int().min(1),
  height: z.number().int().min(1),
})
export type RestoreSource = z.infer<typeof RestoreSource>

export const RestoreState = z.object({
  source: RestoreSource.optional(),
  steps: z.partialRecord(z.enum(RESTORE_STEPS), StepState).default({}),
  elements: z.array(RestoreElement).max(600).default([]),
  groups: z.array(RepeatGroup).max(40).default([]),
  states: z.array(StateRow).max(400).default([]),
  score: RestoreScore.optional(),
  /** 干净的背景（擦掉元素补齐后的原画）：images/ 下的文件 */
  plate: z.string().optional(),
})
export type RestoreState = z.infer<typeof RestoreState>

export const emptyRestore = (): RestoreState => ({ steps: {}, elements: [], groups: [], states: [] })

/** 一步的状态（没有记录的当作还没开始） */
export const stepOf = (r: RestoreState | undefined, s: RestoreStep): StepState =>
  r?.steps[s] ?? { status: 'todo', versions: [] }

/** 原画像素 → 设计稿像素的比例 */
export const artScale = (r: RestoreState | undefined, size: { X: number; Y: number }) => ({
  x: r?.source ? size.X / r.source.width : 1,
  y: r?.source ? size.Y / r.source.height : 1,
})

/** 改了这一步，它后面已经做过的步骤都要更新 */
export function markStale(r: RestoreState, from: RestoreStep) {
  const i = RESTORE_STEPS.indexOf(from)
  for (const s of RESTORE_STEPS.slice(i + 1)) {
    const st = r.steps[s]
    if (st && (st.status === 'done' || st.status === 'review')) r.steps[s] = { ...st, status: 'stale' }
  }
}

/** 交一版：状态改成等确认，版本号接着上一版 */
export function pushVersion(r: RestoreState, step: RestoreStep, card: StepCard, feedback = '', at = '') {
  const st = stepOf(r, step)
  const n = (st.versions.at(-1)?.n ?? 0) + 1
  r.steps[step] = {
    status: 'review',
    versions: [...st.versions, { n, at: at || new Date().toISOString(), card, feedback }].slice(-50),
  }
  markStale(r, step)
}

/** 面板重启时还在「运行中」的步骤：后台已经没有在跑了，标成失败让用户重跑 */
/** 还原的某一步在后台跑：这期间页面保存的控件树和图片列表都是旧的，不能收 */
export const restoreRunning = (r: RestoreState | undefined) =>
  !!r && RESTORE_STEPS.some((s) => r.steps[s]?.status === 'running')

export function unstick(r: RestoreState | undefined, why: string) {
  if (!r) return
  for (const s of RESTORE_STEPS) {
    const st = r.steps[s]
    if (st?.status === 'running') r.steps[s] = { ...st, status: 'failed', error: why }
  }
}
