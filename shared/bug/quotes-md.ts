/**
 * 诊断报告里原文那几节的 Markdown（设计稿 2026-11-10 第 4 节）：多段关键代码（行内高亮、行尾说明、临时日志行变淡）、
 * 日志和命令输出的原文引用、日志命中表、期望和实际、引入改动的 diff、修复前后对照。
 * 代码块的标记写在信息串里（start=48 marks=…），渲染在 web/src/lib/workflow-doc.ts
 */
import type { BugCollect, BugQuote, CodeRef, Diagnosis } from './diagnosis-schema.ts'
import { TEMP_LOG } from './cleanup.ts'
import { logHits, outcomeMatches, type LogHit } from './quotes.ts'
import { pastedLog } from './log-watch.ts'
import { codeTerms } from './terms.ts'
import { t } from '../i18n.ts'

/** 代码块里一行的标记：l 行号（文件里的真实行号），t 行内要高亮的原文，n 行尾说明，v 级别（dim 是临时日志行） */
export type LineMark = { l: number; t?: string; n?: string; v?: 'fault' | 'related' | 'skipped' | 'dim' }

/** 标记放进代码块信息串：URL 编码的 JSON，里面没有空白，不会打断信息串 */
export const marksAttr = (marks: LineMark[]) =>
  marks.length ? ` marks=${encodeURIComponent(JSON.stringify(marks))}` : ''

const fenceOf = (text: string) => (text.includes('```') ? '~~~~' : '```')
const langOf = (file: string) => /\.([A-Za-z0-9]+)$/.exec(file)?.[1]?.toLowerCase() || 'text'
const at = (file: string, a?: number, b?: number) => `\`${file}${a ? `:${a}${b && b !== a ? `-${b}` : ''}` : ''}\``

const ROLE = () => ({
  fault: t('出错点'),
  trigger: t('触发条件'),
  caller: t('调用方'),
  expected: t('对照的正确写法'),
})

/** 一段代码：快照里的那几行，出错的行、行内那几个字、临时日志行都标出来；没有快照只写位置 */
export function codeRefMd(r: CodeRef): string {
  const head = `**${r.id ? `${r.id} · ` : ''}${ROLE()[r.role]}** ${at(r.file, r.start, r.end)}`
  if (!r.snapshot) {
    const notes = r.marks
      .filter((m) => m.note || m.text)
      .map((m) => `- ${at(r.file, m.line)} ${m.text ? `\`${m.text}\`` : ''} ${m.note}`)
    return [head, ...notes].join('\n')
  }
  const lines = r.snapshot.text.split('\n')
  const marks: LineMark[] = lines.flatMap((l, i) =>
    l.includes(TEMP_LOG) ? [{ l: r.start + i, v: 'dim' as const, n: t('临时日志') }] : [],
  )
  for (const m of r.marks) marks.push({ l: m.line, t: m.text || undefined, n: m.note || undefined, v: m.level })
  const fence = fenceOf(r.snapshot.text)
  return `${head}\n\n${fence}${langOf(r.file)} start=${r.start}${marksAttr(marks)}\n${r.snapshot.text}\n${fence}`
}

/** 关键代码：出错点在前，其余按写的顺序 */
export function codeRefsMd(d: Pick<Diagnosis, 'codeRefs'>): string {
  const order = { fault: 0, trigger: 1, caller: 2, expected: 3 }
  return [...d.codeRefs]
    .sort((a, b) => order[a.role] - order[b.role])
    .map(codeRefMd)
    .join('\n\n')
}

/** 一条原文引用：日志、命令输出摆成代码块（关键值高亮）；描述画成引用块，标明「描述，不是原文」 */
export function quoteMd(q: BugQuote): string {
  if (q.kind === 'note') return `**${q.id}** ${t('描述（不是原文）')}\n\n> ${codeTerms(q.text).replace(/\n/g, '\n> ')}`
  // 出处（哪个文件、第几行）写在代码块外面，代码块里只放原文，不折行（用户 2026-11-13 报：塞进描述里折行、标识符变成一个个标签，看不清）
  const span = { a: q.start ?? '?', b: q.end ?? q.start ?? '?' }
  const where =
    q.kind !== 'log'
      ? t('命令输出')
      : q.file
        ? t('日志 {file} 第 {a}~{b} 行', { file: `\`${q.file}\``, ...span })
        : t('你贴的日志（报告 #{n}）第 {a}~{b} 行', { n: q.from ?? '?', ...span })
  const start = q.kind === 'log' && q.start ? q.start : 1
  const marks: LineMark[] = []
  q.text.split('\n').forEach((l, i) => {
    for (const h of q.highlight) if (h && l.includes(h)) marks.push({ l: start + i, t: h, v: 'related' })
  })
  const fence = fenceOf(q.text)
  return `**${q.id}** ${where}\n\n${fence}text start=${start}${marksAttr(marks)}\n${q.text}\n${fence}`
}

export const quotesMd = (d: Pick<Diagnosis, 'quotes'>) => d.quotes.map(quoteMd).join('\n\n')

/** 证据链一环引用的原文编号：报告上写成「原文：Q1、C1」，原文在「原文」一节 */
export const refsMd = (refs: string[]) => (refs.length ? `${t('原文')}：${refs.map((r) => `**${r}**`).join('、')}` : '')

