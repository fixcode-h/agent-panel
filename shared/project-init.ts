/**
 * 项目设置里的「AI 初始化项目」：本机 Agent 在项目目录里写好 AGENTS.md 和文档框架，
 * 再按项目实际情况评估工作流、推荐项目设置。推荐项交给页面逐项或整体应用，用户确认保存后才生效。
 *
 * 这里放 CLI 输出的格式、校验和提示词；测试步骤的校验沿用 assist.ts 的 resolveTestSteps。
 */
import { z } from 'zod'
import { promptLangWord } from './prompt-lang.ts'
import { FILE_EOLS, FILE_FORMATS, ParamValue, type TestStep, type Workflow, type WorkflowExpose } from './schema.ts'
import { DEFAULT_SEARCH_EXCLUDE } from './search-exclude.ts'

/** 可以推荐的项目设置：值和项目设置里的字段一一对应 */
export const INIT_SETTINGS = {
  childIsolation: z.enum(['worktree', 'claim']),
  gitPolicy: z.enum(['ask', 'allow', 'deny']),
  encoding: z.enum(FILE_FORMATS),
  eol: z.enum(FILE_EOLS),
  searchExclude: z.array(z.string().trim().min(1).max(120)).max(60),
  wslDistro: z.string().trim().max(60),
  scaledVerify: z.boolean(),
}
export type InitSettingKey = keyof typeof INIT_SETTINGS
export const INIT_SETTING_KEYS = Object.keys(INIT_SETTINGS) as InitSettingKey[]

export type InitSetting = {
  [K in InitSettingKey]: { key: K; value: z.infer<(typeof INIT_SETTINGS)[K]>; reason: string }
}[InitSettingKey]

/** 初始化时写过的文件：页面上列出来，让用户知道动了哪些 */
export interface InitFile {
  path: string
  action: 'created' | 'updated' | 'kept'
  summary: string
}

/** 一个工作流的评估结果：default 设为默认工作流，optional 加进可选工作流，skip 不适用 */
export interface InitWorkflow {
  id: string
  name: string
  verdict: 'default' | 'optional' | 'skip'
  reason: string
}

/** AI 初始化项目的结果：写过的文件 + 推荐的项目设置，用户在项目设置里逐项或整体应用 */
export type ProjectProposal = {
  kind: 'project'
  name: string
  description: string
  /** 项目类型：没评估出默认工作流时按它选内置的「通用项目」或「UE 项目」 */
  type: 'general' | 'ue'
  steps: TestStep[]
  /** 名称、简介、测试步骤、工作流配置各自的推荐理由（key 是 name / description / steps / params） */
  reasons: Record<string, string>
  /** 文档写在哪（相对项目目录或绝对路径） */
  docRoot: string
  files: InitFile[]
  workflows: InitWorkflow[]
  /** 默认工作流暴露项的推荐值，已按暴露项的类型校验 */
  params: Record<string, ParamValue>
  settings: InitSetting[]
}

const Reasoned = z.object({ value: z.unknown(), reason: z.string().trim().max(400).catch('').default('') })

/** CLI 输出的初始化结果。除了 name，其余字段出错就丢掉那一项：重来一轮要把整个初始化再跑一遍 */
export const ProjectInitDraft = z.object({
  name: z.string().trim().min(1, 'name 不能为空').max(40, 'name 最多 40 个字'),
  description: z.string().trim().max(200).catch('').default(''),
  type: z.enum(['general', 'ue']).catch('general').default('general'),
  steps: z.array(z.unknown()).max(40).catch([]).default([]),
  reasons: z.record(z.string(), z.string().max(400)).catch({}).default({}),
  docRoot: z.string().trim().max(300).catch('').default(''),
  files: z.array(z.unknown()).max(120).catch([]).default([]),
  workflows: z.array(z.unknown()).max(80).catch([]).default([]),
  params: z.record(z.string(), z.unknown()).catch({}).default({}),
  settings: z.record(z.string(), z.unknown()).catch({}).default({}),
})

