import type { Agent, Tag } from '@shared/schema'

/** 「默认」分组的 id：和标签 id 不会冲突，「默认」这个名字本身对应的标签也不能把它顶掉 */
export const DEFAULT_AGENT_GROUP = '#default'

/** 「默认」分组的标题（中文原文）：只作为分组数据的标识，界面上这一组显示「默认（没有标签）」 */
const DEFAULT_LABEL = '默认'

/** 角色页按标签分组时的一组 */
export interface AgentTagGroup {
  /** 标签 id，或 DEFAULT_AGENT_GROUP */
  id: string
  /** 组标题：标签名（默认组是内部标识「默认」，界面显示「默认（没有标签）」） */
  label: string
  /** 标签实体：默认组没有，用来取颜色 */
  tag?: Tag
  agents: Agent[]
}

/**
 * 按标签把角色分组。
 *
 * 带几个标签的角色就在几个组里各出现一次：分组是找角色的入口，按第一个标签归类会出现
 * 「明明带着标签 A 却不在 A 组里」，比重复更让人找不到。角色通常只有一两个标签，重复的代价小。
 *
 * 组按角色数降序，同数按名称排（显式指定中文规则，各环境顺序一致）；「默认」组固定排在最后。
 * 没有任何角色的组不返回：空组只占位置。标签被删掉、找不到实体的 id 当作没标签，角色归「默认」，
 * 免得从列表里消失。
 */
export function groupAgentsByTag(agents: Agent[], tags: Tag[]): AgentTagGroup[] {
  const byId = new Map(tags.map((tag) => [tag.id, tag]))
  const buckets = new Map<string, Agent[]>()
  const loose: Agent[] = []

  for (const agent of agents) {
    // 同一个标签写两遍只算一次，不然同一个组里会出现两行
    const hit = [...new Set(agent.tags)].map((id) => byId.get(id)).filter((tag): tag is Tag => !!tag)
    if (!hit.length) {
      loose.push(agent)
      continue
    }
    for (const tag of hit) {
      const list = buckets.get(tag.id)
      if (list) list.push(agent)
      else buckets.set(tag.id, [agent])
    }
  }

  const groups: AgentTagGroup[] = [...buckets].map(([id, items]) => {
    const tag = byId.get(id) as Tag
    return { id, label: tag.name, tag, agents: items }
  })
  groups.sort((a, b) => b.agents.length - a.agents.length || a.label.localeCompare(b.label, 'zh-Hans-CN'))
  if (loose.length) {
    groups.push({ id: DEFAULT_AGENT_GROUP, label: DEFAULT_LABEL, agents: loose })
  }
  return groups
}