/** 表格单元格：竖线和换行会打断表格 */
const cell = (v: string) =>
  codeTerms(v)
    .replace(/\|/g, '\\|')
    .replace(/\s*\n\s*/g, '<br>')
    .trim() || '—'

/** 日志命中表：日志计划的每一处在用户贴的日志里出现了几次、第一次在哪一行；没出现的加粗（常常就是关键证据） */
export function hitsMd(d: Pick<Diagnosis, 'logs' | 'logPlan'>): string {
  // 引用日志文件、写明从第几行看的不是日志正文：没有可数的（数了全是 0 次，反而误导）
  const logs = pastedLog(d.logs)
  if (!logs || !d.logPlan.length) return ''
  const hits = logHits(logs, d.logPlan)
  if (!hits.length) return ''
  const rows = hits.map((h) => [
    h.point.id,
    `${at(h.point.file, h.point.line)}`,
    h.count ? t('{n} 次', { n: h.count }) : `**${t('0 次')}**`,
    h.first ? `${t('第 {n} 行', { n: h.first.line })} \`${h.first.text.trim().replace(/`/g, "'")}\`` : '—',
  ])
  return [
    `| ${[t('编号'), t('位置'), t('出现'), t('第一次')].join(' | ')} |`,
    '| --- | --- | --- | --- |',
    ...rows.map((r) => `| ${r.map((x) => x.replace(/\|/g, '\\|')).join(' | ')} |`),
  ].join('\n')
}

/** 用户贴的日志：带行号，命中日志计划的行（每处第一次）在行内标出编号 */
export function logBlockMd(logs: string, plan: Diagnosis['logPlan']): string {
  const hits: LogHit[] = plan.length ? logHits(logs, plan) : []
  const marks: LineMark[] = hits.flatMap((h) =>
    h.first ? [{ l: h.first.line, n: h.point.id, v: 'related' as const }] : [],
  )
  const fence = fenceOf(logs)
  return `${fence}text start=1${marksAttr(marks)}\n${logs}\n${fence}`
}

/** 结果怎么判：「看到 → 说明」的表；用户贴了日志、写了可核对条件时多一列「这次」（面板对上的打 ✓） */
export function outcomesMd(c: BugCollect | undefined, d?: Pick<Diagnosis, 'logs' | 'logPlan'>): string {
  if (!c?.outcomes.length) return ''
  const logs = d ? pastedLog(d.logs) : ''
  const judged = logs && d?.logPlan.length ? outcomeMatches(c, logHits(logs, d.logPlan)) : []
  const show = judged.some((x) => x !== undefined)
  const head = show ? [t('看到'), t('说明'), t('这次')] : [t('看到'), t('说明')]
  const rows = c.outcomes.map((o, i) => {
    const row = [o.see, o.means]
    if (!show) return row
    const j = judged[i]
    return [...row, j === undefined ? '—' : j ? `**✓ ${t('对上了')}**` : t('没对上')]
  })
  const none = show && !judged.some((x) => x === true)
  return [
    `| ${head.join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
    none ? `\n> [!WARNING]\n> ${t('这次的日志一项都没对上：结果在预料之外，看看路标停在哪一步')}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/** 期望和实际：一行一个值 */
export function expectMd(d: Pick<Diagnosis, 'expectVsActual'>): string {
  if (!d.expectVsActual.length) return ''
  return [
    `| ${[t('什么'), t('应该是'), t('实际'), t('原文')].join(' | ')} |`,
    '| --- | --- | --- | --- |',
    ...d.expectVsActual.map((x) => `| ${[x.what, x.expected, `**${x.actual}**`, x.ref].map(cell).join(' | ')} |`),
  ].join('\n')
}

/** 复现用的是什么：构造的数据只算推演 */
export function reproKindMd(d: Pick<Diagnosis, 'reproKind'>): string {
  if (!d.reproKind) return ''
  if (d.reproKind === 'constructed')
    return `> [!WARNING]\n> ${t('**推演**：这次复现用的是它构造的数据，只能说明「这样也能出现」，不能当作排除别的假设的证据')}`
  return `**${t('复现方式')}**：${d.reproKind === 'user' ? t('用你的数据 / 环境') : t('测试用例')}`
}

/** diff 原文摆成 diff 代码块（增删行着色） */
/** file 写进信息串（file=，URL 编码）：界面顶栏写文件名、按语言着色（web/src/lib/diff-html.ts） */
export const diffBlock = (diff: string, file?: string) =>
  `${fenceOf(diff)}diff${file ? ` file=${encodeURIComponent(file)}` : ''}\n${diff.replace(/\n$/, '')}\n${fenceOf(diff)}`

export const attributionDiffMd = (diff: string | undefined) =>
  diff?.trim() ? `**${t('引入的那段改动')}**\n\n${diffBlock(diff)}` : ''

/** 验证页：出错点那几段代码修前（根因那一版的快照）和现在的对照 */
export const fixDiffsMd = (d: Pick<Diagnosis, 'fixDiffs'>) =>
  d.fixDiffs.map((x) => `**${x.id}** ${at(x.file)}\n\n${diffBlock(x.diff, x.file)}`).join('\n\n')
