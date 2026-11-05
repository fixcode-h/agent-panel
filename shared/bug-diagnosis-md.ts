/**
 * 诊断报告渲染成 Markdown（ADR 0045、0046）：审阅弹窗、交回父对话、对话里的卡片都用这一份。
 * 按阶段排小节（用户 2026-11-05 定的）：最上面一节「结论」写现在在哪一步、要用户做什么，
 * 论证阶段先放日志计划，根因阶段先放证据，方案阶段先放候选方案，验证阶段先放验证步骤；别的小节跟在后面。
 * 小节名是界面文案，走 t()
 */
import type { BugBlame, BugCollect, BugLevel, Diagnosis } from './bug-diagnosis-schema.ts'
import { KIND_TEXT, phaseOf } from './bug-phase.ts'
import { t } from './i18n.ts'

/** 责任类别在界面上的说法 */
export const blameLabel = (b: BugBlame) =>
  ({
    current: t('本次改动'),
    recent: t('近期变更'),
    legacy: t('历史遗留'),
    external: t('外部依赖'),
    environment: t('环境配置'),
    data: t('数据'),
    user: t('用户操作'),
    unknown: t('未确定'),
  })[b]

const levelLabel = (l: BugLevel) => ({ quick: t('快速'), standard: t('标准'), deep: t('深入') })[l]

/** 表格单元格：竖线和换行会打断表格 */
const cell = (v: string) =>
  v
    .replace(/\|/g, '\\|')
    .replace(/\s*\n\s*/g, ' ')
    .trim() || '—'
const table = (head: string[], rows: string[][]) =>
  rows.length
    ? [
        `| ${head.join(' | ')} |`,
        `| ${head.map(() => '---').join(' | ')} |`,
        ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
      ].join('\n')
    : ''

const sec = (title: string, body: string) => (body.trim() ? `## ${title}\n${body.trim()}` : '')

/** 这一版在哪一步、要用户做什么（结论那一节的第一行） */
function nextStep(d: Diagnosis): string {
  const phase = phaseOf(d)
  if (d.status === 'cancelled') return t('你取消了这次修复')
  if (d.status === 'superseded') return t('这一版已作废，看最新一版')
  if (d.status === 'questioned') return t('你提了意见，它在接着分析')
  if (d.status === 'answered') return phase === 'verify' ? t('你给了验证结果，它在分析') : t('你给了日志，它在分析')
  if (d.status === 'approved')
    return {
      evidence: t('你同意了，它在加日志'),
      cause: t('你同意了根因，它在设计修复方案'),
      plan: t('你确认了方案，它在修'),
      verify: t('你结束了验证，它在收尾'),
    }[phase]
  if (d.awaiting) return t('日志已经加好：按下面的步骤复现，把日志贴回来')
  return {
    evidence: t('同意后它按日志计划加临时日志；你手上已有日志也可以直接贴'),
    cause: t('同意根因它就开始设计修复方案；不同意就标出疑问或补充'),
    plan: t('确认方案它才开始改代码'),
    verify: t('已经修好：按下面的步骤复现验证，把日志贴回来；不想验证可以直接结束'),
  }[phase]
}

const PHASE_LABEL = () => ({ evidence: t('论证'), cause: t('根因'), plan: t('修复方案'), verify: t('验证') })

