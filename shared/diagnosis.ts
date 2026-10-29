import { z } from 'zod'
import { t } from './i18n.ts'

/**
 * 排查类分析（AI 排查、报错交给 AI）的结构化结论：回复末尾的 diagnosis 代码块（JSON），
 * AI 分析窗口右栏按它画「结论 / 证据 / 修复 / 相关文件」页签。
 * 结论是可选的：旧对话、没写结论块的回复照常只看对话；块写坏了（JSON 不合法、缺根因）
 * 不静默吞掉，右栏写明解析失败并把原文摆出来。
 */

export const DIAGNOSIS_LANG = 'diagnosis'

/** 把握：界面画成一条进度条 */
export const DiagnosisConfidence = z.enum(['high', 'medium', 'low'])
export type DiagnosisConfidence = z.infer<typeof DiagnosisConfidence>

/** 影响的严重度：none 是「不影响」这类说明，画成灰点 */
export const DiagnosisSeverity = z.enum(['high', 'medium', 'low', 'none'])
export type DiagnosisSeverity = z.infer<typeof DiagnosisSeverity>

const text = (max: number) => z.string().trim().max(max).catch('').default('')
/** 行号：AI 偶尔写成字符串，能读成正整数就收，读不出就当没给 */
const line = z.coerce.number().int().positive().optional().catch(undefined)

/** 单条写坏的（类型不对）跳过，不让一条挡住其余的 */
const listOf = <T extends z.ZodType>(item: T, max: number) =>
  z
    .array(z.unknown())
    .catch([])
    .default([])
    .transform((xs) =>
      xs
        .map((x) => item.safeParse(x))
        .filter((r) => r.success)
        .map((r) => r.data as z.infer<T>)
        .slice(0, max),
    )

const Impact = z.object({
  text: z.string().trim().min(1).max(300),
  severity: DiagnosisSeverity.catch('medium').default('medium'),
})

/**
 * 证据的角色：证据卡右上角的小标签。problem 是出问题的那段，reference 是对照的正确写法 / 口径，
 * repro 是复现出来的报错或输出，context 是旁证（例如「这里不受影响」）。写错或没写时不画标签
 */
export const EvidenceKind = z.enum(['problem', 'reference', 'repro', 'context'])
export type EvidenceKind = z.infer<typeof EvidenceKind>

const Evidence = z
  .object({
    kind: EvidenceKind.optional().catch(undefined),
    /** 文件路径（相对项目根）；命令输出类的证据没有文件 */
    file: text(300),
    line,
    /** 证据是命令输出时，跑的是哪条命令 */
    command: text(500),
    /** 代码或输出的摘录（几行以内） */
    excerpt: text(2000),
    /** 这条证据说明了什么 */
    note: text(500),
  })
  .refine((e) => !!(e.file || e.command || e.excerpt || e.note))

const Fix = z.object({
  file: text(300),
  line,
  /** 要做的改动，写到不看对话也能动手 */
  change: z.string().trim().min(1).max(1500),
  /** 可选：改前、改后的几行，右栏画成 -/+ 两段 */
  before: text(1500),
  after: text(1500),
})

export const Diagnosis = z.object({
  rootCause: z.object({
    /** 一句话的根因 */
    title: z.string().trim().min(1).max(300),
    detail: text(2000),
  }),
  confidence: DiagnosisConfidence.optional().catch(undefined),
  impacts: listOf(Impact, 12),
  evidence: listOf(Evidence, 20),
  fixes: listOf(Fix, 20),
  files: z
    .array(z.unknown())
    .catch([])
    .default([])
    .transform((xs) => [
      ...new Set(xs.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim())),
    ]),
})
export type Diagnosis = z.infer<typeof Diagnosis>
export type DiagnosisEvidence = Diagnosis['evidence'][number]
export type DiagnosisFix = Diagnosis['fixes'][number]

/** 解析结果：没写结论块是 null；写了但读不出来给出原文和原因，界面照原文显示 */
export type DiagnosisParse = { ok: true; value: Diagnosis } | { ok: false; raw: string; error: string }

const BLOCK = new RegExp('```' + DIAGNOSIS_LANG + '[^\\n]*\\n([\\s\\S]*?)```', 'g')

/** 回复里最后一个结论块 */
export function parseDiagnosis(text: string): DiagnosisParse | null {
  const last = [...text.matchAll(BLOCK)].at(-1)
  if (!last) return null
  const raw = last[1].trim()
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (e) {
    return { ok: false, raw, error: (e as Error).message }
  }
  const r = Diagnosis.safeParse(json)
  if (!r.success) return { ok: false, raw, error: z.prettifyError(r.error) }
  const d = r.data
  // 相关文件没写全时，把证据和修复里提到的文件补进来：页签上的数字和真正涉及的文件对得上
  const files = [...new Set([...d.files, ...d.evidence.map((e) => e.file), ...d.fixes.map((f) => f.file)])].filter(
    Boolean,
  )
  return { ok: true, value: { ...d, files } }
}