const FileDraft = z.object({
  path: z.string().trim().min(1).max(300),
  action: z.enum(['created', 'updated', 'kept']).catch('updated').default('updated'),
  summary: z.string().trim().max(300).catch('').default(''),
})
const WorkflowDraft = z.object({
  name: z.string().trim().min(1),
  verdict: z.enum(['default', 'optional', 'skip']).catch('skip').default('skip'),
  reason: z.string().trim().max(400).catch('').default(''),
})

/** 按暴露项的类型校验一个值；不合法返回 undefined */
export function exposeValue(e: WorkflowExpose, v: unknown): ParamValue | undefined {
  if (e.type === 'bool') return typeof v === 'boolean' ? v : undefined
  if (e.type === 'multi') {
    if (!Array.isArray(v)) return undefined
    const list = v.filter((x): x is string => typeof x === 'string' && (!e.options.length || e.options.includes(x)))
    return list.length === v.length ? list : undefined
  }
  if (e.type === 'select') return typeof v === 'string' && e.options.includes(v) ? v : undefined
  const p = ParamValue.safeParse(typeof v === 'number' ? String(v) : v)
  return p.success && typeof p.data === 'string' ? p.data : undefined
}

/**
 * 校验并整理 CLI 给出的初始化结果：工作流名字换成 id、最多一个默认工作流，
 * 工作流配置只留默认工作流暴露项里合法的值，设置项只留认识的 key 和合法的值
 */
export function resolveProjectInit(
  d: z.infer<typeof ProjectInitDraft>,
  workflows: Workflow[],
  defaultChoices: string[],
): Omit<ProjectProposal, 'steps'> {
  const files = d.files.flatMap((f) => {
    const p = FileDraft.safeParse(f)
    return p.success ? [p.data] : []
  })
  const seen = new Set<string>()
  let hasDefault = false
  const evaluated = d.workflows.flatMap((x): InitWorkflow[] => {
    const p = WorkflowDraft.safeParse(x)
    if (!p.success) return []
    const w = workflows.find((w) => w.name === p.data.name) ?? workflows.find((w) => w.id === p.data.name)
    if (!w || seen.has(w.id)) return []
    seen.add(w.id)
    let verdict = p.data.verdict
    // 默认工作流只能从「项目」分类里选，而且只有一个；多给的降成可选
    if (verdict === 'default' && (hasDefault || (defaultChoices.length && !defaultChoices.includes(w.id))))
      verdict = 'optional'
    if (verdict === 'default') hasDefault = true
    return [{ id: w.id, name: w.name, verdict, reason: p.data.reason }]
  })
  const def = workflows.find((w) => w.id === evaluated.find((x) => x.verdict === 'default')?.id)
  const params: Record<string, ParamValue> = {}
  if (def)
    for (const [k, v] of Object.entries(d.params)) {
      const e = def.expose.find((e) => e.key === k)
      const val = e && exposeValue(e, v)
      if (val !== undefined) params[k] = val
    }
  const settings: InitSetting[] = []
  for (const key of INIT_SETTING_KEYS) {
    const raw = d.settings[key]
    if (raw === undefined) continue
    // 允许直接写值，也允许写成 { value, reason }
    const r = Reasoned.safeParse(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : { value: raw })
    if (!r.success) continue
    const v = INIT_SETTINGS[key].safeParse(r.data.value)
    if (v.success) settings.push({ key, value: v.data, reason: r.data.reason } as InitSetting)
  }
  return {
    kind: 'project',
    name: d.name,
    description: d.description,
    type: d.type,
    reasons: d.reasons,
    docRoot: d.docRoot,
    files,
    workflows: evaluated,
    params,
    settings,
  }
}

