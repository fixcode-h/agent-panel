import { getLang, type Lang } from './i18n.ts'

/**
 * 总结卡：Agent 每轮结束写给人看的总结，按类型规定字段（修复写原因和修法、功能写怎么用……），
 * 让看的人一眼抓住重点。写法就是普通 Markdown（`### 类型｜一句话结论` + `- **字段**：内容`），
 * 面板认得出就画成卡片，认不出也还是一段能读的 Markdown；CLI 原始输出、父对话收到的结果、导出里都直接可读。
 * 不用「提交总结」工具：每轮多一次调用，忘了调就什么都没有，总结也不在回复正文里。
 * 类型和字段只在这里定义一次：提示词（summaryCardRules）和界面解析（splitSummaryCards）都从这张表来，
 * 主理的汇报、子对话的排查报告也引用它，不另写一套。
 */

export type SummaryKind = 'fix' | 'feature' | 'improve' | 'analysis' | 'blocked'

interface FieldDef {
  key: string
  zh: string
  en: string
}

interface KindDef {
  zh: string
  en: string
  /** 什么时候用这一类（写进提示词） */
  when: string
  fields: FieldDef[]
}

const f = (key: string, zh: string, en: string): FieldDef => ({ key, zh, en })

/** 「要你处理」：每一类都可以在末尾加，没有就不写；界面上单独标出来 */
export const NEEDS_YOU = f('needs', '要你处理', 'Needs you')
const VERIFIED = f('verified', '验证', 'Verified')
const REMAINING = f('remaining', '遗留', 'Remaining')

export const SUMMARY_KINDS: Record<SummaryKind, KindDef> = {
  fix: {
    zh: '修复',
    en: 'Fix',
    when: '修了一个 Bug',
    fields: [
      f('symptom', '现象', 'Symptom'),
      f('cause', '原因', 'Cause'),
      f('fix', '修复', 'Fix'),
      VERIFIED,
      REMAINING,
    ],
  },
  feature: {
    zh: '功能',
    en: 'Feature',
    when: '新功能，或改进了用户能感受到的行为',
    fields: [
      f('what', '做了什么', 'What'),
      f('usage', '怎么用', 'How to use'),
      f('changes', '改动', 'Changes'),
      VERIFIED,
      REMAINING,
    ],
  },
  improve: {
    zh: '优化',
    en: 'Improve',
    when: '重构、性能、清理，用户能感受到的行为不变',
    fields: [
      f('changed', '改了什么', 'What changed'),
      f('effect', '效果', 'Effect'),
      f('safe', '行为不变的依据', 'Why behavior is unchanged'),
      VERIFIED,
    ],
  },
  analysis: {
    zh: '分析',
    en: 'Analysis',
    when: '调研、排查了还没修、方案对比、评审：只读不改',
    fields: [
      f('conclusion', '结论', 'Conclusion'),
      f('evidence', '依据', 'Evidence'),
      f('advice', '建议', 'Recommendation'),
      f('unconfirmed', '未确认', 'Unconfirmed'),
    ],
  },
  blocked: {
    zh: '未完成',
    en: 'Blocked',
    when: '卡住了、失败了、做到一半要等用户或别的结果',
    fields: [f('blocker', '卡在哪', 'Blocked on'), f('done', '已完成', 'Done so far'), NEEDS_YOU],
  },
}

const KIND_KEYS = Object.keys(SUMMARY_KINDS) as SummaryKind[]

const fieldLine = (x: FieldDef, lang: Lang) => `- **${x[lang]}**：`

/** 给 Agent 的「总结格式」一节：按当前回复语言写类型和字段名，界面两种语言都认 */
export function summaryCardRules(lang: Lang = getLang()): string {
  const table = KIND_KEYS.map((k) => {
    const d = SUMMARY_KINDS[k]
    return `| ${d[lang]} | ${d.when} | ${d.fields.map((x) => x[lang]).join(' · ')} |`
  }).join('\n')
  const fix = SUMMARY_KINDS.fix
  const example = [
    `### ${fix[lang]}｜<一句话结论：修好了什么>`,
    ...fix.fields.map((x) => `${fieldLine(x, lang)}<…>`),
  ].join('\n')
  return `## 总结格式
这一轮做完交付（改了代码、查清了问题、卡住要等人）时，回复的最后用「总结卡」写给用户看，让人一眼抓住重点：
- 第一行是三级标题「类型｜一句话结论」，下面每个字段一条列表项，字段名加粗、后面跟全角冒号；字段按下表的顺序写，一个都不省。
- 每个字段一到两句，写事实不写过程：「原因」写到能解释现象为止并带 path:line；「验证」写本轮跑了什么、结果如何，没验证的写「未验证：原因」；「遗留」没有就写「无」，不省略。
- 需要用户决定或动手的事，在卡片末尾加一行「${NEEDS_YOU[lang]}」；没有就不写这一行。
- 一轮里做了几件互不相关的事就写几张卡，每张按自己的类型；卡片之外的说明、排查报告、表格放在卡片下面。
- 问答、闲聊、派单那一轮、计划还没做完的中间进度不写卡片。
${lang === 'zh' ? '' : '- 回复用英文时类型和字段名用英文（表里就是英文名），不要中英混写。\n'}
| 类型 | 什么时候用 | 字段（按顺序） |
| --- | --- | --- |
${table}

示例：
\`\`\`markdown
${example}
\`\`\``
}

