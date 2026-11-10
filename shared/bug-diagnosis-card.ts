/**
 * 诊断报告最上面的决策卡（用户 2026-11-07 确认的设计稿「诊断报告各步骤内容」）：
 * 打开报告第一屏就看到现在在哪一步、结论是什么、要用户做什么、要小心什么。
 * 「要注意」由面板按档案字段算，不靠 Agent 自己写（所以不会漏），最多三条，红的排在前面。
 * 审阅弹窗画成卡片（web/src/components/tasks/DiagnosisCard.tsx），别处（测试、整份 Markdown）用 cardMarkdown
 */
import type { Diagnosis } from './bug-diagnosis-schema.ts'
import { causeInPlan, logFilesOf, normPath, outOfPlan, phaseOf } from './bug-phase.ts'
import { codeTerms } from './bug-terms.ts'
import { t } from './i18n.ts'

export type CardTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'

export interface DiagnosisCard {
  /** 状态胶囊：等你确认 / 等你复现 / 你同意了…… */
  status: { text: string; tone: CardTone }
  /** 别的胶囊：级别、根因证实没有、改几个文件 */
  tags: { text: string; tone: CardTone }[]
  /** 方案、验证页上面引用一行根因（Markdown 行内） */
  quote: string
  /** 一句话结论（Markdown 行内） */
  headline: string
  /** 要你做的 */
  todo: string
  /** 要注意：最多三条 */
  attention: { text: string; tone: 'warning' | 'danger' }[]
  /** 相比上一份改了什么 */
  changed: string
}

/**
 * 存下来的旧报告没有 2026-11-07 加的字段（证据链、具体改动、方案判定……）：渲染前补上默认值。
 * 服务端读盘不过 schema，演示版的数据在浏览器里，都可能是旧形状。
 * 就地补、不复制：列表里按对象认第几份（indexOf、causeInPlan），复制出来的对象认不出；补的只是空的默认值
 */
export function fillDiagnosis(d: Diagnosis): Diagnosis {
  d.chain ??= []
  d.changes ??= []
  d.whatChanged ??= ''
  d.options ??= []
  for (const o of d.options) {
    o.grades ??= {}
    o.touches ??= []
  }
  if (d.collect) d.collect.outcomes ??= []
  if (d.awaiting?.collect) d.awaiting.collect.outcomes ??= []
  return d
}

const first = (s: string) => s.trim().split('\n')[0]?.trim() ?? ''

/** 交报告前就动过、又不在用户已同意范围（加日志的文件、确认过的方案）里的文件；面板的临时目录不算 */
export function earlyFiles(d: Diagnosis, list: Diagnosis[] | undefined): string[] {
  const upto = list ? list.slice(0, Math.max(0, list.indexOf(d))) : []
  const ok = new Set(
    [...logFilesOf(upto), ...upto.filter((x) => x.status === 'approved').flatMap((x) => x.files)].map(normPath),
  )
  return d.before.filter((f) => !/^([A-Za-z]:)?[\\/]/.test(f) && !ok.has(normPath(f)))
}

/** 这一版在哪一步、要用户做什么 */
export function nextStep(d: Diagnosis, withCause = false): string {
  const phase = phaseOf(d)
  if (d.status === 'cancelled')
    return d.cleanup?.state === 'running'
      ? t('你取消了这次修复：它在删临时日志，删干净后关闭报告')
      : d.cleanup?.state === 'failed'
        ? t('你取消了这次修复，临时日志没删干净：选让它再删一次，或者自己处理')
        : t('你取消了这次修复')
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
  if (d.awaiting) return t('按下面的步骤复现一次，把日志贴在右边，点「交日志，继续分析」')
  return {
    evidence: t('同意加日志，它只在日志计划里的文件加临时日志、不改逻辑；手上已有日志可以直接贴在右边'),
    cause: t('同意根因，它开始设计修复方案；不同意就选中文字标出疑问，点「否决」'),
    plan: withCause ? t('根因和修复方案一起确认，确认了它才开始改代码') : t('确认方案，它才开始改代码'),
    verify: t('按下面的步骤复现一次，贴日志确认；不想验证可以直接结束'),
  }[phase]
}

function statusOf(d: Diagnosis): DiagnosisCard['status'] {
  const phase = phaseOf(d)
  if (d.status === 'pending')
    return {
      text: d.awaiting ? t('等你复现') : phase === 'verify' ? t('等你验证') : t('等你确认'),
      tone: 'warning',
    }
  if (d.status === 'approved') return { text: t('你已同意'), tone: 'success' }
  if (d.status === 'cancelled')
    return d.cleanup?.state === 'running'
      ? { text: t('在删临时日志'), tone: 'accent' }
      : d.cleanup?.state === 'failed'
        ? { text: t('日志没删干净'), tone: 'warning' }
        : { text: t('已取消'), tone: 'neutral' }
  if (d.status === 'superseded') return { text: t('已被取代'), tone: 'neutral' }
  return { text: t('它在分析'), tone: 'accent' }
}

