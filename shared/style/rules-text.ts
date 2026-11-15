import { RULE_GROUPS, RULE_GROUP_LABEL, type SavedStyle } from '../style-types.ts'

/**
 * 把一个 3D 模型风格拼成交给 Agent 的说明：按约束组的固定顺序列要点。
 * 发给 Agent 的提示词不翻译（硬规则），组名用中文原文。
 * changed 为真表示对话中途换了风格：只管之后的步骤，已经建好的部分要不要改由用户另说（设计稿第 9 节，用户交给我们定）。
 * Blender 插件经开放模块（shared/plugins/host-modules.json）用它
 */
export function styleBrief(s: Pick<SavedStyle, 'name' | 'summary' | 'rules'>, changed = false): string {
  const head = changed
    ? `## 模型风格改成了：${s.name}\n用户把这个对话的模型风格换成了下面这个。从这一条起，新建和修改的部分都按它做；已经建好的部分保持原样，除非用户要求返工。`
    : `## 模型风格：${s.name}\n这次建模按这个风格做，下面每条都要遵守；没提到的方面按通用做法（真实尺寸、干净拓扑、材质分区清楚）。`
  const parts = [head]
  if (s.summary) parts.push(s.summary)
  for (const g of RULE_GROUPS) {
    const list = s.rules.filter((r) => r.group === g)
    if (!list.length) continue
    const title = g === 'check' ? '验收（质检时逐条检查并给出截图）' : RULE_GROUP_LABEL[g]
    parts.push(`### ${title}\n${list.map((r) => `- ${r.text}`).join('\n')}`)
  }
  return parts.join('\n\n')
}