/** 汇报里引用卡片时的一句话：「每件事一张总结卡（类型｜结论 + 字段）」 */
export function summaryCardHint(lang: Lang = getLang()): string {
  return `按「总结格式」写成总结卡（${KIND_KEYS.map((k) => SUMMARY_KINDS[k][lang]).join(' / ')}）`
}

// ── 解析：界面把卡片画出来 ──

export interface SummaryField {
  /** 认得的字段给 key（界面按它加样式），认不得的字段照样保留一行 */
  key?: string
  label: string
  text: string
}

export interface SummaryCard {
  kind: SummaryKind
  /** 写在回复里的类型名（按回复语言），界面原样显示 */
  label: string
  title: string
  fields: SummaryField[]
}

export type SummarySegment = { md: string } | { card: SummaryCard }

const kindByLabel = new Map<string, SummaryKind>()
const fieldByLabel = new Map<string, string>()
for (const k of KIND_KEYS) {
  const d = SUMMARY_KINDS[k]
  kindByLabel.set(d.zh, k)
  kindByLabel.set(d.en.toLowerCase(), k)
  for (const x of [...d.fields, NEEDS_YOU]) {
    fieldByLabel.set(x.zh, x.key)
    fieldByLabel.set(x.en.toLowerCase(), x.key)
  }
}

// 标题：### 修复｜结论；也认半角竖线、冒号和类型名加粗的写法
const HEAD = /^#{2,4}\s+\*{0,2}([^\s｜|：:*]+)\*{0,2}\s*[｜|：:]\s*(.+?)\s*$/
// 字段：- **原因**：内容；冒号写在粗体里面（**原因：**）也认
const FIELD = /^[-*]\s+\*\*([^*]+?)\s*[：:]?\*\*\s*[：:]?\s*(.*)$/
const FENCE = /^\s*(```|~~~)/

function headKind(line: string): { kind: SummaryKind; label: string; title: string } | undefined {
  const m = HEAD.exec(line)
  if (!m) return
  const kind = kindByLabel.get(m[1]) ?? kindByLabel.get(m[1].toLowerCase())
  return kind ? { kind, label: m[1], title: m[2] } : undefined
}

/**
 * 把回复切成「普通 Markdown」和「总结卡」几段。代码块里的不算（示例、文档里贴的格式说明不画成卡）；
 * 标题下面紧跟着至少一条字段才算卡片，只有标题的照普通 Markdown 显示。
 */
export function splitSummaryCards(md: string): SummarySegment[] {
  const lines = md.split('\n')
  const out: SummarySegment[] = []
  let buf: string[] = []
  let fence = ''
  const flush = () => {
    if (buf.length) out.push({ md: buf.join('\n') })
    buf = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fm = FENCE.exec(line)
    if (fm) fence = fence ? (fm[1] === fence ? '' : fence) : fm[1]
    const head = fence || fm ? undefined : headKind(line)
    if (!head) {
      buf.push(line)
      continue
    }
    // 标题和第一条字段之间最多隔空行
    let j = i + 1
    while (j < lines.length && !lines[j].trim()) j++
    if (j >= lines.length || !FIELD.test(lines[j])) {
      buf.push(line)
      continue
    }
    const fields: SummaryField[] = []
    while (j < lines.length) {
      const l = lines[j]
      const fl = FIELD.exec(l)
      if (fl) {
        const label = fl[1].trim()
        fields.push({ key: fieldByLabel.get(label) ?? fieldByLabel.get(label.toLowerCase()), label, text: fl[2] })
        j++
        continue
      }
      // 缩进的行（子列表、换行续写）接在上一个字段后面
      if (/^\s{2,}\S/.test(l)) {
        const last = fields[fields.length - 1]
        last.text += `\n${l.replace(/^ {2}/, '')}`
        j++
        continue
      }
      // 空行后面还是字段或缩进行时，卡片没完
      if (!l.trim()) {
        let k = j
        while (k < lines.length && !lines[k].trim()) k++
        if (k < lines.length && (FIELD.test(lines[k]) || /^\s{2,}\S/.test(lines[k]))) {
          j = k
          continue
        }
      }
      break
    }
    flush()
    out.push({ card: { kind: head.kind, label: head.label, title: head.title, fields } })
    i = j - 1
  }
  flush()
  return out
}