/**
 * 对话区里去掉结论块（右栏另外画）。只在读得出来时去掉：读不出来时原文留在对话里，
 * 右栏也会写明解析失败。正在输出、块还没写完时去掉到结尾，不把半截 JSON 铺出来
 */
export function stripDiagnosis(text: string) {
  if (!text.includes('```' + DIAGNOSIS_LANG)) return text
  const open = text.lastIndexOf('```' + DIAGNOSIS_LANG)
  const closed = text.indexOf('```', open + 3 + DIAGNOSIS_LANG.length) >= 0
  if (!closed) return text.slice(0, open).trimEnd()
  return parseDiagnosis(text)?.ok ? text.replace(BLOCK, '').trimEnd() : text
}

const at = (file: string, line?: number) => (line ? `${file}:${line}` : file)

/**
 * 「在当前对话里修」「开新任务修」发出去的那段话：根因 + 逐条修复建议 + 相关文件。
 * 发给 Agent 的提示词，不翻译
 */
export function diagnosisFixPrompt(d: Diagnosis, subject = '') {
  const fixes = d.fixes.map(
    (f, i) =>
      `${i + 1}. ${f.file ? `\`${at(f.file, f.line)}\`：` : ''}${f.change}${
        f.after ? `\n   改成：\n   \`\`\`\n${f.after.replace(/^/gm, '   ')}\n   \`\`\`` : ''
      }`,
  )
  return [
    `请按下面的排查结论修复${subject ? `「${subject}」` : '这个问题'}。`,
    '',
    `根因：${d.rootCause.title}`,
    ...(d.rootCause.detail ? [d.rootCause.detail] : []),
    '',
    ...(fixes.length ? ['修复建议：', ...fixes, ''] : []),
    ...(d.files.length ? [`相关文件：${d.files.join('、')}`, ''] : []),
    '先确认根因和现在的代码对得上再改，改动只限这个问题；改完跑相关的检查，最后说明改了什么、验证结果。',
  ].join('\n')
}

/** 「记成教训」的初稿：根因当标题，说明和修复要点当规则正文，用户在弹窗里再改 */
export function diagnosisLessonText(d: Diagnosis) {
  return [
    d.rootCause.title,
    d.rootCause.detail,
    ...d.fixes.map((f) => `- ${f.file ? `${at(f.file, f.line)}：` : ''}${f.change}`),
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * 「应用这 N 处修改」：把修复建议里的 before 原样换成 after。
 * 只认原文精确匹配、在文件里恰好出现一次的：找不到说明文件已经变了或 AI 没照抄，多处说明不知道改哪一处，
 * 这两种都逐条报原因，不猜、不悄悄跳过（服务端 server/files.ts 的 applyFixesInDir 和演示版共用这一份判定）
 */
export const FixApplyItem = z.object({
  file: z.string().max(300).default(''),
  before: z.string().max(1500).default(''),
  after: z.string().max(1500).default(''),
})
export type FixApplyItem = z.infer<typeof FixApplyItem>
export const FixApplyInput = z.object({ fixes: z.array(FixApplyItem).min(1).max(20) })

/** 每一处的结果，按请求里的顺序；失败的写明原因 */
export interface FixApplyResult {
  index: number
  file: string
  ok: boolean
  error?: string
}

/** 有文件、有改前原文、有改后内容才能一键应用；只写了改法的要人（或 Agent）动手 */
export const fixApplicable = (f: { file: string; before: string; after: string }) => !!(f.file && f.before && f.after)

/** 不重叠地数 needle 出现了几次（够判断「恰好一次」就停） */
function countOf(hay: string, needle: string, stop = 2) {
  let n = 0
  for (let i = hay.indexOf(needle); i >= 0 && n < stop; i = hay.indexOf(needle, i + needle.length)) n++
  return n
}

/** 一处修改落到文件内容上：成功给出新内容，失败给出给用户看的原因 */
export function replaceFix(
  content: string,
  fix: FixApplyItem,
): { ok: true; text: string } | { ok: false; error: string } {
  if (!fix.file) return { ok: false, error: t('没有写要改哪个文件') }
  if (!fix.before) return { ok: false, error: t('没有给出改前的原文，没法定位要改的地方') }
  if (!fix.after) return { ok: false, error: t('没有给出改后的内容') }
  let { before, after } = fix
  // AI 抄出来的原文都是 LF；文件是 CRLF 时按 CRLF 再找一次，换进去的内容也用 CRLF，不把文件改成混合换行
  if (!countOf(content, before) && content.includes('\r\n') && !before.includes('\r')) {
    before = before.replace(/\n/g, '\r\n')
    after = after.replace(/\r?\n/g, '\r\n')
  }
  const n = countOf(content, before)
  if (n === 0)
    return {
      ok: false,
      error: countOf(content, after)
        ? t('文件里找不到改前的原文，改后的内容已经在文件里了，可能已经改过')
        : t('文件里找不到改前的原文，文件可能已经变了，或者原文没有照抄'),
    }
  if (n > 1) return { ok: false, error: t('改前的原文在文件里出现了不止一处，不知道该改哪一处') }
  const at = content.indexOf(before)
  // 不用 String.replace：after 里的 $& 这类写法会被当成替换模式
  return { ok: true, text: content.slice(0, at) + after + content.slice(at + before.length) }
}

/** 写进排查提示词的「结论块」要求：放在回复末尾，界面按它画右栏 */
export function diagnosisPromptRules() {
  return [
    `回复的最后单独写一个代码块，语言名写 ${DIAGNOSIS_LANG}，内容是 JSON，把结论写成结构化的形式（面板会把它画成结论、证据、修复几栏；正文里照常用几句话说明）：`,
    '```' + DIAGNOSIS_LANG,
    JSON.stringify(
      {
        rootCause: { title: '一句话的根因', detail: '为什么会这样，两三句话' },
        confidence: 'high | medium | low',
        impacts: [{ text: '影响到什么', severity: 'high | medium | low | none' }],
        evidence: [
          {
            kind: 'problem | reference | repro | context',
            file: '相对项目根的路径',
            line: 42,
            excerpt: '相关的几行代码',
            note: '这段说明了什么',
          },
          { kind: 'repro', command: '跑过的命令', excerpt: '输出里关键的几行', note: '说明了什么' },
        ],
        fixes: [{ file: '要改的文件', line: 42, change: '具体改什么，写到不看对话也能动手', before: '', after: '' }],
        files: ['相关文件的路径'],
      },
      null,
      2,
    ),
    '```',
    '- 证据要是真的看过的：文件给路径和行号、命令给原命令和输出摘录，拿不准的不写；没查出根因时 confidence 写 low，并在 detail 里说明还缺什么。',
    '- evidence 的 kind 标出这条证据的角色：problem 是出问题的那段，reference 是对照的正确写法或口径，repro 是复现出来的报错或输出，context 是旁证；拿不准就不写 kind。',
    '- fixes 只写建议，不代表已经改了；before / after 可以留空，写的话只写几行。',
    '- 面板可以一键应用 before → after：before 必须从文件里原样复制（包括缩进），并且在那个文件里只出现一次；做不到原样就留空，只写 change。',
  ].join('\n')
}

