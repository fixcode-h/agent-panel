/**
 * 诊断报告渲染成 Markdown（ADR 0045、0046）：审阅弹窗、交回父对话、对话里的卡片都用这一份。
 * 按阶段排小节（用户 2026-11-05 定的）：最上面一节「结论」写现在在哪一步、要用户做什么，
 * 论证阶段先放日志计划，根因阶段先放证据，方案阶段先放候选方案，验证阶段先放验证步骤；别的小节跟在后面。
 * 2026-11-05 用户又要求精简：空的、重复的小节不写（级别并进结论，根因只在一处写全），
 * 能成表的用表格（调用路径、方案比较、验证结果），一段里写了 ①②③、1) 2)、← 链的拆成一行一条（prose）。
 * 小节名是界面文案，走 t()
 */
import type { BugBlame, BugCollect, BugLevel, Diagnosis } from './bug-diagnosis-schema.ts'
import { causeInPlan, KIND_TEXT, logFilesOf, normPath, phaseOf } from './bug-phase.ts'
import { prose } from './bug-prose.ts'
import { codeTerms, marked } from './bug-terms.ts'
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

/** 表格单元格：文件名、函数名补上反引号（bug-terms.ts）；竖线和换行会打断表格，换行换成 <br> 保住分行 */
const cell = (v: string) =>
  codeTerms(v)
    .replace(/\|/g, '\\|')
    .trim()
    .replace(/\s*\n\s*/g, '<br>') || '—'
const table = (head: string[], rows: string[][]) =>
  rows.length
    ? [
        `| ${head.join(' | ')} |`,
        `| ${head.map(() => '---').join(' | ')} |`,
        ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
      ].join('\n')
    : ''

const sec = (title: string, body: string) => (body.trim() ? `## ${title}\n${body.trim()}` : '')
/**
 * 提示块（> [!WARNING] 这类，渲染成带色条的框）：要用户这一步做的、风险、没经同意就改了的文件，
 * 不能和普通正文一个颜色（用户 2026-11-07 要求醒目）
 */
const alert = (kind: 'important' | 'warning' | 'caution', body: string) =>
  body.trim()
    ? [
        `> [!${kind.toUpperCase()}]`,
        ...body
          .trim()
          .split('\n')
          .map((l) => `> ${l}`.trimEnd()),
      ].join('\n')
    : ''
/**
 * 位置写全路径加行号：渲染时画成文件标记，只显示「文件名:行」，目录在悬停卡片上，点了打开到那一行
 * （原来只写文件名，按 2026-11-07 的规则单独的文件名是行内代码、点不开）
 */
const at = (file: string, line?: number) => `\`${file}${line ? `:${line}` : ''}\``

/** Agent 写的一段文字：拆行（prose）、补代码标记、标出要注意的行（bug-terms.ts） */
const px = (text: string | undefined) => marked(prose(text))

/** 这一版在哪一步、要用户做什么（结论那一节的第一行） */
function nextStep(d: Diagnosis, withCause = false): string {
  const phase = phaseOf(d)
  if (d.status === 'cancelled') return t('你取消了这次修复')
  if (d.status === 'superseded') return t('这份报告已被后面交的取代，看最新的')
  if (d.status === 'questioned') return t('你提了意见，它在接着分析')
  if (d.status === 'answered') return phase === 'verify' ? t('你给了验证结果，它在分析') : t('你给了日志，它在分析')
  if (d.status === 'approved')
    return {
      evidence: t('你同意了，它在加日志'),
      cause: t('你同意了根因，它在设计修复方案'),
      plan: withCause ? t('你同意了根因和方案，它在修') : t('你确认了方案，它在修'),
      verify: t('你结束了验证，它在收尾'),
    }[phase]
  if (d.awaiting) return t('日志已经加好：按下面的步骤复现，把日志贴回来')
  return {
    evidence: t('同意后它按日志计划加临时日志；你手上已有日志也可以直接贴'),
    cause: t('同意根因它就开始设计修复方案；不同意就标出疑问或补充'),
    plan: withCause ? t('快速级别：根因和修复方案一起确认，确认了它才开始改代码') : t('确认方案它才开始改代码'),
    verify: t('已经修好：按下面的步骤复现验证，把日志贴回来；不想验证可以直接结束'),
  }[phase]
}

