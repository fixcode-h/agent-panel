/**
 * 诊断报告渲染（ADR 0045、0046）。按用户 2026-11-07 确认的设计稿「诊断报告各步骤内容」排：
 * - 最上面是决策卡（bug-diagnosis-card.ts）：现在在哪一步、一句话结论、要你做什么、要注意；
 * - 然后是「这一步要审的」（main）：每一步不同，2~4 节，默认展开；
 * - 最后是「依据和背景」（background）：现象、时间线、调用路径、已排除……审阅弹窗里默认收起。
 * 同一件事只写在一处：根因全文只在根因页，方案、验证页在决策卡上引用一行。
 * 能成表的用表格，一段里写了 ①②③、1) 2)、← 链的拆成一行一条（prose），文件名、函数名补代码标记（bug-terms.ts）。
 * 小节名是界面文案，走 t()
 */
import type { BugBlame, BugCollect, Diagnosis, Grade } from './bug-diagnosis-schema.ts'
import { cardMarkdown, diagnosisCard, earlyFiles, fillDiagnosis, type DiagnosisCard } from './bug-diagnosis-card.ts'
import { causeInPlan, KIND_TEXT, logFilesOf, phaseOf } from './bug-phase.ts'
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

/** 一节：这一步要审的用 ##，收起的背景里用 ###（目录里缩在「依据和背景」下面） */
const sec = (title: string, body: string, level = 2) =>
  body.trim() ? `${'#'.repeat(level)} ${title}\n${body.trim()}` : ''
/** 提示块（> [!WARNING] 这类，渲染成带色条的框）：风险、没经同意就改了的文件，不能和普通正文一个颜色 */
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
/** 位置写全路径加行号：渲染时画成文件标记，只显示「文件名:行」，目录在悬停卡片上，点了打开到那一行 */
const at = (file: string, line?: number) => `\`${file}${line ? `:${line}` : ''}\``

/** Agent 写的一段文字：拆行（prose）、补代码标记、标出要注意的行（bug-terms.ts） */
const px = (text: string | undefined) => marked(prose(text))

const PHASE_LABEL = () => ({ evidence: t('论证'), cause: t('根因'), plan: t('修复方案'), verify: t('验证') })

/** 复现步骤一步一行，日志在哪、过滤条件跟在步骤后面 */
function stepsOf(c: BugCollect | undefined): string {
  if (!c) return ''
  const where = [
    c.where && t('日志在：{where}', { where: codeTerms(c.where) }),
    c.filter && t('过滤：`{filter}`', { filter: c.filter }),
  ].filter(Boolean)
  return [c.steps.map((s, i) => `${i + 1}. ${codeTerms(s)}`).join('\n'), where.map((w) => `- ${w}`).join('\n')]
    .filter(Boolean)
    .join('\n\n')
}

/** 结果怎么判：「看到 → 说明」的表；只写了一段文字的旧档案照原样显示 */
const outcomesOf = (c: BugCollect | undefined) =>
  !c
    ? ''
    : c.outcomes.length
      ? table(
          [t('看到'), t('说明')],
          c.outcomes.map((o) => [o.see, o.means]),
        )
      : px(c.expect)

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

/** 方案比较一格的记号：✓ 好、⚠ 有代价、✗ 不满足 */
const MARK: Record<Grade, string> = { good: '✓ ', cost: '⚠ ', bad: '✗ ' }

/**
 * 候选方案并排比较：一列一个方案，一行一项，空的那一项整行不摆；每格开头按 grades 带记号。
 * 选定方案写了「具体改动」时，改法和要改的文件不再在表里重复
 */
function optionsTable(d: Diagnosis): string {
  if (!d.options.length) return ''
  const head = [
    '',
    ...d.options.map((o) => `${t('方案 {id}', { id: o.id })}${o.id === d.chosen?.id ? `（${t('选定')}）` : ''}`),
  ]
  type O = Diagnosis['options'][number]
  const g = (o: O, k: keyof O['grades'], v: string) => (v.trim() && o.grades[k] ? MARK[o.grades[k]] + v : v)
  const rows: [string, (o: O) => string][] = [
    [t('做法'), (o) => o.title],
    ...(d.changes.length
      ? []
      : ([
          [t('改法'), (o: O) => o.change],
          [t('要改的文件'), (o: O) => o.files.map((f) => `\`${f}\``).join('<br>')],
        ] as [string, (o: O) => string][])),
    [t('修得全'), (o) => g(o, 'covers', o.covers)],
    [t('漏了'), (o) => g(o, 'misses', o.misses)],
    [t('修改面'), (o) => g(o, 'surface', o.surface)],
    [t('风险'), (o) => g(o, 'risk', o.risk)],
    [t('契合'), (o) => g(o, 'fit', o.fit)],
    [t('可验证'), (o) => g(o, 'verifiable', o.verifiable)],
  ]
  return table(
    head,
    rows
      .filter(([, get]) => d.options.some((o) => get(o).trim()))
      .map(([k, get]) => [`**${k}**`, ...d.options.map((o) => get(o))]),
  )
}

