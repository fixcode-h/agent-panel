/**
 * 子对话的交接摘要（见 docs/adr/0007-child-handoff-on-done.md）：
 * submit_merge 时子对话按模板写关键信息，面板补上 git 事实；
 * 完成后再被叫醒、上下文又大时，开新会话只带这份摘要，不把上次的工具输出全带进去。
 */
import { clip } from './text.ts'

/** 关键信息模板：submit_merge 的 handoff 参数按它生成，拼摘要也按这个顺序 */
export const HANDOFF_FIELDS = [
  {
    key: 'files',
    title: '关键文件和模块',
    description: '改了或关键的文件、模块，每行「路径 — 作用 / 改了什么」（必填）',
    required: true,
  },
  { key: 'docs', title: '相关文档', description: '读过、改过、下次该先看的文档路径', required: false },
  { key: 'decisions', title: '关键决定', description: '做了哪些取舍、为什么，没选的方案一句话', required: false },
  { key: 'pitfalls', title: '试过不行的和要注意的', description: '试过不行的做法、容易踩的坑', required: false },
  { key: 'followups', title: '遗留和后续', description: '没做的、已知问题、下次接手先做什么', required: false },
] as const

export type HandoffKey = (typeof HANDOFF_FIELDS)[number]['key']
export type HandoffInput = Partial<Record<HandoffKey, string>>

/** 从工具参数里取关键信息：只认模板里的字段，字符串以外的丢掉 */
export function handoffInput(raw: unknown): HandoffInput {
  const out: HandoffInput = {}
  if (!raw || typeof raw !== 'object') return out
  for (const f of HANDOFF_FIELDS) {
    const v = (raw as Record<string, unknown>)[f.key]
    const s = Array.isArray(v) ? v.map(String).join('\n') : typeof v === 'string' ? v : ''
    if (s.trim()) out[f.key] = s.trim()
  }
  return out
}

/** 必填但没写的字段标题；空数组就是齐了 */
export function handoffMissing(h: HandoffInput): string[] {
  return HANDOFF_FIELDS.filter((f) => f.required && !h[f.key]).map((f) => f.title)
}

/** 拒绝时给子对话看的模板 */
export function handoffTemplate(): string {
  return HANDOFF_FIELDS.map((f) => `- ${f.key}（${f.title}）：${f.description}`).join('\n')
}

/** 拼成交给新会话的摘要：子对话写的关键信息在前，面板补的事实在后 */
export function handoffText(
  h: HandoffInput,
  facts: {
    title: string
    request: string
    note: string
    tests: string
    branch: string
    base: string
    commits: string[]
    changed: Record<string, string>
    /** 评审意见的处置（triageText 写好的几行）：哪些采纳、哪些驳回、哪些留作已知问题 */
    triage?: string
    /** 显式放行记录（overrideText 写好的几行）：谁、什么时候、为什么、原本拦住什么 */
    override?: string
    /** 和父对话共用目录（P4、没有版本管理、共用目录）：没有分支要合，改动直接交父对话验收 */
    shared?: boolean
  },
): string {
  const files = Object.entries(facts.changed)
  const parts = [
    `这个子对话「${facts.title}」之前已经做完一次并${facts.shared ? '交父对话验收' : `合回了「${facts.base || '父对话所在的分支'}」`}，下面是当时留下的交接摘要。` +
      '上次的完整过程没有带过来：先按摘要找到对应的代码和文档，需要细节时直接读文件，别凭印象改。',
    facts.request ? `## 原始需求\n${clip(facts.request, 1500)}` : '',
    ...HANDOFF_FIELDS.map((f) => (h[f.key] ? `## ${f.title}\n${clip(h[f.key]!, 3000)}` : '')),
    facts.note ? `## 这次改了什么\n${clip(facts.note, 600)}` : '',
    facts.tests ? `## 当时的验证\n${clip(facts.tests, 1200)}` : '',
    facts.triage ? `## 评审意见的处置\n${clip(facts.triage, 2000)}` : '',
    facts.override ? `## 评审门禁的显式放行\n${clip(facts.override, 800)}` : '',
    facts.commits.length || files.length
      ? [
          facts.shared ? '## 交付的改动（和父对话共用目录）' : `## 合回的改动（分支 ${facts.branch}）`,
          ...facts.commits.slice(0, 20).map((c) => `- ${c}`),
          files.length
            ? `改动文件（增加/删除行数）：${files
                .slice(0, 60)
                .map(([p, n]) => `${p}（${n}）`)
                .join('、')}${files.length > 60 ? ` 等 ${files.length} 个` : ''}`
            : '',
        ]
          .filter(Boolean)
          .join('\n')
      : '',
  ]
  return parts.filter(Boolean).join('\n\n')
}
