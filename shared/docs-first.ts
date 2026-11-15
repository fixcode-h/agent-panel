/**
 * 先建模块文档再开子对话（ADR 0048）：协调器 create_conversation 时写 modules（这次涉及的模块名，还没文档的写目录名）。
 * 有模块还没有模块文档时面板拦下，告诉它先并行派「文档·模块分析」，结果推回来后再用同样的参数建子对话
 * （用户报的 Bug 例外：照建，同时派文档，见 docsFirst）；
 * 都有文档时把文档路径附进派单，子对话不用自己再找。
 * 为什么不由面板自己等文档建完再开：模块分析要几分钟，CLI 的一次工具调用一分钟就超时；
 * 拦下并说清下一步，分析结果会自动推回这一轮，协调器接着建，不用跨轮记住。
 * 放在单独的文件里：engine.ts、orch-mcp.ts 都到了行数上限
 */

/**
 * 小项目（源文件不超过这么多个）不单建模块文档（摸底报告第 7 条，2026-11-15 用户定）：实测里改一个函数先等
 * 「文档·模块分析」十分钟、两百多万 token；这种项目把源文件清单附进派单，子对话直接读更快
 */
export const SMALL_PROJECT_FILES = 10
/** 算「源文件」的扩展名：文档、配置、数据不算 */
export const CODE_FILE =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|kts|cs|c|cc|cpp|cxx|h|hh|hpp|lua|rb|php|swift|m|mm|vue|svelte|dart|scala|sh|ps1)$/i

/** 宿主查模块文档：给模块名，回文档根和每个模块的 README 路径（不存在的列进 missing）；小项目带上源文件清单（small） */
export type ModuleDocsLookup = (
  modules: string[],
) => Promise<{ root: string; found: Record<string, string>; missing: string[]; small?: string[] }>

export interface DocsFirstInput {
  modules?: string[]
  /** 用户报的 Bug（kind: "bug"）：不拦，文档和 Bug 子对话并行（分析稿 B11） */
  bug?: boolean
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
 * 建子对话之前的检查。返回 block 时不建，把它原样交给协调器；返回 note 时把它接在派单后面；
 * info 接在建好后给协调器的返回里（Bug 并行派文档的说明）。
 * 没有查文档的宿主（演示、测试）、没写 modules、角色关了「先建文档」时什么都不做
 */
export async function docsFirst(
  input: DocsFirstInput,
  lookup: ModuleDocsLookup | undefined,
  enabled: boolean,
): Promise<{ block?: string; note?: string; info?: string }> {
  const modules = clean(input.modules ?? [])
  if (!lookup) return {}
  // 没写 modules 门禁就被绕过了（2026-11-03 真实 API 实测：设定里写了要写，模型照样不写）：开着「先建文档」时拦下要它写上
  if (!modules.length)
    return enabled && !input.skipDocs?.trim()
      ? {
          block:
            '没有建子对话：create_conversation 要写 modules，写这次涉及的模块（模块地图里的模块名；还没写文档的写目录名，例如 src/calc）。面板按它查模块文档：有就把路径附进派单，没有就先让「文档」分析。确实不涉及具体模块（只写文档、纯调研）时在 skip_docs 写明理由。',
        }
      : {}
  const r = await lookup(modules).catch(() => null)
  if (!r) return {}
  const have = Object.entries(r.found)
  const docs = have.length
    ? `\n\n## 模块文档（先读，在它基础上查）\n${have.map(([m, p]) => `- ${m}：${p}`).join('\n')}`
    : ''
  if (!r.missing.length) return { note: docs }
  if (r.small)
    return {
      note: `${docs}\n\n## 模块说明（项目只有 ${r.small.length} 个源文件，不单建模块文档）\n${r.small.map((f) => `- ${f}`).join('\n') || '- （还没有源文件）'}\n直接读这些文件，不用先找文档。`,
    }
  const skip = input.skipDocs?.trim()
  if (!enabled || skip)
    return {
      note: `${docs}\n\n## 还没有模块文档的模块\n${r.missing.map((m) => `- ${m}`).join('\n')}${skip ? `\n（没先建文档：${skip}）` : ''}\n读明白的要点写进交接摘要的「建议补模块文档」，由父对话交「文档」写。`,
    }
  // 用户报的 Bug 不等文档（分析稿 B11）：实跑时小项目先等「文档·模块分析」做完才派 Bug，多等了约 3 分钟。
  // Bug 子对话第一步是立案和复现，用不着模块文档；两件事并行，文档写好后由父对话转给它
  if (input.bug)
    return {
      note: `${docs}\n\n## 还没有模块文档的模块\n${r.missing.map((m) => `- ${m}`).join('\n')}\n父对话在同时派「文档」分析这些模块，写好后会把文档路径转给你；在那之前先立案、复现，按模块地图和目录结构定位，不用等它。`,
      info: `这些模块还没有模块文档：${r.missing.join('、')}（文档根 ${r.root}）。Bug 子对话已经开始查，不用等文档：现在就用 spawn_agents 给每个模块派一个「文档」子任务（params 写 {"task": "模块分析"}，instructions 写模块名或目录、关键词和用户原话，带上这次的 step），和 Bug 子对话并行；文档结果回来后用 send_to_conversation 把文档路径转给这个 Bug 子对话。`,
    }
  return {
    block: `没有建子对话：这些模块还没有模块文档：${r.missing.join('、')}（文档根 ${r.root}）。先建文档再派单，子对话从文档读起就不用从头摸索：
1. 用 spawn_agents 给每个模块派一个「文档」子任务，params 写 {"task": "模块分析"}，几个一起派、能并行就并行；instructions 写模块名或目录、你提炼的关键词和用户原话，带上这次的 step。
2. 结果推回来后，用同样的参数再调用一次 create_conversation（modules 不变），面板会把新文档的路径附进派单。新文档不要单独提交：面板开子对话的独立分支时把它带过去，随子对话的改动一起合回。
模块分析失败、或者这次确实不值得先建文档（一次性的小改动）时，在 skip_docs 里写明理由再调用。`,
  }
}