/** 提示词里列出的工作流：名称、说明、能不能当默认，以及默认工作流可以配的暴露项 */
function workflowList(workflows: Workflow[], defaultChoices: string[]) {
  if (!workflows.length)
    return '（面板里还没有添加任何工作流：workflows 输出空数组，在说明里建议用户到「工作流」页添加需要的内置工作流）'
  return workflows
    .map((w) => {
      const canDefault = !defaultChoices.length || defaultChoices.includes(w.id)
      const expose = canDefault
        ? w.expose
            .map((e) => {
              const opts = e.options.length ? `，可选：${e.options.map((o) => `"${o}"`).join('、')}` : ''
              const def = e.default === undefined ? '' : `，默认 ${JSON.stringify(e.default)}`
              return `    - ${e.key}（${e.label || e.key}，${e.type}${opts}${def}）${e.description ? `：${e.description}` : ''}`
            })
            .join('\n')
        : ''
      return [`- 「${w.name}」${canDefault ? '（可作默认）' : ''}${w.description ? `：${w.description}` : ''}`, expose]
        .filter(Boolean)
        .join('\n')
    })
    .join('\n')
}

/** AI 初始化项目的提示词：写 AGENTS.md 和文档框架，再评估工作流、推荐设置 */
export function buildProjectInitPrompt(opts: {
  path: string
  platform: string
  scan: string
  rules: string
  convo: string
  workflows: Workflow[]
  defaultChoices: string[]
}) {
  const lang = promptLangWord()
  return [
    '你是「Agent 面板」里的项目初始化助手，正在**初始化一个项目**：为它写好 Agent 用的 AGENTS.md 和项目文档框架，再按项目的实际情况评估可用的工作流、推荐项目设置。面板会把你的推荐列给用户，用户逐项或整体应用后保存。',
    `项目目录是 ${opts.path}。当前系统：${opts.platform || '未知'}。`,
    opts.scan ? `## 面板按文件规则扫出来的线索（可能不全或不准，以你实际看到的为准）\n${opts.scan}` : '',
    `## 第一步：读项目（只读）
读已有的 AGENTS.md / CLAUDE.md / README / 文档目录；依赖清单和构建配置（package.json、Cargo.toml、go.mod、*.uproject、*.sln、CMakeLists.txt 等）；scripts、Makefile、CI 配置；格式和检查配置（.editorconfig、Prettier、ESLint、clang-format 等）；一级和二级目录。Git 项目看一下最近 20 条提交说明。不要对整个源码树全文搜索。`,
    `## 第二步：写文档
有 project-documentation 技能时按它的「初始化」一节和 templates.md 的骨架做；没有时按下面的要求：
1. **确定文档根 DOC_ROOT**：项目里已有 docs/、doc/ 就用它；没有用 <项目>/docs；P4 项目（目录或上层有 .p4config / .p4ignore）放到 <共同外层目录>/ProjectDoc/doc/<项目文件夹名>，不写回项目目录。
2. **AGENTS.md**（项目根）：不存在就新建，包含一句话项目说明、技术栈和目录速览、硬规则（从现有约定和检查配置里读出来的）、常用命令（只写项目里真实存在的命令）、文档地图（指向 DOC_ROOT 的 README 和 MODULE-MAP）、提交前要过的检查。已存在就保留原有内容和结构，只补缺的段落、修正和项目实际不符的命令和路径。整份控制在 150 行以内。
3. **CLAUDE.md**：不存在时新建，只写一行 \`@AGENTS.md\`；已存在但没引用 AGENTS.md 时在末尾加一行 \`@AGENTS.md\`，原有内容不删。
4. **DOC_ROOT/README.md**：项目是什么、快速开始、文档索引。**DOC_ROOT/MODULE-MAP.md**：模块表（模块、路径、职责、入口、文档链接、状态）。已有的人工文档不覆盖，只补缺的。
5. **模块文档**：按职责选出 3–15 个模块（代码都在 src/ 下就往下一层；monorepo 按包；UE 按 Source/<模块> 和 Plugins/<插件>），各建 DOC_ROOT/modules/<模块>/README.md，开头写状态行（status: inferred、source_paths、entry、analyzed_at），正文写职责、入口、依赖、回归验证和待确认项。小项目（不到 3 个职责块）不拆模块。不建 bugs.md。
6. 没有内容依据的目录和文件（adr/、tech/、runbooks/、openspec/、CONTEXT.md）不建空的。推断的内容标「（待确认）」。
**只许写上面这些文档文件。不许改源码和配置、不许安装依赖、不许提交或推送、不许执行有副作用的命令。**`,
    `## 第三步：评估工作流和设置
面板里已有的工作流：
${workflowList(opts.workflows, opts.defaultChoices)}

逐个评估：最适合当子对话默认流程的一个标 default（只能从「可作默认」的里选）；项目里确实会用到、可以在需求更合适时改用的标 optional；用不上的标 skip。每个写一句依据（项目里的事实）。
默认工作流的暴露项：按项目实际情况给出要改的值（例如文档根填 DOC_ROOT、UE 项目的结构技能），保持默认的不写。

项目设置（只写有依据要推荐的项，每项给 value 和 reason）：
- childIsolation：worktree（Git 项目，每个子对话在独立分支目录里改）或 claim（共用目录 + 认领文件；P4、SVN 和没有版本控制的项目用它）
- gitPolicy：ask（第一次需要推送时问一次，一般推荐）、allow（直接推送）、deny（只做本地提交）
- encoding：utf8 或 utf8-bom；eol：lf 或 crlf。按 .editorconfig、.gitattributes 和现有文件的实际情况
- searchExclude：除了内置的 ${DEFAULT_SEARCH_EXCLUDE.join('、')} 以外，这个项目里搜索时还该跳过的目录（编译产物、缓存、生成代码、大资源目录），写相对名字
- wslDistro：测试步骤里有必须在 WSL 跑的步骤时用哪个发行版，没有就不写
- scaledVerify：true 时小改动只跑标了 quick 的步骤；完整测试特别慢（例如 UE 编译）时推荐 true

测试步骤 steps：Agent 按它执行构建、测试、检查，每条都要能直接跑。字段：id（简短英文标识）、name、command（项目里真实存在的命令）、env（auto / wsl / powershell / cmd / bash，不确定就 auto；Windows 上默认走 Git Bash，只有确实必须在 WSL 里跑的才标 wsl）、cwd（相对项目根）、when、timeoutSec（0 不限）、note、enabled、quick（几十秒内跑完的检查标 true）。先静态检查和单元测试，再端到端和构建。`,
    opts.rules.trim() ? `## 用户补充的规则（优先遵守）\n${opts.rules.trim()}` : '',
    `## 输出格式
先用三五句${lang}说明：项目是做什么的、写了哪些文档、推荐的要点和需要用户注意的地方。
然后输出且只输出一个 \`\`\`json 代码块，字段名不能改，没有依据的字段可以不写：
\`\`\`json
{
  "name": "官网前端",
  "description": "公司官网的前端，React + Vite。",
  "type": "general",
  "reasons": { "name": "package.json 的 name", "description": "README 第一段", "steps": "按 package.json 的 scripts", "params": "文档已写在 docs/" },
  "docRoot": "docs",
  "files": [ { "path": "AGENTS.md", "action": "created", "summary": "项目说明、常用命令、文档地图" } ],
  "workflows": [ { "name": "通用项目", "verdict": "default", "reason": "Node 项目，日常改动走通用流程" } ],
  "params": { "docRoot": "docs" },
  "settings": { "childIsolation": { "value": "worktree", "reason": "Git 仓库" } },
  "steps": [ { "id": "node-typecheck", "name": "类型检查", "command": "npm run typecheck", "env": "auto", "quick": true } ]
}
\`\`\`
files 的 action：created 新建、updated 修改了已有文件、kept 已有且没改。`,
    `## 对话\n${opts.convo}`,
    '请回复用户最后一条消息。',
  ]
    .filter(Boolean)
    .join('\n\n')
}