/** 证据链：三环一环一条，证据跟在下面；只有一段文字的旧档案照原样显示 */
function chainOf(d: Diagnosis): string {
  if (!d.chain.length) return px(d.evidence)
  const name = { trigger: t('触发'), fault: t('出错点'), symptom: t('现象') }
  const lack = (['trigger', 'fault', 'symptom'] as const).filter((s) => !d.chain.some((x) => x.step === s))
  return [
    d.chain
      .map(
        (x) =>
          `- **${name[x.step]}**：${codeTerms(x.text)}${x.proof.trim() ? `\n  - ${t('证据')}：${codeTerms(x.proof)}` : ''}`,
      )
      .join('\n'),
    lack.length && alert('caution', t('证据链缺了：{steps}', { steps: lack.map((s) => name[s]).join('、') })),
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** 关键代码：面板从工作区读出来的那几行（snippet），行号从真实行开始，出错那行标出来 */
function codeOf(d: Diagnosis, snippet?: string): string {
  const r = d.codeRef
  if (!r?.file) return ''
  const loc = `${t('出错位置')}：${at(r.file, r.mark ?? r.start)}`
  if (!snippet) return loc
  const lang = /\.([A-Za-z0-9]+)$/.exec(r.file)?.[1]?.toLowerCase() || 'text'
  const fence = snippet.includes('```') ? '~~~~' : '```'
  return `${loc}\n\n${fence}${lang} start=${r.start}${r.mark ? ` mark=${r.mark}` : ''}\n${snippet.replace(/\n$/, '')}\n${fence}`
}

/** 具体改动：一个文件一行写改什么；没写 changes 的旧档案是修法一段文字加文件列表 */
function changesOf(d: Diagnosis): string {
  if (d.changes.length)
    return table(
      [t('文件'), t('改什么')],
      d.changes.map((c) => [`${at(c.file)}${c.isNew ? ` **${t('新增')}**` : ''}`, c.what]),
    )
  return [px(d.fix), d.files.map((f) => `- \`${f}\``).join('\n')].filter(Boolean).join('\n\n')
}

export interface DiagnosisViewOpts {
  /** 引入点写不写作者（设置里的开关） */
  author?: boolean
  /** 全部版本：算「交报告前已改动的文件」、快速级别合成的一版、第几轮 */
  list?: Diagnosis[]
  /** 关键代码那几行（审阅弹窗从工作区读来） */
  snippet?: string
  /** 对话目前实际改动的文件：验证页和方案对比 */
  changed?: string[]
}

export interface DiagnosisView {
  card: DiagnosisCard
  /** 这一步要审的 */
  main: string
  /** 依据和背景（### 小节） */
  background: string
}

export function diagnosisView(d: Diagnosis, prev?: Diagnosis, opts: DiagnosisViewOpts = {}): DiagnosisView {
  d = fillDiagnosis(d)
  if (prev) prev = fillDiagnosis(prev)
  const phase = phaseOf(d)
  // 快速级别根因和方案合成的一版：根因那几节也是这一版要审的
  const withCause = !!opts.list && causeInPlan(d, opts.list)
  const card = diagnosisCard(d, opts)
  const stance = { adopted: t('已采纳'), explained: t('已解释'), disagree: t('不同意') }
  const answers = prev
    ? d.answers
        .map((a) => {
          const n = prev.notes.find((x) => x.id === a.id)
          if (!n) return ''
          const quote = n.quote ? `「${n.quote.replace(/\s+/g, ' ').slice(0, 120)}」` : ''
          const how = a.stance ? `（**${stance[a.stance]}**）` : ''
          return `${a.id}. **${KIND_TEXT[n.kind]}**${quote}：${n.comment.trim()}\n   - ${t('回答')}${how}：${codeTerms(a.answer.trim())}`
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
          c: `**${blameLabel(a.category)}**`,
          how: { blame: t('逐行追溯'), bisect: t('二分定位'), diff: t('对比前一版'), log: t('日志'), none: t('无') }[
            a.how
          ],
          conf: `**${{ high: t('高'), medium: t('中'), low: t('低') }[a.confidence]}**`,
        }),
        px(a.note),
      ]
        .filter(Boolean)
        .join('\n\n')
    : ''
  const consistency = table(
    [t('现象'), t('怎么解释')],
    d.consistency.map((x) => [x.observation, x.explanation || `**${t('解释不了')}**`]),
  )
  // 已证实、待验证加粗：表里一眼看出哪条成立、哪条还悬着；已排除的保持普通字。
  // 第 2 轮起多一列「这轮变化」：和上一份的假设表比，不用 Agent 另写
  const hypoText = { confirmed: `**${t('已证实')}**`, excluded: t('已排除'), open: `**${t('待验证')}**` }
  const before = new Map((prev?.hypotheses ?? []).filter((h) => h.id).map((h) => [h.id, h.status]))
  const moved = d.hypotheses.some((h) => h.id && before.has(h.id) && before.get(h.id) !== h.status)
  const delta = (h: Diagnosis['hypotheses'][number]) => {
    const was = h.id ? before.get(h.id) : undefined
    if (!h.id || !prev?.hypotheses.length) return ''
    if (!was) return t('新增')
    return was === h.status
      ? ''
      : t('{from} → {to}', { from: hypoText[was].replace(/\*/g, ''), to: hypoText[h.status] })
  }
  const showDelta = moved || (!!prev?.hypotheses.length && d.hypotheses.some((h) => h.id && !before.has(h.id)))
  const hypotheses = table(
    showDelta ? [t('假设'), t('结论'), t('这轮变化'), t('依据')] : [t('假设'), t('结论'), t('依据')],
    d.hypotheses.map((h) => {
      const name = h.id ? `${h.id} ${h.text}` : h.text
      const row = [h.status === 'excluded' ? `~~${name}~~` : name, hypoText[h.status]]
      return showDelta ? [...row, delta(h), h.basis] : [...row, h.basis]
    }),
  )
  const impact = [
    table(
      [t('影响面'), t('怎么受影响'), t('怎么验证')],
      d.impact.map((x) => [x.area, x.effect, x.verify]),
    ),
    px(d.verify),
  ]
    .filter(Boolean)
    .join('\n\n')
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
    d.logPlan.map((l) => [
      l.id,
      `${at(l.file, l.line)}${l.fn ? ` \`${l.fn}\`` : ''}`,
      l.print.includes('`') ? l.print : `\`${l.print}\``,
      l.hypothesis,
    ]),
  )
  const rootTitle = d.confirmed ? t('根因（已证实）') : t('根因（假设，还没证实）')
  const root = [px(d.rootCause), codeOf(d, opts.snippet)].filter(Boolean).join('\n\n')
  const location = [px(d.location), stack].filter(Boolean).join('\n\n')
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
          r.impactChecks.map((x) => [x.area, x.command, x.output || `**${t('没测')}**`]),
        ),
        r.regressionTests.length &&
          `**${t('回归测试')}**：\n${r.regressionTests.map((x) => `- ${codeTerms(x)}`).join('\n')}`,
        r.runs && `**${t('跑了几次')}**：${r.runs}`,
      ]
        .filter(Boolean)
        .join('\n\n')
    : ''
  const early = earlyFiles(d, opts.list)
  const earlySec = sec(
    t('交报告前已改动的文件'),
    alert(
      'caution',
      early.length ? [t('这些文件不在你同意过的范围里：'), ...early.map((f) => `- \`${f}\``)].join('\n') : '',
    ),
  )
  // 拿到上一轮的日志后又交的论证：next 写的是「上一轮日志看到了什么、为什么没能定论」（交报告时面板核对过），放在最前面
  const again = phase === 'evidence' && !!prev && phaseOf(prev) === 'evidence' && prev.status === 'answered'
  const head = [sec(t('你贴的日志'), userLogsOf(d)), sec(t('回答你的意见'), answers)]
  const bg = (title: string, body: string) => sec(title, body, 3)
  const temp = logFilesOf(opts.list ?? [d])

  let main: string[]
  let back: string[]
  if (phase === 'evidence' && d.awaiting) {
    main = [
      ...head,
      sec(t('怎么复现'), stepsOf(d.awaiting.collect ?? d.collect)),
      sec(t('加好的日志'), d.awaiting.added.map((x) => `- ${codeTerms(x)}`).join('\n')),
      sec(t('结果怎么判'), outcomesOf(d.awaiting.collect?.outcomes.length ? d.awaiting.collect : d.collect)),
    ]
    back = [
      bg(t('假设'), hypotheses),
      bg(t('日志计划'), logPlan),
      bg(t('现象'), px(d.symptom)),
      bg(t('位置和调用路径'), location),
    ]
  } else if (phase === 'evidence') {
    main = [
      ...head,
      again ? sec(t('上一轮日志说明了什么'), px(d.next)) : '',
      sec(t('假设'), hypotheses),
      sec(t('日志计划'), logPlan),
      sec(t('怎么复现'), stepsOf(d.collect)),
      sec(t('结果怎么判'), outcomesOf(d.collect)),
      earlySec,
    ]
    back = [
      again ? '' : bg(t('下一步'), px(d.next)),
      bg(t('现象'), px(d.symptom)),
      bg(t('复现'), px(d.repro)),
      bg(t('位置和调用路径'), location),
      bg(t('时间线'), timeline),
      bg(t('证据链'), chainOf(d)),
      bg(rootTitle, px(d.rootCause)),
      bg(t('已排除'), px(d.excluded)),
    ]
  } else if (phase === 'cause' || withCause) {
    main = [
      ...head,
      sec(rootTitle, root),
      sec(t('证据链'), chainOf(d)),
      sec(t('根因怎么解释每一条现象'), consistency),
      sec(t('引入点'), attribution),
      ...(withCause
        ? [
            sec(t('候选方案'), d.options.length > 1 ? optionsTable(d) : ''),
            sec(t('为什么选这个方案'), chosen),
            sec(t('具体改动'), changesOf(d)),
            sec(t('影响面和验证'), impact),
            sec(t('影响和风险'), alert('warning', px(d.risk))),
          ]
        : // 提前写好的修法只是草案，这一版只确认根因：只留一行提示，不摆出来（实测用户以为点「同意根因」就开始修）
          [d.options.length || d.fix.trim() ? t('已经想好修法，同意根因后单独交一版方案给你确认。') : '']),
      earlySec,
    ]
    back = [
      bg(t('现象'), px(d.symptom)),
      bg(t('复现'), px(d.repro)),
      bg(t('时间线'), timeline),
      bg(t('位置和调用路径'), location),
      bg(t('假设'), hypotheses),
      bg(t('已排除'), px(d.excluded)),
    ]
  } else if (phase === 'plan') {
    main = [
      ...head,
      sec(t('候选方案'), optionsTable(d)),
      sec(t('为什么选这个方案'), chosen),
      sec(t('具体改动'), changesOf(d)),
      sec(t('影响面和验证'), impact),
      sec(t('影响和风险'), alert('warning', px(d.risk))),
      earlySec,
    ]
    back = [
      bg(rootTitle, root),
      bg(t('证据链'), chainOf(d)),
      bg(t('位置和调用路径'), stack),
      bg(t('引入点'), attribution),
    ]
  } else {
    main = [
      ...head,
      sec(t('自测结果'), result),
      sec(t('你来验证'), stepsOf(d.collect)),
      sec(t('看到什么算修好了'), outcomesOf(d.collect)),
      sec(t('改动的文件'), d.files.map((f) => `- \`${f}\``).join('\n')),
      sec(
        t('收尾时会做什么'),
        temp.length
          ? t('删掉加在这些文件里的 `[排查-` 临时日志：{files}；修改里必要的正式日志保留。', {
              files: temp.map((f) => `\`${f}\``).join('、'),
            })
          : '',
      ),
      earlySec,
    ]
    back = [bg(rootTitle, root), bg(t('引入点'), attribution)]
  }
  return {
    card,
    main: main.filter(Boolean).join('\n\n'),
    background: back.filter(Boolean).join('\n\n'),
  }
}

/** 整份报告一段 Markdown（决策卡 + 这一步要审的 + 依据和背景） */
export function diagnosisMarkdown(d: Diagnosis, prev?: Diagnosis, opts: DiagnosisViewOpts = {}): string {
  const v = diagnosisView(d, prev, opts)
  return [
    `## ${t('结论')}\n${cardMarkdown(v.card, PHASE_LABEL()[phaseOf(d)])}`,
    v.main,
    v.background && `## ${t('依据和背景')}\n\n${v.background}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}