/** 演示用的结论块：在线演示的假 Agent 回复带上它，右栏的页签和按钮在演示里也能看 */
export function demoDiagnosis(memory: boolean): Diagnosis {
  return memory
    ? {
        rootCause: {
          title: '内存大头在 CLI 子进程，不在面板本身',
          detail: '会话合计里九成是 Agent CLI 和它拉起的 MCP 进程；面板进程的占用稳定，没有随时间上涨。',
        },
        confidence: 'medium',
        impacts: [
          { text: '长时间开着的会话占用偏高', severity: 'medium' },
          { text: '已结束的子任务进程没有及时退出', severity: 'low' },
          { text: '不影响执行和数据', severity: 'none' },
        ],
        evidence: [
          {
            file: '',
            kind: 'repro',
            command: '进程列表（演示数据）',
            excerpt: 'claude      612 MB\nmcp-server  148 MB',
            note: '占用集中在 CLI 进程',
          },
          {
            kind: 'reference',
            file: 'shared/memory-analysis.ts',
            line: 1,
            command: '',
            excerpt: '',
            note: '进程归属的统计口径',
          },
        ],
        fixes: [
          { file: '', change: '在「对话进程」里清理已结束的子任务进程，再观察十分钟的曲线', before: '', after: '' },
        ],
        files: ['shared/memory-analysis.ts'],
      }
    : {
        rootCause: {
          title: '商品卡片直接调用 price.toFixed，价格为空时整个列表白屏',
          detail: '接口对下架商品返回 price: null，ProductCard 没有判空，渲染时抛错，错误冒泡到列表的根组件。',
        },
        confidence: 'high',
        impacts: [
          { text: '有下架商品时商品列表整页白屏', severity: 'high' },
          { text: '详情页的推荐位同样会报错', severity: 'medium' },
          { text: '不影响下单和购物车数据', severity: 'none' },
        ],
        evidence: [
          {
            kind: 'problem',
            file: 'src/components/ProductCard.tsx',
            line: 7,
            command: '',
            excerpt: '<div className="text-sm text-muted">￥{product.price.toFixed(2)}</div>',
            note: '没有判空',
          },
          {
            kind: 'repro',
            file: '',
            command: 'npm test',
            excerpt: "TypeError: Cannot read properties of null (reading 'toFixed')",
            note: '测试里复现的报错',
          },
          {
            kind: 'context',
            file: 'src/store/cart.ts',
            line: 11,
            command: '',
            excerpt: '',
            note: '购物车只存 productId，不受影响',
          },
        ],
        fixes: [
          {
            file: 'src/components/ProductCard.tsx',
            line: 7,
            change: '价格为空时显示「暂无报价」，不调用 toFixed',
            before: '￥{product.price.toFixed(2)}',
            after: "{product.price == null ? '暂无报价' : `￥${product.price.toFixed(2)}`}",
          },
          {
            file: 'src/components/ProductCard.tsx',
            line: 3,
            change: 'price 的类型改成 number | null',
            before: '',
            after: '',
          },
        ],
        files: ['src/components/ProductCard.tsx', 'src/store/cart.ts'],
      }
}
