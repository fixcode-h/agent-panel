import { getLang, type Lang } from './i18n.ts'

/**
 * 总结卡：Agent 每轮结束写给人看的总结，按类型规定字段（修复写原因和修法、功能写怎么用……），
 * 让看的人一眼抓住重点。写法就是普通 Markdown（`### 类型｜一句话结论` + `- **字段**：内容`），
 * 面板认得出就画成卡片，认不出也还是一段能读的 Markdown；CLI 原始输出、父对话收到的结果、导出里都直接可读。
 * 不用「提交总结」工具：每轮多一次调用，忘了调就什么都没有，总结也不在回复正文里。
 * 类型和字段只在这里定义一次：提示词（summaryCardRules）和界面解析（splitSummaryCards）都从这张表来，
 * 主理的汇报、子对话的排查报告也引用它，不另写一套。
 *
 * 父子对话分两种写法（用户要求）：父对话里是简洁的卡片，标题链到子对话；子对话自己写详细总结
 * （`## 类型｜一句话结论` + 每段一个 `### 段名`），照普通 Markdown 显示，问题、原因、方案、改了哪些、影响都分段写清。
 * 卡片字段一两句放不下这些，子对话又是用户点进去看细节的地方，所以详细的那份不画成卡片。
 */

export type SummaryKind = 'fix' | 'feature' | 'improve' | 'analysis' | 'blocked'

interface FieldDef {
  key: string
  zh: string
  en: string
}

interface DetailDef extends FieldDef {
  /** 这一段写什么（写进提示词） */
  hint: string
}

interface KindDef {
  zh: string
  en: string
  /** 什么时候用这一类（写进提示词） */
  when: string
  fields: FieldDef[]
  /** 子对话详细总结的段落（按顺序） */
  detail: DetailDef[]
}

const f = (key: string, zh: string, en: string): FieldDef => ({ key, zh, en })
const sec = (x: FieldDef, hint: string): DetailDef => ({ ...x, hint })

