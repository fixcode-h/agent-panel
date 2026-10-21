import { type Agent, type ParamValues, type TestStep, type Workflow } from '../schema.ts'
import { autoLayout, END, entryFlow, START, topoOrder, workflowClosure } from '../flow.ts'
import { applyExpose } from '../expose.ts'
import { isTestAgent, testStepsBlock } from '../test-steps.ts'
import { workflowAgentIds } from '../agent-params.ts'
import { t } from '../i18n.ts'

/**
 * 自带的「默认」工作流：什么都可以丢给它（问问题、找资料、分析项目、排查问题、小改动……），
 * 它给出结果，再从用户已有的工作流里推荐下一步，界面上点一下就执行。
 * 它是唯一不用手动添加的内置项：新建任务的默认入口，不能删除。
 * 节点不用角色、直接跟随默认 CLI，角色页不会多出一个删不掉的条目。
 */
export const DEFAULT_WORKFLOW_ID = 'default-workflow'

/** Agent 在结果末尾写推荐用的代码块语言名 */
const NEXT_LANG = 'next-workflows'
/** 最多推荐几个 */
export const MAX_NEXT = 3

const DOCUMENT = `## 适用
什么都可以交给这个工作流：回答问题、查资料、读代码、分析项目结构、排查问题、评估方案、做小的改动。
它先把事情做完、给出结果，再推荐用哪个现有工作流做下一步。

## 约定
- 先判断用户要的是什么（回答、分析、排查、改动），按需要读项目里的文件，结论要有依据（文件路径、命令输出）。
- 回答和分析直接给结果，不要只列计划。
- 只做小而明确的改动；需要完整流程的大功能、跨模块重构、正式的 Bug 修复，不要自己动手，写清楚分析结论，推荐对应的工作流去做。
- 不做不可逆的操作（删除大量文件、推送、提交到远端）。`

const INSTRUCTIONS = `处理用户的需求，给出结果。

1. 判断类型：问题解答 / 资料查找 / 项目或代码分析 / 问题排查 / 方案评估 / 小改动 / 其他。
2. 按需要读文件、跑只读命令收集依据，然后完成它。
3. 用中文写结果：开头一两句直接给结论，接着是依据和细节（引用文件路径、行号、命令输出），最后写还没确定或需要用户决定的事。

## 推荐下一步
结果写完后，从「工作流说明」里「可以推荐的工作流」挑出最适合接着做的（最多 ${MAX_NEXT} 个，按推荐程度排序；没有合适的就不推荐）。
在回复的最后单独写一个代码块，语言名写 ${NEXT_LANG}，内容是 JSON 数组，例如：

\`\`\`${NEXT_LANG}
[{"id": "工作流 id", "reason": "为什么推荐，一句话", "prompt": "交给这个工作流的任务描述，写清楚目标和要点"}]
\`\`\`

- id 只能用列表里给出的，不要编造；没有合适的就写 []。
- prompt 要能单独看懂：用户点推荐时，它会连同原始需求和你上面的结果一起交给那个工作流。
- 这个代码块不会显示给用户，界面会把它画成可点击的按钮，所以正文里不用再重复列推荐。`

export function defaultWorkflow(): Workflow {
  const at = new Date(0).toISOString()
  return {
    id: DEFAULT_WORKFLOW_ID,
    createdAt: at,
    updatedAt: at,
    name: t('默认'),
    description: t('什么都可以交给它：分析、排查、找资料、小改动，给出结果并推荐下一步用哪个工作流'),
    mainAgentId: '',
    members: [],
    entryFlowId: 'main',
    categoryId: '',
    tags: [],
    document: DOCUMENT,
    expose: [],
    flows: [
      autoLayout({
        id: 'main',
        name: '主流程',
        description: '',
        startPos: { x: 0, y: 0 },
        endPos: { x: 600, y: 0 },
        nodes: [
          {
            id: 'handle',
            title: '处理并推荐',
            kind: 'agent',
            agentId: '',
            flow: null,
            tier: 'high',
            params: {},
            steps: [],
            retries: 1,
            instructions: INSTRUCTIONS,
            x: 0,
            y: 0,
            hooks: { start: null, review: null, end: null, maxRounds: 3 },
          },
        ],
        edges: [
          { id: 'e1', from: START, to: 'handle' },
          { id: 'e2', from: 'handle', to: END },
        ],
      }),
    ],
  }
}

export const isDefaultWorkflow = (id: string | undefined) => id === DEFAULT_WORKFLOW_ID

/**
 * 交给任务的那份默认工作流：说明后面附上用户现在有的工作流，Agent 只能从这里面推荐。
 * 在新建任务时存进任务快照，之后用户增删工作流不影响已经开始的任务
 */
