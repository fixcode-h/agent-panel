/**
 * 先建模块文档再开子对话（ADR 0048）：协调器 create_conversation 时写 modules（这次涉及的模块名，还没文档的写目录名）。
 * 有模块还没有模块文档时面板拦下，告诉它先并行派「文档·模块分析」，结果推回来后再用同样的参数建子对话；
 * 都有文档时把文档路径附进派单，子对话不用自己再找。
 * 为什么不由面板自己等文档建完再开：模块分析要几分钟，CLI 的一次工具调用一分钟就超时；
 * 拦下并说清下一步，分析结果会自动推回这一轮，协调器接着建，不用跨轮记住。
 * 放在单独的文件里：engine.ts、orch-mcp.ts 都到了行数上限
 */

/** 宿主查模块文档：给模块名，回文档根和每个模块的 README 路径（不存在的列进 missing） */
export type ModuleDocsLookup = (
  modules: string[],
) => Promise<{ root: string; found: Record<string, string>; missing: string[] }>

export interface DocsFirstInput {
  modules?: string[]
  /** 不先建文档的理由（分析失败、一次性的小改动）：写了就放行，记进派单 */
  skipDocs?: string
}

/** 模块名只取目录名的样子：去掉首尾斜杠、modules/ 前缀和 README.md，空的丢掉 */
const clean = (xs: string[]) => [
  ...new Set(
    xs
      .map((x) =>
        x
          .trim()
          .replace(/^\/+|\/+$/g, '')
          .replace(/^(docs\/)?modules\//, '')
          .replace(/\/README\.md$/, ''),
      )
      .filter(Boolean),
  ),
]

/**
 * 建子对话之前的检查。返回 block 时不建，把 info 原样交给协调器；返回 note 时把它接在派单后面。
 * 没有查文档的宿主（演示、测试）、没写 modules、角色关了「先建文档」时什么都不做
 */
export async function docsFirst(
  input: DocsFirstInput,
  lookup: ModuleDocsLookup | undefined,
  enabled: boolean,
): Promise<{ block?: string; note?: string }> {
  const modules = clean(input.modules ?? [])
  if (!lookup || !modules.length) return {}
  const r = await lookup(modules).catch(() => null)
  if (!r) return {}
  const have = Object.entries(r.found)
  const docs = have.length
    ? `\n\n## 模块文档（先读，在它基础上查）\n${have.map(([m, p]) => `- ${m}：${p}`).join('\n')}`
    : ''
  if (!r.missing.length) return { note: docs }
  const skip = input.skipDocs?.trim()
  if (!enabled || skip)
    return {
      note: `${docs}\n\n## 还没有模块文档的模块\n${r.missing.map((m) => `- ${m}`).join('\n')}${skip ? `\n（没先建文档：${skip}）` : ''}\n读明白的要点写进交接摘要的「建议补模块文档」，由父对话交「文档」写。`,
    }
  return {
    block: `没有建子对话：这些模块还没有模块文档：${r.missing.join('、')}（文档根 ${r.root}）。先建文档再派单，子对话从文档读起就不用从头摸索：
1. 用 spawn_agents 给每个模块派一个「文档」子任务，params 写 {"task": "模块分析"}，几个一起派、能并行就并行；instructions 写模块名或目录、你提炼的关键词和用户原话，带上这次的 step。
2. 结果推回来后，用同样的参数再调用一次 create_conversation（modules 不变），面板会把新文档的路径附进派单。
模块分析失败、或者这次确实不值得先建文档（一次性的小改动）时，在 skip_docs 里写明理由再调用。`,
  }
}