const PHASE_LABEL = () => ({ evidence: t('论证'), cause: t('根因'), plan: t('修复方案'), verify: t('验证') })

/** 复现步骤一步一行，日志在哪、过滤条件跟在步骤后面；每种结果说明什么（验证：看到什么算修好了）另起一节 */
function collectSecs(c: BugCollect | undefined, verify: boolean): string[] {
  if (!c) return []
  const where = [
    c.where && t('日志在：{where}', { where: c.where }),
    c.filter && t('过滤：`{filter}`', { filter: c.filter }),
  ].filter(Boolean)
  return [
    sec(
      verify ? t('怎么验证') : t('怎么复现'),
      [c.steps.map((s, i) => `${i + 1}. ${codeTerms(s)}`).join('\n'), where.map((w) => `- ${w}`).join('\n')]
        .filter(Boolean)
        .join('\n\n'),
    ),
    sec(verify ? t('看到什么算修好了') : t('每种结果说明什么'), px(c.expect)),
  ]
}

/** 用户贴的日志：只贴了一个文件路径的写成日志文件，不当成日志正文摆成代码块 */
function userLogsOf(d: Diagnosis): string {
  const text = d.logs.trim()
  const path = /^["'`]?((?:[A-Za-z]:[\\/]|\/|~[\\/])[^"'`\n]+?\.(?:log|txt|json|csv|out))["'`]?(.*)$/s.exec(text)
  const files = [...(path ? [path[1]] : []), ...d.logFiles]
  const rest = path ? path[2].trim() : text
  return [
    files.length ? `${t('日志文件')}：${files.map((x) => `\`${x}\``).join('、')}` : '',
    rest && (path ? rest : `\`\`\`\n${rest}\n\`\`\``),
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** 候选方案并排比较：一列一个方案，一行一项（改法、修得全、风险……），空的那一项整行不摆 */
function optionsTable(d: Diagnosis): string {
  if (!d.options.length) return ''
  const head = [
    '',
    ...d.options.map((o) => `${t('方案 {id}', { id: o.id })}${o.id === d.chosen?.id ? `（${t('选定')}）` : ''}`),
  ]
  const rows: [string, (o: Diagnosis['options'][number]) => string][] = [
    [t('做法'), (o) => o.title],
    [t('改法'), (o) => o.change],
    [t('要改的文件'), (o) => o.files.map((f) => `\`${f}\``).join('<br>')],
    [t('修得全'), (o) => o.covers],
    [t('漏了'), (o) => o.misses],
    [t('修改面'), (o) => o.surface],
    [t('风险'), (o) => o.risk],
    [t('契合'), (o) => o.fit],
    [t('可验证'), (o) => o.verifiable],
  ]
  return table(
    head,
    rows
      .filter(([, get]) => d.options.some((o) => get(o).trim()))
      .map(([k, get]) => [`**${k}**`, ...d.options.map((o) => get(o))]),
  )
}

/** 交报告前就动过、又不在用户已同意范围（加日志的文件、确认过的方案）里的文件；面板的临时目录不算 */
function earlyFiles(d: Diagnosis, list: Diagnosis[] | undefined): string[] {
  const upto = list ? list.slice(0, Math.max(0, list.indexOf(d))) : []
  const ok = new Set(
    [...logFilesOf(upto), ...upto.filter((x) => x.status === 'approved').flatMap((x) => x.files)].map(normPath),
  )
  return d.before.filter((f) => !/^([A-Za-z]:)?[\\/]/.test(f) && !ok.has(normPath(f)))
}

export function diagnosisMarkdown(
  d: Diagnosis,
  prev?: Diagnosis,
  /** author：引入点写不写作者；list：全部版本，用来算「交报告前已改动的文件」里哪些是用户没同意过的 */
  opts: { author?: boolean; list?: Diagnosis[] } = {},
): string {
  const phase = phaseOf(d)
  // 快速级别根因和方案合成的一版：根因那几节也是这一版要审的
  const withCause = !!opts.list && causeInPlan(d, opts.list)
  const answers = prev
    ? d.answers
        .map((a) => {
          const n = prev.notes.find((x) => x.id === a.id)
          if (!n) return ''
          const quote = n.quote ? `「${n.quote.replace(/\s+/g, ' ').slice(0, 120)}」` : ''
          return `${a.id}. **${KIND_TEXT[n.kind]}**${quote}：${n.comment.trim()}\n   - 回答：${codeTerms(a.answer.trim())}`
        })
        .filter(Boolean)
        .join('\n')
    : ''
  const stack = table(
    ['#', t('位置'), t('函数'), t('做了什么')],
    d.stack.map((h, i) => [String(i + 1), at(h.file, h.line), h.fn, h.note ?? '']),
  )
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
        px(a.note),
      ]
        .filter(Boolean)
        .join('\n\n')
    : ''
  const consistency = table(
    [t('现象'), t('怎么解释')],
    d.consistency.map((x) => [x.observation, x.explanation]),
  )
  // 已证实、待验证加粗：表里一眼看出哪条成立、哪条还悬着；已排除的保持普通字
  const hypoText = { confirmed: `**${t('已证实')}**`, excluded: t('已排除'), open: `**${t('待验证')}**` }
  const hypotheses = table(
    [t('假设'), t('结论'), t('依据')],
    d.hypotheses.map((h) => [h.id ? `${h.id} ${h.text}` : h.text, hypoText[h.status], h.basis]),
  )
  const impact = table(
    [t('影响面'), t('怎么受影响'), t('怎么验证')],
    d.impact.map((x) => [x.area, x.effect, x.verify]),
  )
  const chosen = d.chosen
    ? [
        d.chosen.why && `**${t('为什么选方案 {id}', { id: d.chosen.id })}**：${codeTerms(d.chosen.why)}`,
        d.chosen.whyNotOthers && `**${t('为什么不选别的')}**：${codeTerms(d.chosen.whyNotOthers)}`,
      ]
        .filter(Boolean)
        .join('\n\n')
    : ''
  const logPlan = table(
    [t('编号'), t('位置'), t('打什么'), t('区分哪个假设')],
    d.logPlan.map((l) => [l.id, `${at(l.file, l.line)}${l.fn ? ` ${l.fn}` : ''}`, l.print, l.hypothesis]),
  )
  const rootTitle = d.confirmed ? t('根因（已证实）') : t('根因（假设，还没证实）')
  const root = d.rootCause.trim()
  const rootFirst = root.split('\n')[0]
  // 根因只有一行、结论里已经写全了：后面不再单列一节（根因那一版例外，根因就是这一版要审的）
  const rootSec = phase === 'cause' || withCause || root !== rootFirst ? sec(rootTitle, px(root)) : ''
  // 结论第一行：这一步要用户做的，等用户决定时画成「重要」提示块，别的状态（在分析、已取代）照常
  const step = `**${PHASE_LABEL()[phase]}**：${nextStep(d, withCause)}`
  const summary = [
    d.status === 'pending' ? alert('important', step) : step,
    phase !== 'cause' && !withCause && root && `**${rootTitle}**：${codeTerms(rootFirst)}`,
    `**${t('级别')}**：${levelLabel(d.level)}${d.levelNote ? `（${d.levelNote}）` : ''}`,
  ]
    .filter(Boolean)
    .join('\n\n')
  const awaiting = d.awaiting?.added.length
    ? `${t('加好的日志')}：\n${d.awaiting.added.map((x) => `- \`${x}\``).join('\n')}`
    : ''
  const r = (phase === 'verify' && d.result) || undefined
  const result = r
    ? [
        table(
          ['', t('输出')],
          [
            [`**${t('改前')}**`, r.reproBefore],
            [`**${t('改后')}**`, r.reproAfter],
          ].filter(([, v]) => v.trim()),
        ),
        table(
          [t('影响面'), t('怎么验证'), t('结果')],
          r.impactChecks.map((x) => [x.area, x.command, x.output]),
        ),
        r.regressionTests.length &&
          `**${t('回归测试')}**：\n${r.regressionTests.map((x) => `- ${codeTerms(x)}`).join('\n')}`,
        r.runs && `**${t('跑了几次')}**：${r.runs}`,
      ]
        .filter(Boolean)
        .join('\n\n')
    : ''

  // 每个阶段先放用户这一步要看的，证据和背景跟在后面
  const facts = [
    sec(t('现象'), px(d.symptom)),
    sec(t('复现'), px(d.repro)),
    sec(t('位置和调用路径'), [px(d.location), stack].filter(Boolean).join('\n\n')),
    sec(t('时间线'), timeline),
    sec(t('证据链'), px(d.evidence)),
  ]
  const files = d.files.map((f) => `- \`${f}\``).join('\n')
  const body =
    phase === 'evidence'
      ? [
          sec(t('等你复现'), awaiting),
          sec(t('日志计划'), logPlan),
          ...collectSecs(d.collect, false),
          sec(t('假设'), hypotheses),
          sec(t('下一步'), px(d.next)),
          ...facts,
          rootSec,
          sec(t('已排除'), px(d.excluded)),
        ]
      : phase === 'cause'
        ? [
            rootSec,
            ...facts,
            sec(t('引入点'), attribution),
            sec(t('根因怎么解释每一条现象'), consistency),
            sec(t('假设'), hypotheses),
            sec(t('已排除'), px(d.excluded)),
            // 提前写好的修法只是草案：这一版只确认根因（实测用户以为点「同意根因」就开始修）
            sec(
              t('修复方案草案（这一版不确认，同意根因后另交一版）'),
              [optionsTable(d), px(d.fix)].filter(Boolean).join('\n\n'),
            ),
          ]
        : phase === 'plan' && withCause
          ? [
              rootSec,
              sec(t('证据链'), px(d.evidence)),
              sec(t('位置和调用路径'), [px(d.location), stack].filter(Boolean).join('\n\n')),
              sec(t('候选方案'), optionsTable(d)),
              sec(t('选定'), chosen),
              sec(t('修复方案'), px(d.fix)),
              sec(t('要改的文件'), files),
              sec(t('影响面'), impact),
              sec(t('影响和风险'), alert('warning', px(d.risk))),
              sec(t('验证计划'), px(d.verify)),
              sec(t('现象'), px(d.symptom)),
              sec(t('引入点'), attribution),
            ]
          : phase === 'plan'
            ? [
                sec(t('候选方案'), optionsTable(d)),
                sec(t('选定'), chosen),
                sec(t('修复方案'), px(d.fix)),
                sec(t('要改的文件'), files),
                sec(t('影响面'), impact),
                sec(t('影响和风险'), alert('warning', px(d.risk))),
                sec(t('验证计划'), px(d.verify)),
                rootSec,
                sec(t('证据链'), px(d.evidence)),
                sec(t('位置和调用路径'), stack),
                sec(t('引入点'), attribution),
              ]
            : [...collectSecs(d.collect, true), sec(t('修复结果'), result), sec(t('改动的文件'), files), rootSec]
  const early = earlyFiles(d, opts.list)
  return [
    sec(t('结论'), summary),
    sec(t('回答上一轮的意见'), answers),
    sec(t('你贴的日志'), userLogsOf(d)),
    ...body,
    sec(
      t('交报告前已改动的文件'),
      alert(
        'caution',
        early.length ? [t('这些文件不在你同意过的范围里：'), ...early.map((f) => `- \`${f}\``)].join('\n') : '',
      ),
    ),
  ]
    .filter(Boolean)
    .join('\n\n')
}
