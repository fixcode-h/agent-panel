/**
 * 诊断报告「修复」这一步的页面（用户 2026-11-10 要求）：修完交 phase: fix，用户看改了哪些代码、为什么这么改，
 * 确认了才进验证；对代码有疑问就选中标注，Agent 逐条判断，对的改代码、不对的用事实反驳，再交一次。
 * 代码是面板交报告时取的实际 diff（fixFiles，bug-fix.ts），原因是 Agent 在 changes 里按文件写的 what / why
 */
import type { Diagnosis } from './diagnosis-schema.ts'
import type { DiagnosisCard } from './diagnosis-card.ts'
import { alert, at, px, sec, table } from './md.ts'
import { lastPlan, logFilesOf, normPath, outOfPlan } from './phase.ts'
import { diffBlock } from './quotes-md.ts'
import { codeTerms } from './terms.ts'
import { t } from '../i18n.ts'

const baseName = (file: string) => file.split('/').at(-1) || file

export interface FixRow {
  file: string
  add?: number
  del?: number
  diff?: string
  isNew: boolean
  what: string
  why: string
  /** 不在用户确认过的方案（和论证时加日志的文件）里 */
  extra: boolean
}

/** 这一版之前用户确认的方案 */
const planOf = (d: Diagnosis, list: Diagnosis[]) => lastPlan(list.slice(0, Math.max(0, list.indexOf(d))))

/**
 * 每个改了的文件一行：代码按 fixFiles，原因先找这一版 Agent 写的 changes，再找方案里那一行。
 * 没有 fixFiles（单测、导入的对话取不到 diff）时按 changes 列，只是没有代码
 */
export function fixRows(d: Diagnosis, list: Diagnosis[]): FixRow[] {
  const plan = planOf(d, list)
  const scope = [...(plan?.files ?? d.files), ...logFilesOf(list)]
  const said = new Map<string, { what: string; why: string; isNew: boolean }>()
  for (const c of [...(plan?.changes ?? []), ...d.changes]) {
    const k = normPath(c.file)
    const old = said.get(k)
    said.set(k, { what: c.what || old?.what || '', why: c.why || old?.why || '', isNew: c.isNew || !!old?.isNew })
  }
  const base: { file: string; add?: number; del?: number; diff?: string; isNew: boolean }[] = d.fixFiles.length
    ? d.fixFiles
    : d.changes.map((c) => ({ file: normPath(c.file), isNew: c.isNew }))
  return base.map((f) => {
    const s = said.get(normPath(f.file))
    return {
      ...f,
      isNew: f.isNew || !!s?.isNew,
      what: s?.what ?? '',
      why: s?.why ?? '',
      extra: outOfPlan([f.file], scope).length > 0,
    }
  })
}

/** 决策卡上和别的步骤不同的几样：一句话写按哪个方案改的，胶囊写改了几个文件、增删几行，要注意方案外的文件和没写原因的 */
export function fixCardParts(d: Diagnosis, list: Diagnosis[]): Pick<DiagnosisCard, 'headline' | 'tags' | 'attention'> {
  const rows = fixRows(d, list)
  const plan = planOf(d, list)
  const opt = plan?.options.find((o) => o.id && o.id === plan.chosen?.id)
  const add = rows.reduce((n, r) => n + (r.add ?? 0), 0)
  const del = rows.reduce((n, r) => n + (r.del ?? 0), 0)
  const extra = rows.filter((r) => r.extra).length
  const silent = rows.filter((r) => !r.why).length
  const attention: DiagnosisCard['attention'] = []
  if (extra) attention.push({ text: t('改了方案以外的 {n} 个文件', { n: extra }), tone: 'warning' })
  if (silent) attention.push({ text: t('{n} 个文件没写为什么这么改', { n: silent }), tone: 'warning' })
  const first = (s: string) => s.trim().split('\n')[0]?.trim() ?? ''
  return {
    headline: opt
      ? t('按方案 {id} 改完了：{title}', { id: opt.id, title: codeTerms(opt.title) })
      : codeTerms(first(plan?.fix ?? d.fix)) || t('按确认的方案改完了'),
    tags: [
      { text: t('改了 {n} 个文件', { n: rows.length }), tone: 'neutral' },
      ...(d.fixFiles.length ? [{ text: `+${add} −${del}`, tone: 'neutral' as const }] : []),
    ],
    attention,
  }
}

/** 这一步要审的几节和收起的背景 */
export function fixSections(d: Diagnosis, list: Diagnosis[]): { main: string[]; background: string[] } {
  const rows = fixRows(d, list)
  const plan = planOf(d, list)
  const opt = plan?.options.find((o) => o.id && o.id === plan.chosen?.id)
  const why = [
    opt && `**${t('选的方案')}**：${t('方案 {id}：{title}', { id: opt.id, title: codeTerms(opt.title) })}`,
    opt?.change && px(opt.change),
    plan?.chosen?.why && `**${t('为什么选它')}**：${codeTerms(plan.chosen.why)}`,
    !opt && plan?.fix && px(plan.fix),
  ]
    .filter(Boolean)
    .join('\n\n')
  const reason = (r: FixRow) =>
    [r.what, r.why ? `**${t('为什么')}**：${r.why}` : `**${t('没写为什么')}**`].filter(Boolean).join('\n')
  // 增删行数在决策卡（合计）和下面每个文件的小节里；表里单列一栏太窄，「+1 −2」会断成两行
  const files = table(
    [t('文件'), t('改了什么、为什么')],
    rows.map((r) => [
      `${at(r.file)}${r.isNew ? ` **${t('新增')}**` : ''}${r.extra ? ` **${t('超出方案')}**` : ''}`,
      reason(r),
    ]),
  )
  const extra = rows.filter((r) => r.extra)
  // 每个文件一小节（目录里能跳）：改了什么和为什么、diff（顶栏写文件名和增删数）；用户直接在代码上选中标注
  const code = rows
    .filter((r) => r.diff)
    .map((r) =>
      [
        `### ${baseName(r.file)}`,
        r.what && codeTerms(r.what),
        r.why && `**${t('为什么')}**：${codeTerms(r.why)}`,
        diffBlock(r.diff!, r.file),
      ]
        .filter(Boolean)
        .join('\n\n'),
    )
    .join('\n\n')
  const main = [
    sec(t('为什么这么改'), why),
    sec(t('改了哪些文件'), files),
    alert(
      'caution',
      extra.length ? [t('这些文件不在你确认的方案里：'), ...extra.map((r) => `- ${at(r.file)}`)].join('\n') : '',
    ),
    code
      ? `## ${t('改动的代码')}\n${t('和对话开始时比，`[排查-` 临时日志不算在里面。对哪几行有疑问，选中代码标注。')}\n\n${code}`
      : sec(t('改动的代码'), t('这一版没有取到实际的代码改动，只能看上面每个文件写的改了什么。')),
  ]
  const background = [
    sec(t('根因'), px(d.rootCause || plan?.rootCause), 3),
    sec(
      t('方案里写的改动'),
      table(
        [t('文件'), t('改什么')],
        (plan?.changes ?? []).map((c) => [at(c.file), c.what]),
      ),
      3,
    ),
  ]
  return { main, background }
}