/** 复现步骤、日志在哪、过滤条件、每种结果说明什么 */
function collectSecs(c: BugCollect | undefined, verify: boolean): string[] {
  if (!c) return []
  return [
    sec(verify ? t('怎么验证') : t('怎么复现'), c.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')),
    sec(
      t('贴回什么'),
      [c.where && t('日志在：{where}', { where: c.where }), c.filter && t('过滤：`{filter}`', { filter: c.filter })]
        .filter(Boolean)
        .join('\n\n'),
    ),
    sec(verify ? t('看到什么算修好了') : t('每种结果说明什么'), c.expect),
  ]
}

export function diagnosisMarkdown(d: Diagnosis, prev?: Diagnosis, opts: { author?: boolean } = {}): string {
  const phase = phaseOf(d)
  const answers = prev
    ? d.answers
        .map((a) => {
          const n = prev.notes.find((x) => x.id === a.id)
          if (!n) return ''
          const quote = n.quote ? `「${n.quote.replace(/\s+/g, ' ').slice(0, 120)}」` : ''
          return `${a.id}. **${KIND_TEXT[n.kind]}**${quote}：${n.comment.trim()}\n   - 回答：${a.answer.trim()}`
        })
        .filter(Boolean)
        .join('\n')
    : ''
  const stack = d.stack.length
    ? d.stack
        .map((h, i) => `${i + 1}. \`${h.file}${h.line ? `:${h.line}` : ''}\` ${h.fn}${h.note ? ` — ${h.note}` : ''}`)
        .join('\n')
    : ''
  const kindText = { event: t('事件'), state: t('状态'), change: t('变更') }
  const timeline = table(
    [t('时间'), t('类别'), t('来源'), t('内容')],
    d.timeline.map((x) => [x.at, kindText[x.kind], x.source, x.abnormal ? `**${t('异常')}** ${x.text}` : x.text]),
  )
  const a = d.attribution
  const by = [opts.author === false ? '' : a?.author, a?.date].filter(Boolean).join('，')
  const attribution = a
    ? [
        a.change || a.title
          ? t('引入于 {change}{title}{by}', {
              change: a.change ? `\`${a.change}\`` : '',
              title: a.title ? `《${a.title}》` : '',
              by: by ? `（${by}）` : '',
            })
          : '',
        t('责任类别：{c}；依据：{how}；把握：{conf}', {
          c: blameLabel(a.category),
          how: { blame: t('逐行追溯'), bisect: t('二分定位'), diff: t('对比前一版'), log: t('日志'), none: t('无') }[
            a.how
          ],
          conf: { high: t('高'), medium: t('中'), low: t('低') }[a.confidence],
        }),
        a.note,
      ]
        .filter(Boolean)
        .join('\n\n')
    : ''
  const consistency = d.consistency.map((x) => `- ${x.observation} → ${x.explanation}`).join('\n')
  const hypoText = { confirmed: t('已证实'), excluded: t('已排除'), open: t('待验证') }
  const hypotheses = table(
    [t('假设'), t('结论'), t('依据')],
    d.hypotheses.map((h) => [h.text, hypoText[h.status], h.basis]),
  )
  const impact = table(
    [t('影响面'), t('怎么受影响'), t('怎么验证')],
    d.impact.map((x) => [x.area, x.effect, x.verify]),
  )
  const options = d.options
    .map((o) => {
      const chosen = o.id === d.chosen?.id
      const rows: [string, string][] = [
        [t('改法'), o.change],
        [t('要改的文件'), o.files.map((f) => `\`${f}\``).join('、')],
        [t('修得全'), o.covers],
        [t('漏了'), o.misses],
        [t('修改面'), o.surface],
        [t('风险'), o.risk],
        [t('契合'), o.fit],
        [t('可验证'), o.verifiable],
      ]
      return [
        `### ${t('方案 {id}', { id: o.id })}：${o.title}${chosen ? `（${t('选定')}）` : ''}`,
        ...rows.filter(([, v]) => v.trim()).map(([k, v]) => `- **${k}**：${v.trim()}`),
      ].join('\n')
    })
    .join('\n\n')
  const chosen = d.chosen
    ? [
        d.chosen.why && `**${t('为什么选方案 {id}', { id: d.chosen.id })}**：${d.chosen.why}`,
        d.chosen.whyNotOthers && `**${t('为什么不选别的')}**：${d.chosen.whyNotOthers}`,
      ]
        .filter(Boolean)
        .join('\n\n')
    : ''
  const logPlan = table(
    [t('编号'), t('位置'), t('打什么'), t('区分哪个假设')],
    d.logPlan.map((l) => [
      l.id,
      `\`${l.file}${l.line ? `:${l.line}` : ''}\`${l.fn ? ` ${l.fn}` : ''}`,
      l.print,
      l.hypothesis,
    ]),
  )
  const rootTitle = d.confirmed ? t('根因（已证实）') : t('根因（假设，还没证实）')
  const summary = [
    `**${PHASE_LABEL()[phase]}**：${nextStep(d)}`,
    d.rootCause.trim() && `**${rootTitle}**：${d.rootCause.trim().split('\n')[0]}`,
  ]
    .filter(Boolean)
    .join('\n\n')
  const awaiting = d.awaiting
    ? [d.awaiting.added.length ? `${t('加好的日志')}：${d.awaiting.added.map((x) => `\`${x}\``).join('、')}` : ''].join(
        '\n',
      )
    : ''
  const userLogs = [
    d.logs.trim() ? `\`\`\`\n${d.logs.trim()}\n\`\`\`` : '',
    d.logFiles.length ? `${t('附件')}：${d.logFiles.join('、')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
  const r = (phase === 'verify' && d.result) || undefined
  const result = r
    ? [
        r.reproBefore && `**${t('改前')}**：${r.reproBefore}`,
        r.reproAfter && `**${t('改后')}**：${r.reproAfter}`,
        r.regressionTests.length && `**${t('回归测试')}**：${r.regressionTests.map((x) => `\`${x}\``).join('、')}`,
        ...r.impactChecks.map((x) => `- ${x.area}：${x.command}${x.output ? ` → ${x.output.split('\n')[0]}` : ''}`),
      ]
        .filter(Boolean)
        .join('\n\n')
    : ''

  // 每个阶段先放用户这一步要看的，证据和背景跟在后面
  const facts = [
    sec(t('现象'), d.symptom),
    sec(t('复现'), d.repro),
    sec(t('位置和调用栈'), [d.location, stack].filter(Boolean).join('\n\n')),
    sec(t('时间线'), timeline),
    sec(t('证据链'), d.evidence),
  ]
  const cause = [
    sec(rootTitle, d.rootCause),
    sec(t('引入点'), attribution),
    sec(t('根因怎么解释每一条现象'), consistency),
    sec(t('假设'), hypotheses),
    sec(t('已排除'), d.excluded),
  ]
  const plan = [
    sec(t('影响面'), impact),
    sec(t('候选方案'), options),
    sec(t('选定'), chosen),
    sec(t('修复方案'), d.fix),
    sec(t('要改的文件'), d.files.map((f) => `- \`${f}\``).join('\n')),
    sec(t('影响和风险'), d.risk),
    sec(t('验证计划'), d.verify),
  ]
  const body =
    phase === 'evidence'
      ? [
          sec(t('等你复现'), awaiting),
          sec(t('日志计划'), logPlan),
          ...collectSecs(d.collect, false),
          sec(t('假设'), hypotheses),
          sec(t('下一步'), d.next),
          ...facts,
          sec(rootTitle, d.rootCause),
          sec(t('已排除'), d.excluded),
        ]
      : phase === 'cause'
        ? [...cause, ...facts]
        : phase === 'plan'
          ? [...plan, sec(rootTitle, d.rootCause), sec(t('证据链'), d.evidence), sec(t('引入点'), attribution)]
          : [
              ...collectSecs(d.collect, true),
              sec(t('修复结果'), result),
              sec(t('改动的文件'), d.files.map((f) => `- \`${f}\``).join('\n')),
              sec(rootTitle, d.rootCause),
            ]
  return [
    sec(t('结论'), summary),
    sec(t('回答上一版的意见'), answers),
    sec(t('你贴的日志'), userLogs),
    sec(t('级别'), `${levelLabel(d.level)}${d.levelNote ? `：${d.levelNote}` : ''}`),
    ...body,
    sec(t('交报告前已改动的文件'), d.before.map((f) => `- \`${f}\``).join('\n')),
  ]
    .filter(Boolean)
    .join('\n\n')
}