/** 一句话结论：论证写这一轮要做什么，根因写根因，方案写选了哪个，验证写修好了没有 */
function headlineOf(d: Diagnosis, withCause: boolean): string {
  const phase = phaseOf(d)
  const open = d.hypotheses.filter((h) => h.status === 'open' && h.id).map((h) => h.id)
  if (phase === 'evidence') {
    if (d.awaiting)
      return t('日志已经加好（{n} 处），按下面的步骤复现一次，把日志贴回来', {
        n: d.awaiting.added.length || d.logPlan.length,
      })
    if (d.logPlan.length)
      return open.length > 1
        ? t('根因还没证实：先加 {n} 处临时日志，复现一次来区分 {ids}', { n: d.logPlan.length, ids: open.join('、') })
        : t('根因还没证实：先加 {n} 处临时日志，复现一次来确认', { n: d.logPlan.length })
    return codeTerms(first(d.rootCause)) || t('根因还没证实')
  }
  const root = codeTerms(first(d.rootCause))
  const opt = d.options.find((o) => o.id && o.id === d.chosen?.id)
  const plan = opt
    ? t('选方案 {id}：{title}', { id: opt.id, title: codeTerms(opt.title) })
    : codeTerms(first(d.fix)) || t('修复方案')
  if (phase === 'cause') return root
  if (phase === 'plan') return withCause ? `${root}\n\n${plan}` : plan
  const r = d.result
  const tests = r?.regressionTests.length ?? 0
  return tests ? t('已经修好：回归测试 {n} 条，等你复现验证', { n: tests }) : t('已经修好，等你复现验证')
}

function tagsOf(d: Diagnosis, files: number): DiagnosisCard['tags'] {
  const phase = phaseOf(d)
  const level = { quick: t('快速'), standard: t('标准'), deep: t('深入') }[d.level]
  const tags: DiagnosisCard['tags'] = [{ text: level, tone: 'neutral' }]
  if (phase === 'evidence') tags.push({ text: t('根因未证实'), tone: 'warning' })
  else tags.push(d.confirmed ? { text: t('已证实'), tone: 'success' } : { text: t('根因未证实'), tone: 'danger' })
  if (phase === 'plan' && files) tags.push({ text: t('改 {n} 个文件', { n: files }), tone: 'neutral' })
  return tags
}

/**
 * 「要注意」（设计稿 4.2）：changed 是对话目前实际改动的文件（验证页对比方案用），没有就不算这一条
 */
function attentionOf(d: Diagnosis, list: Diagnosis[] | undefined, changed?: string[]): DiagnosisCard['attention'] {
  const phase = phaseOf(d)
  const out: DiagnosisCard['attention'] = []
  if ((phase === 'plan' || phase === 'verify') && !d.confirmed)
    out.push({ text: t('根因还没用日志或测试证实'), tone: 'danger' })
  const fails = d.result?.impactChecks.filter((x) => !x.output.trim()).length ?? 0
  if (phase === 'verify' && fails) out.push({ text: t('{n} 项影响面还没有验证结果', { n: fails }), tone: 'danger' })
  const early = earlyFiles(d, list)
  if (early.length)
    out.push({ text: t('交报告前已经改了 {n} 个你没同意过的文件', { n: early.length }), tone: 'warning' })
  if (phase === 'verify' && changed) {
    const extra = outOfPlan(changed, [...d.files, ...logFilesOf(list ?? [])])
    if (extra.length) out.push({ text: t('改了方案以外的 {n} 个文件', { n: extra.length }), tone: 'warning' })
  }
  const a = d.attribution
  if (phase !== 'evidence' && a && (a.confidence === 'low' || a.category === 'unknown'))
    out.push({ text: t('引入点还没定下来'), tone: 'warning' })
  if (phase !== 'evidence') {
    const odd = d.consistency.filter((x) => !x.explanation.trim()).length
    if (odd) out.push({ text: t('有 {n} 条现象根因解释不了', { n: odd }), tone: 'warning' })
  }
  if (phase === 'plan') {
    const opt = d.options.find((o) => o.id && o.id === d.chosen?.id)
    const touch = opt?.touches ?? []
    if (touch.length)
      out.push({
        text: t('会改{what}，旧数据和调用方要一起看', {
          what: touch.map((x) => ({ data: t('数据格式'), api: t('接口'), config: t('配置项') })[x]).join('、'),
        }),
        tone: 'warning',
      })
  }
  // 红的在前，最多三条：多了就不醒目了
  return [...out.filter((x) => x.tone === 'danger'), ...out.filter((x) => x.tone === 'warning')].slice(0, 3)
}

export function diagnosisCard(d: Diagnosis, opts: { list?: Diagnosis[]; changed?: string[] } = {}): DiagnosisCard {
  fillDiagnosis(d)
  opts.list?.forEach(fillDiagnosis)
  const phase = phaseOf(d)
  const withCause = !!opts.list && causeInPlan(d, opts.list)
  const files = d.changes.length || d.files.length
  return {
    status: statusOf(d),
    tags: tagsOf(d, files),
    quote: (phase === 'plan' && !withCause) || phase === 'verify' ? codeTerms(first(d.rootCause)) : '',
    headline: headlineOf(d, withCause),
    todo: nextStep(d, withCause),
    attention: attentionOf(d, opts.list, opts.changed),
    changed: codeTerms(d.whatChanged.trim()),
  }
}

/** 整份报告是 Markdown 时（交回、测试）决策卡的写法：要用户决定时画成「重要」提示块 */
export function cardMarkdown(c: DiagnosisCard, phaseLabel: string): string {
  const head = [
    `**${phaseLabel}** · ${c.status.text} · ${c.tags.map((x) => x.text).join(' · ')}`,
    c.quote && `${t('根因')}：${c.quote}`,
    `**${c.headline.replace(/\n\n/g, '**\n\n**')}**`,
    `${t('要你做的')}：${c.todo}`,
  ].filter(Boolean)
  const body = head.join('\n\n')
  const block =
    c.status.tone === 'warning'
      ? ['> [!IMPORTANT]', ...body.split('\n').map((l) => `> ${l}`.trimEnd())].join('\n')
      : body
  const warn = c.attention.length ? ['> [!WARNING]', ...c.attention.map((a) => `> - ${a.text}`)].join('\n') : ''
  const changed = c.changed ? `${t('相比上一份')}：${c.changed}` : ''
  return [block, warn, changed].filter(Boolean).join('\n\n')
}