export function withCatalog(w: Workflow, all: Workflow[]): Workflow {
  if (!isDefaultWorkflow(w.id)) return w
  const others = all.filter((x) => !isDefaultWorkflow(x.id))
  const lines = others.map((x) => {
    const steps = topoOrder(entryFlow(x))
      .map((n) => n.title)
      .filter(Boolean)
      .slice(0, 8)
    return `- id: ${x.id}｜${x.name}${x.description ? `：${x.description}` : ''}${steps.length ? `（步骤：${steps.join(' → ')}）` : ''}`
  })
  const catalog = lines.length
    ? `## 可以推荐的工作流\n${lines.join('\n')}`
    : '## 可以推荐的工作流\n用户还没有其他工作流，推荐写 []。'
  return { ...w, document: `${w.document.trim()}\n\n${catalog}`.slice(0, 50000) }
}

/**
 * 任务里存的那份工作流快照（见 workflowClosure）。项目里填的暴露项和 Agent 参数在这里落进快照：
 * 说明、节点参数、注入的配置定下来，技能槽另存到任务上（见 exposeSlots）。
 * 项目配置的测试步骤也在这时写成工作流说明的一部分，之后改项目设置或工作流都不影响已经开始的对话。
 */
export function taskSnapshot(
  w: Workflow,
  all: Workflow[],
  params: ParamValues = {},
  opts: { agents?: Agent[]; testSteps?: TestStep[]; platform?: string; wslDistro?: string } = {},
) {
  const filled = applyExpose(w, params, opts.agents ?? [])
  const withTests =
    opts.testSteps && opts.agents
      ? withTestSteps(filled, opts.testSteps, opts.platform ?? '', opts.agents, opts.wslDistro)
      : filled
  return workflowClosure(withTests, all).map((x) => withCatalog(x, all))
}

/** 快照里测试步骤那一段的标题，用来在重新生成时替换而不是叠加 */
const TEST_PART = '## 项目测试步骤'

/**
 * 把项目的测试步骤注入工作流说明。
 * 只注入真的用到了测试 Agent 的工作流：评审、建模这类流程看到这份步骤没有意义，还占上下文。
 * 说明里已经有这一段时替换掉，重复解析不会叠加。
 */
export function withTestSteps(
  w: Workflow,
  steps: TestStep[],
  platform: string,
  agents: Agent[],
  wslDistro = '',
): Workflow {
  const ids = new Set(workflowAgentIds(w))
  const used = agents.some((a) => ids.has(a.id) && isTestAgent(a))
  if (!used) return w
  const base = w.document.split(TEST_PART)[0].trim()
  return { ...w, document: [base, testStepsBlock(steps, platform, wslDistro)].filter(Boolean).join('\n\n') }
}

export interface NextWorkflow {
  id: string
  reason: string
  prompt: string
}

const BLOCK = new RegExp('```' + NEXT_LANG + '[^\\n]*\\n([\\s\\S]*?)```', 'g')

/** 从 Agent 的回复里读出推荐（最后一个推荐块）；只留用户现在还有的工作流，按 id 认，认不出时按名字 */
export function parseNext(text: string, workflows: Pick<Workflow, 'id' | 'name'>[]): NextWorkflow[] {
  const blocks = [...text.matchAll(BLOCK)]
  const last = blocks.at(-1)
  if (!last) return []
  let raw: unknown
  try {
    raw = JSON.parse(last[1].trim() || '[]')
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const out: NextWorkflow[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const key = String(o.id ?? '').trim()
    const hit =
      workflows.find((w) => w.id === key) ?? workflows.find((w) => w.name === key || w.name === String(o.name ?? ''))
    if (!hit || isDefaultWorkflow(hit.id) || out.some((x) => x.id === hit.id)) continue
    out.push({ id: hit.id, reason: String(o.reason ?? '').trim(), prompt: String(o.prompt ?? '').trim() })
    if (out.length >= MAX_NEXT) break
  }
  return out
}

/** 显示时去掉推荐块（界面另外画成按钮）；流式输出到一半、还没写结束标记时去掉到结尾 */
export function stripNext(text: string) {
  if (!text.includes('```' + NEXT_LANG)) return text
  return text
    .replace(BLOCK, '')
    .replace(new RegExp('```' + NEXT_LANG + '[\\s\\S]*$'), '')
    .trimEnd()
}

/** 点推荐时交给那个工作流的任务描述：推荐的任务 + 原始需求 + 默认工作流的结果 */
export function handoffPrompt(next: NextWorkflow, original: string, result: string, max = 20000) {
  const head = next.prompt || original
  const parts = [
    head,
    '## 之前的上下文（来自「默认」工作流）',
    next.prompt && original.trim() !== next.prompt ? `### 原始需求\n${original.trim()}` : '',
    next.reason ? `### 推荐理由\n${next.reason}` : '',
  ].filter(Boolean)
  const fixed = parts.join('\n\n')
  // 结果放最后，太长时截掉结果的尾部，保证任务描述和原始需求完整
  const room = max - fixed.length - 40
  const body = stripNext(result).trim()
  const clipped = body.length > room ? body.slice(0, Math.max(0, room)) + '\n…（后面省略）' : body
  return body && room > 200 ? `${fixed}\n\n### 分析结果\n${clipped}` : fixed.slice(0, max)
}