/** 「要你处理」：每一类都可以在末尾加，没有就不写；界面上单独标出来 */
export const NEEDS_YOU = f('needs', '要你处理', 'Needs you')
const VERIFIED = f('verified', '验证', 'Verified')
const REMAINING = f('remaining', '遗留', 'Remaining')
// 详细总结的段落：和卡片字段同名的复用同一个 key，提炼工作总结时两种写法按 key 一样取舍（见 shared/summary.ts）
const CHANGES = f('changes', '改动明细', 'Changes')
const PROBLEM = f('problem', '问题', 'Problem')
const SOLUTION = f('solution', '修改方案', 'Solution')
const IMPACT = f('impact', '影响', 'Impact')
const D_CHANGES = sec(CHANGES, '逐个文件（或模块）一条：改了什么、为什么要改这里；不贴整段代码')
const D_VERIFIED = sec(VERIFIED, '本轮跑了哪些命令 / 测试 / 操作，各自的结果；没验证的写「未验证：原因」')
const D_REMAINING = sec(REMAINING, '没做完的、已知限制、顺带发现但没修的；没有写「无」')
const D_IMPACT = sec(IMPACT, '用户能感受到的变化、会波及的其他功能、兼容性和风险；没有写「无」')

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
    detail: [
      sec(PROBLEM, '用户看到的现象（期望 vs 实际）、触发条件、影响到谁；是回归的写从哪次改动开始'),
      sec(
        f('cause', '原因', 'Cause'),
        '完整的因果链，讲到能解释现象为止，关键处带 path:line；为什么以前没出（有的话）',
      ),
      sec(SOLUTION, '怎么改的、为什么这样改能解决根因；考虑过但没采用的改法和原因'),
      D_CHANGES,
      D_IMPACT,
      D_VERIFIED,
      D_REMAINING,
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
    detail: [
      sec(f('goal', '需求', 'Goal'), '要解决什么问题、给谁用、用户原话里的要求'),
      sec(SOLUTION, '整体怎么做的、关键取舍（为什么选这个方案而不是别的）'),
      sec(f('usage', '怎么用', 'How to use'), '用户从哪里进、怎么操作、看到什么'),
      D_CHANGES,
      D_IMPACT,
      D_VERIFIED,
      D_REMAINING,
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
    detail: [
      sec(PROBLEM, '为什么要改：原来哪里慢、冗余、难维护，有数据的带数据'),
      sec(SOLUTION, '怎么改的、为什么这样改'),
      D_CHANGES,
      sec(f('effect', '效果', 'Effect'), '改完好在哪：数字、对比、少了什么'),
      sec(f('safe', '行为不变的依据', 'Why behavior is unchanged'), '凭什么说用户能感受到的行为没变'),
      D_VERIFIED,
      D_REMAINING,
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
    detail: [
      sec(PROBLEM, '要回答的问题、范围'),
      sec(f('conclusion', '结论', 'Conclusion'), '直接回答问题，分点写'),
      sec(f('evidence', '依据', 'Evidence'), '代码 path:line、日志原文、数据、文档，每条结论对得上依据'),
      sec(f('advice', '建议', 'Recommendation'), '建议怎么做、改哪里、大致工作量和风险；有几个方案的列出对比'),
      sec(f('unconfirmed', '未确认', 'Unconfirmed'), '推测的、没查到的、要用 X 才能确认的；没有写「无」'),
    ],
  },
  blocked: {
    zh: '未完成',
    en: 'Blocked',
    when: '卡住了、失败了、做到一半要等用户或别的结果',
    fields: [f('blocker', '卡在哪', 'Blocked on'), f('done', '已完成', 'Done so far'), NEEDS_YOU],
    detail: [
      sec(f('goal', '目标', 'Goal'), '这一轮本来要做到什么'),
      sec(f('blocker', '卡在哪', 'Blocked on'), '卡住的地方、报错原文、已经试过的办法'),
      sec(f('done', '已完成', 'Done so far'), '已经做完、可以保留的部分（改了哪些文件）'),
      sec(NEEDS_YOU, '要用户决定或动手的事，给出你的建议'),
    ],
  },
}

const KIND_KEYS = Object.keys(SUMMARY_KINDS) as SummaryKind[]

const fieldLine = (x: FieldDef, lang: Lang) => `- **${x[lang]}**：`

/** 父对话的卡片标题链到子对话的写法：`[结论](child:<id>)`，界面画成能点的标题 */
export const CHILD_LINK = 'child:'

/**
 * 给 Agent 的「总结格式」一节：按当前回复语言写类型和字段名，界面两种语言都认。
 * parent：能分派子对话的父对话，写子对话的结果时卡片标题链到那个子对话（点了跳到子对话里的详细总结）
 */
export function summaryCardRules(lang: Lang = getLang(), parent = false): string {
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
- 卡片直接写在回复正文里，不要包进代码块（下面的示例只是为了展示原文才放进代码块）。
- 第一行是三级标题「类型｜一句话结论」，下面每个字段一条列表项，字段名加粗、后面跟全角冒号；字段按下表的顺序写，一个都不省。
- 每个字段一到两句，写事实不写过程：「原因」写到能解释现象为止并带 path:line；「验证」写本轮跑了什么、结果如何，没验证的写「未验证：原因」；「遗留」没有就写「无」，不省略。
- 需要用户决定或动手的事，在卡片末尾加一行「${NEEDS_YOU[lang]}」；没有就不写这一行。
- 一轮里做了几件互不相关的事就写几张卡，每张按自己的类型；卡片之外的说明、排查报告、表格放在卡片下面。
- 问答、闲聊、派单那一轮、计划还没做完的中间进度不写卡片。
${
  parent
    ? `- 写子对话交回的结果时一个子对话一张卡：标题里的结论写成指向它的链接「### 类型｜[一句话结论](${CHILD_LINK}<子对话 id>)」，用户点标题跳到子对话里的详细总结。每个字段一两句写清要点，问题和原因的来龙去脉、逐个文件的改动留在子对话的总结里，不要整段照搬。\n`
    : ''
}${lang === 'zh' ? '' : '- 回复用英文时类型和字段名用英文（表里就是英文名），不要中英混写。\n'}
| 类型 | 什么时候用 | 字段（按顺序） |
| --- | --- | --- |
${table}

示例：
\`\`\`markdown
${example}
\`\`\``
}

/**
 * 子对话的「总结格式」：详细总结，普通 Markdown，不写成卡片。父对话收到的「最近的结果」就是这一段，
 * 用户在父对话里点卡片标题也跳到这里，所以要写到没参与的人看完就明白
 */
export function summaryDetailRules(lang: Lang = getLang()): string {
  const table = KIND_KEYS.map((k) => {
    const x = SUMMARY_KINDS[k]
    return `| ${x[lang]} | ${x.when} | ${x.detail.map((s) => `**${s[lang]}**：${s.hint}`).join('<br>')} |`
  }).join('\n')
  const fix = SUMMARY_KINDS.fix
  const example = [`## ${fix[lang]}｜<一句话结论：修好了什么>`, ...fix.detail.map((s) => `\n### ${s[lang]}\n<…>`)].join(
    '\n',
  )
  return `## 总结格式
你在子对话里。这一轮交付（改了代码、查清了问题、卡住要等人）时，回复的最后写一份详细总结：用户在父对话里点结果卡片会跳到这里看细节，父对话也按它核对。
- 总结直接写在回复正文里，面板按 Markdown 显示；不要包进代码块（下面的示例只是为了展示原文才放进代码块）。
- 用普通 Markdown，不要写成「- **字段**：内容」的卡片：第一行是二级标题「类型｜一句话结论」，下面按下表每段一个三级标题，顺序固定、一个都不省，没有内容的写「无」。
- 写到没参与的人看完就明白：问题是什么、为什么会这样、怎么改的、改了哪些、会影响什么、怎么验证的。段内可以用列表、表格、path:line，不要每段只写一句；但写事实和结论，不复述排查过程。
- 需要用户决定或动手的事，最后加一段「### ${NEEDS_YOU[lang]}」；没有就不写这一段。
- 一轮里做了几件互不相关的事就写几份，每份按自己的类型；排查报告等其他内容放在总结下面。
- 问答、闲聊、计划还没做完的中间进度不写总结。
${lang === 'zh' ? '' : '- 回复用英文时类型和段名用英文（表里就是英文名），不要中英混写。\n'}
| 类型 | 什么时候用 | 段落（按顺序） |
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
  /** 父对话写子对话结果时标题链到的子对话 id（见 CHILD_LINK） */
  child?: string
}

export type SummarySegment = { md: string } | { card: SummaryCard }

const kindByLabel = new Map<string, SummaryKind>()
const fieldByLabel = new Map<string, string>()
for (const k of KIND_KEYS) {
  const d = SUMMARY_KINDS[k]
  kindByLabel.set(d.zh, k)
  kindByLabel.set(d.en.toLowerCase(), k)
  for (const x of [...d.fields, ...d.detail, NEEDS_YOU]) {
    fieldByLabel.set(x.zh, x.key)
    fieldByLabel.set(x.en.toLowerCase(), x.key)
  }
}

// 标题：### 修复｜结论；也认半角竖线、冒号和类型名加粗的写法
const HEAD = /^#{2,4}\s+\*{0,2}([^\s｜|：:*]+)\*{0,2}\s*[｜|：:]\s*(.+?)\s*$/
// 字段：- **原因**：内容；冒号写在粗体里面（**原因：**）也认
const FIELD = /^[-*]\s+\*\*([^*]+?)\s*[：:]?\*\*\s*[：:]?\s*(.*)$/
const FENCE = /^\s*(```|~~~)/

// 标题整个是链到子对话的链接：[结论](child:<id>)
const CHILD_TITLE = new RegExp(`^\\[(.+)\\]\\(${CHILD_LINK}([\\w-]+)\\)$`)

function headKind(line: string): { kind: SummaryKind; label: string; title: string; child?: string } | undefined {
  const m = HEAD.exec(line)
  if (!m) return
  const kind = kindByLabel.get(m[1]) ?? kindByLabel.get(m[1].toLowerCase())
  if (!kind) return
  const link = CHILD_TITLE.exec(m[2])
  return link ? { kind, label: m[1], title: link[1], child: link[2] } : { kind, label: m[1], title: m[2] }
}

/** 渲染出来的标题文字是不是一份总结的标题（「修复｜……」）：父对话点卡片跳到子对话时按它找详细总结 */
export const isSummaryTitle = (text: string) => !!headKind(`## ${text.trim()}`)

/**
 * 把回复切成「普通 Markdown」和「总结卡」几段。代码块里的不算（示例、文档里贴的格式说明不画成卡）；
 * 标题下面紧跟着至少一条字段才算卡片，只有标题的照普通 Markdown 显示（链到子对话的标题除外）。
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
    // 链到子对话的标题即使没有字段也画成卡片（父对话简短汇报时只写标题行），能点开子对话
    if ((j >= lines.length || !FIELD.test(lines[j])) && !head.child) {
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
      if (fields.length && /^\s{2,}\S/.test(l)) {
        const last = fields[fields.length - 1]
        last.text += `\n${l.replace(/^ {2}/, '')}`
        j++
        continue
      }
      // 空行后面还是字段或缩进行时，卡片没完
      if (!l.trim()) {
        let k = j
        while (k < lines.length && !lines[k].trim()) k++
        if (k < lines.length && (FIELD.test(lines[k]) || (fields.length && /^\s{2,}\S/.test(lines[k])))) {
          j = k
          continue
        }
      }
      break
    }
    flush()
    const card: SummaryCard = { kind: head.kind, label: head.label, title: head.title, fields }
    if (head.child) card.child = head.child
    out.push({ card })
    i = j - 1
  }
  flush()
  return out
}

/**
 * 子对话的详细总结（`## 类型｜结论` + 一段段 `### 段名`）按卡片的结构取出来：提炼工作总结时和卡片一样用。
 * 段名认不得的也保留；遇到下一个同级或更高的标题、或者代码块外的分隔线就算这份结束
 */
function detailSummaries(md: string): SummaryCard[] {
  const lines = md.split('\n')
  const out: SummaryCard[] = []
  let fence = ''
  let cur: { card: SummaryCard; level: number; field?: SummaryField } | undefined
  const end = () => {
    if (cur?.card.fields.length) {
      for (const x of cur.card.fields) x.text = x.text.trim()
      out.push(cur.card)
    }
    cur = undefined
  }
  for (const line of lines) {
    const fm = FENCE.exec(line)
    if (fm) fence = fence ? (fm[1] === fence ? '' : fence) : fm[1]
    const inCode = fence || fm
    const h = inCode ? null : /^(#{2,4})\s+(.*)$/.exec(line)
    if (h) {
      const level = h[1].length
      const head = headKind(line)
      if (head) {
        end()
        const card: SummaryCard = { kind: head.kind, label: head.label, title: head.title, fields: [] }
        if (head.child) card.child = head.child
        cur = { card, level }
        continue
      }
      if (cur && level === cur.level + 1) {
        const label = h[2].replace(/\*/g, '').trim()
        cur.field = { key: fieldByLabel.get(label) ?? fieldByLabel.get(label.toLowerCase()), label, text: '' }
        cur.card.fields.push(cur.field)
        continue
      }
      if (cur && level <= cur.level) end()
      continue
    }
    if (!inCode && cur && /^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      end()
      continue
    }
    if (cur?.field) cur.field.text += `${line}\n`
  }
  end()
  return out
}

/**
 * 把包在 ```markdown 代码块里的总结放回正文：Agent 照着提示词里的示例连代码块一起抄，界面上就成了一段源码。
 * 只在子对话页用（见 Markdown 的 SummaryCardsCtx）：父对话里讨论总结格式时贴的示例要原样显示成代码
 */
export function unfenceSummaries(md: string): string {
  return md.replace(/^(```|~~~)(?:markdown|md)?[ \t]*\n([\s\S]*?)\n\1[ \t]*$/gm, (all, _f, body: string) => {
    const first = body.split('\n').find((l) => l.trim()) ?? ''
    return headKind(first.trim()) ? body : all
  })
}

/** 一条回复里所有的总结：卡片和子对话的详细总结都算，按出现顺序 */
export function summariesOf(md: string): SummaryCard[] {
  const text = unfenceSummaries(md)
  const cards = splitSummaryCards(text).flatMap((x) => ('card' in x ? [x.card] : []))
  return cards.length ? cards : detailSummaries(text)
}
