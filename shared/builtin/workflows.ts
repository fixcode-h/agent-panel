import type {
  Flow,
  FlowEdge,
  FlowNode,
  NodeHooks,
  NodeStep,
  ParamValues,
  WorkflowExpose,
  WorkflowInput,
} from '../schema.ts'
import { autoLayout } from '../flow.ts'
import { END, START } from '../schema.ts'
import { DOC_PLACE_SIBLING, DOC_PLACES } from '../doc-root.ts'

/**
 * 内置工作流：项目常驻的「通用项目」「UE 项目」，加上规范开发、迁移、架构、评审、依赖和发布准备；美术资产链（Blender）在插件仓库 fixcode-h/agent-plugins 的 Blender 插件里（ADR 0059）。
 * 启动时全部自动装一次（见 install.ts 的 seedProjectWorkflows），用户删掉的不再装回来。
 * 工作流只由父对话启动，是父对话名下的一次工作流运行（ADR 0053）；改代码的只做到「实现 + 快速检查 + 文档同步」，
 * 评审、完整测试和合回由那个子对话的执行角色收尾（见 CHILD_RULES）。when / notFor / kind 是父对话挑工作流看的。
 * 节点里的 agent 写内置 Agent 的 key（./agents.ts），装的时候换成本机的 Agent id。
 * 节点说明是交给 CLI 的提示词，不翻译。
 */
interface NodeStepSpec {
  id: string
  title: string
  agent: string
  tier?: FlowNode['tier']
  params?: ParamValues
  instructions: string
  /** 这一步完成后执行的验收流程（同一工作流里的流程 id） */
  review?: string
  maxRounds?: number
  /** 这一步完成后等用户确认 */
  confirm?: boolean
  retries?: number
}
interface NodeSpec {
  id: string
  title: string
  /** 单执行者节点用；有 steps 时不需要 */
  agent?: string
  tier?: FlowNode['tier']
  params?: ParamValues
  instructions: string
  /** 按顺序执行的步骤：上一步的输出作为下一步的输入 */
  steps?: NodeStepSpec[]
  /** 完成后执行的验收流程（同一工作流里的流程 id） */
  review?: string
  maxRounds?: number
  /** 完成后等用户确认 */
  confirm?: boolean
  retries?: number
}
interface FlowSpec {
  id: string
  name: string
  description?: string
  nodes: NodeSpec[]
  /** [from, to, 条件]；start / end 是流程的开始和结束 */
  edges: [string, string, ('pass' | 'fail')?][]
}
export type { FlowSpec, NodeSpec, NodeStepSpec }
export interface BuiltinWorkflow {
  key: string
  name: string
  description: string
  /** 放进哪个工作流分类（按名字找，没有就建） */
  category: string
  /** 主 Agent（常驻编排器，也是处理追加要求的那一个） */
  main: string
  members: [string, string][]
  document: string
  /** 对外暴露给项目的配置项 */
  expose?: WorkflowExpose[]
  /** 父对话挑工作流看的（ADR 0044）：什么时候用、什么时候不用、改不改代码。旧定义（legacy-*.ts）没有 */
  when?: string
  notFor?: string
  kind?: 'change' | 'readonly'
  flows: FlowSpec[]
}

/** 「通用项目」的 key：项目没有指定工作流时用它 */
export const GENERAL_KEY = 'project-general'
export const GENERAL_ORIGIN = `builtin:${GENERAL_KEY}`
export const GENERAL_NAME = '通用项目'

/** 「UE 项目」的 key */
export const UE_PROJECT_KEY = 'project-ue'
export const UE_PROJECT_NAME = 'UE 项目'

/** 串起来：a → b → c */
export const chain = (...ids: string[]) => ids.slice(1).map((id, i) => [ids[i], id] as [string, string])

/** 项目结构技能的选择项：所有项目都用 project-structure，UE 项目再加 ue-project-structure（特化会自动带上通用的） */
const STRUCTURE: WorkflowExpose = {
  key: 'projectStructure',
  label: '项目结构技能',
  type: 'select',
  options: ['project-structure', 'ue-project-structure'],
  default: 'project-structure',
  target: 'skill',
  targetId: 'projectStructure',
  description: '统筹和执行用来了解这个项目的目录、构建、测试和运行方式',
}

/** 文档根：P4 项目在项目设置里下拉选（项目外层同级 ProjectDoc/docs 或项目内 docs），见 shared/doc-root.ts */
const DOC_ROOT: WorkflowExpose = {
  key: 'docRoot',
  label: '文档根',
  type: 'select',
  options: DOC_PLACES,
  default: DOC_PLACE_SIBLING,
  target: 'agent',
  targetId: 'docRoot',
  description: '只在 P4 项目里设置：项目外层同级 ProjectDoc/docs 各分支共用、不做 P4 操作，项目内 docs 随项目纳管',
}

/**
 * 改代码的工作流由父对话启动成一次工作流运行（ADR 0053）：流程图跑完后面板接一个固定的「收尾」节点
 * （执行角色补齐并提交，验收流程是评审 → 测试，不通过就修，见 shared/flow-run-wrap.ts），再由父对话合回。
 * 工作流里再放评审、完整验收或提交节点就会重复，还会把顺序弄反（完整测试跑在评审前面）。
 */
const CHILD_RULES = `- 这个工作流由父对话启动成一次工作流运行，只做到「实现 + 快速检查 + 文档同步」：流程图跑完后面板接着收尾（执行角色补齐并提交，再评审、跑完整测试，不通过就修），然后由父对话合回，工作流里不放评审、完整验收和提交节点。
- 实现节点改完只跑项目测试步骤里标「快速」的检查（类型检查、代码检查这类），记下命令和结果；完整测试和编译留到评审之后。
- 要落盘的文档交给「文档」角色写进文档根；Bug 记录只记用户报的 Bug，开发、自测、评审中自己发现的问题不写。
- 推送、PR、submit、合并到主干由父对话决定，子对话不执行、不询问、也不建议。
- 只改任务范围内的文件，不覆盖、不认领用户已有的改动。`

/** 文档同步节点：放在改代码的工作流最后，评审之前做完 */
const DOCS_NODE: NodeSpec = {
  id: 'docs',
  title: '文档同步',
  agent: 'docsync',
  tier: 'low',
  instructions:
    '把这次改动同步进模块文档：职责、入口、数据流或已知问题变了才改，改到的模块还没有文档时补上；没有要更新的写明原因。这次修的是用户报的 Bug 才写 Bug 记录。',
}

/** 「通用项目」：任何类型的项目都能用的常驻流程，也是父对话起正式功能开发时默认用的工作流 */
export const GENERAL: BuiltinWorkflow = {
  key: GENERAL_KEY,
  name: GENERAL_NAME,
  description: '项目默认的工作流：识别现场并确认方案 → 实现并跑快速检查 → 同步文档；评审、完整测试和合回由子对话收尾',
  category: '项目',
  when: '正式的功能开发：跨模块、要先确认方案再动手',
  notFor: '小改动、Bug、问答',
  kind: 'change',
  main: 'orchestrator',
  members: [
    ['orchestrator', '项目对话的统筹：把用户需求分给合适的子对话'],
    ['worker', '子对话的执行者：在对话里直接做；工作流运行的收尾也由它做（补齐提交，按评审和测试意见修）'],
    ['analyst', '识别现场，收敛需求，出方案等你确认'],
    ['developer', '按确认的方案实现'],
    ['docsync', '同步项目文档'],
    ['worklog', '把指定日期各项目做完的事汇总成一份简短的 Markdown 报告'],
  ],
  document: `## 适用
正式的功能开发：跨模块、要先确认方案再动手。小改动、Bug 和问答不走工作流；需要完整规范链路的大功能用「功能开发（OpenSpec）」，改数据结构用「数据与配置迁移」。

## 约定
- 版本控制和文档根在第一个节点识别，后面的节点按它的结论操作。
- 方案确认之前不写代码；确认之后中途不再逐步确认，遇到不可逆操作、需求矛盾、和方案冲突时才停下。
${CHILD_RULES}`,
  expose: [STRUCTURE, DOC_ROOT],
  flows: [
    {
      id: 'main',
      name: '主流程',
      nodes: [
        {
          id: 'design',
          title: '识别现场与方案',
          agent: 'analyst',
          tier: 'high',
          params: { scene: true, scale: 'bounded' },
          confirm: true,
          instructions:
            '先识别现场（版本控制、文档根、已有改动），读 MODULE-MAP 和相关模块文档定位到模块和代码；再用一两句复述这次要做什么，给出简短方案：做法、要改的文件、验证方式、验收标准。不清楚的地方问用户，确认后再进入实现。',
        },
        {
          id: 'impl',
          title: '实现',
          agent: 'developer',
          tier: 'high',
          params: { lang: '多种' },
          retries: 1,
          instructions:
            '按已确认的方案实现，改完跑项目测试步骤里标「快速」的检查并记下命令和结果；完整测试和编译留到评审之后。改动分成几块互不依赖、不改同一个文件时，用 spawn_agents 派子任务并行做，自己负责拆分、取回结果后统一检查。',
        },
        DOCS_NODE,
      ],
      edges: chain(START, 'design', 'impl', 'docs', END),
    },
  ],
}

/** 「UE 项目」：在「通用项目」的基础上换成 UE 的结构技能，编译交给父对话 */
const UE_PROJECT: BuiltinWorkflow = {
  key: UE_PROJECT_KEY,
  name: UE_PROJECT_NAME,
  description: 'UE 项目的工作流：识别与侦察 → 确认方案 → C++ / Lua 实现 → 同步文档；编译由父对话按申请统一做',
  category: '项目',
  when: 'UE 项目里的正式功能开发：跨模块、要先确认方案再动手',
  notFor: '小改动、Bug、问答',
  kind: 'change',
  main: 'orchestrator',
  members: [
    ['orchestrator', '项目对话的统筹：按 UE 的结构和资产规则分派，收到申请时占位编译'],
    ['worker', '子对话的执行者：改代码、做不需要编译的检查，向父对话申请编译'],
    ['explorer', '调研：只读侦察架构、构建、资产和影响面'],
    ['analyst', '出方案等你确认'],
    ['developer', 'C++ / Lua 实现'],
    ['docsync', '同步项目文档'],
  ],
  document: `## 适用
Unreal Engine 项目的 C++ / Lua / 资源改动，Git、P4 或没有版本控制的项目都能用。

## 约定
- 目录、模块、Build.cs / Target.cs、UHT/UBT、资产和 Cook 的规则按 project-structure 和它的 UE 特化 ue-project-structure。
- 版本控制在「识别现场与侦察」自动识别，后面的节点按识别结果操作：Git 只处理本次任务的文件；P4 修改前先 p4 edit / add，最后按 [C++]、[XLSX]、[Lua]、[Other] 分 pending。
- 编译归父对话：子对话和工作流节点都不编译、不 Cook、不启动 Editor，只做不需要编译的检查（Lua 语法、静态检查、对照调用方自查）；评审之后由执行角色向父对话申请编译（独立分支里是 submit_merge 带 build，共用目录是 request_build），编译报错交回来再修。需要 Editor、PIE 或设备的验证登记为延期验证。
${CHILD_RULES}`,
  expose: [{ ...STRUCTURE, default: 'ue-project-structure' }, DOC_ROOT],
  flows: [
    {
      id: 'main',
      name: '主流程',
      nodes: [
        {
          id: 'scout',
          title: '识别现场与侦察',
          agent: 'explorer',
          tier: 'medium',
          params: { scene: true, focus: '综合', stack: 'ue', target: '影响面' },
          instructions:
            '先识别现场（Git 的分支和未提交改动，P4 的 client、stream 和限定路径的 opened，或者没有版本控制）和文档根，结果里写明是哪种版本控制；再围绕这次需求侦察模块、构建和影响面，包括 C++ 与 Lua 的调用边界。',
        },
        {
          id: 'design',
          title: '确认方案',
          agent: 'analyst',
          tier: 'high',
          params: { scale: 'bounded' },
          confirm: true,
          instructions:
            '结合侦察结果给出方案：改动的模块和文件、C++ / Lua 分工、导出和反射边界、验证方式。等用户确认。',
        },
        {
          id: 'impl',
          title: '实现',
          agent: 'developer',
          tier: 'high',
          params: { lang: '多种', tdd: false },
          retries: 1,
          instructions:
            '按已确认的方案实现。C++ 和 Lua 两边互不依赖时可以用 spawn_agents 派子任务并行改，导出和反射边界由你统一核对。P4 项目修改前先 p4 edit / add。不要编译（子任务也不要），有 Lua 改动时做语法检查，记下做了哪些检查；编译由执行角色在评审之后向父对话申请。',
        },
        {
          ...DOCS_NODE,
          instructions:
            '把这次改动同步到识别出的文档根里的模块文档；没有要更新的写明原因。这次修的是用户报的 Bug 才写 Bug 记录。',
        },
      ],
      edges: chain(START, 'scout', 'design', 'impl', 'docs', END),
    },
  ],
}

export const BUILTIN_WORKFLOWS: BuiltinWorkflow[] = [
  GENERAL,
  UE_PROJECT,
  {
    key: 'openspec',
    name: '功能开发（OpenSpec）',
    description:
      '复杂功能的完整链路：识别与前置检查 → 设计压测 → 规范门禁 → 按 tasks 实现 → 延期验证项 → 归档 → 同步文档',
    category: '开发',
    when: '用户要求按规范走，或者项目用 OpenSpec 管需求',
    notFor: '没有规范要求的日常功能',
    kind: 'change',
    main: 'developer',
    members: [
      ['spec', '识别现场与前置检查、写规范、规范门禁、归档'],
      ['analyst', '收敛需求并压测设计'],
      ['developer', '按 tasks 实现'],
      ['tester', '整理延期验证项，请你决定'],
      ['docsync', '同步项目文档'],
    ],
    document: `## 适用
需要完整规范的复杂功能（OpenSpec）。阶段顺序由这个工作流保证，openspec 技能只负责各阶段的产物和门禁。

## 关键门禁
- 前置检查不通过就停下，先把 OpenSpec 环境准备好。
- 设计共识和承载方式（新建规范 / 增补已有规范）一次确认。
- 规范要过门禁：openspec validate 通过、每条需求都有 task 覆盖验证、design 没有「待定」。
- tasks 每条验证通过才勾选，证据写进 acceptance；设计假设被证伪时停下回到设计。
- 归档前：没有未勾选项，每个勾选都有证据；做不了的验证列成延期验证项，由用户决定立即验证还是暂缓。

## 约定
${CHILD_RULES}`,
    flows: [
      {
        id: 'main',
        name: '主流程',
        nodes: [
          {
            id: 'pre',
            title: '识别现场与前置检查',
            agent: 'spec',
            tier: 'low',
            params: { scene: true, stage: '前置检查' },
            instructions: '先识别现场，读文档定位和这次需求相关的模块；再检查 OpenSpec 环境是否就绪。',
          },
          {
            id: 'design',
            title: '设计与压测',
            agent: 'analyst',
            tier: 'high',
            params: { scale: 'architectural', grill: true },
            confirm: true,
            instructions:
              '收敛需求，写一次性的设计摘要（目标、非目标、路线、验收初稿），再用 grilling 压测。最后请用户一次确认两件事：设计共识，以及承载方式（新建规范 / 增补已有的强关联规范）。',
          },
          {
            id: 'propose',
            title: '写规范',
            agent: 'spec',
            tier: 'high',
            params: { stage: '落规范' },
            review: 'gate',
            maxRounds: 3,
            instructions: '按确认的设计和承载方式创建变更，写全 proposal、specs、design、tasks 和 acceptance 骨架。',
          },
          {
            id: 'impl',
            title: '按 tasks 实现',
            agent: 'developer',
            tier: 'high',
            params: { records: false },
            retries: 1,
            instructions:
              '先按 specs 和 tasks 看清这次波及的模块、入口和契约；再按 tasks.md 依次实现：每条先查相关历史 Bug，改完跑这条的验证和项目的快速检查，通过才勾选并把证据写进 acceptance。互不依赖、不改同一批文件的 tasks 可以用 spawn_agents 派子任务并行做，勾选和证据由你统一核对后再写。做不了的验证登记为延期验证。发现设计假设不成立时停下，写明哪条假设、证据和受影响的 tasks。',
          },
          {
            id: 'deferred',
            title: '延期验证项',
            agent: 'tester',
            tier: 'medium',
            params: { scope: '本次改动', regress: false },
            confirm: true,
            instructions:
              '不重跑整套测试（评审后由执行角色统一跑）：把实现中登记的延期验证项列出来，每项写怎么验证、需要什么环境，请用户决定立即验证还是暂缓（暂缓的标为「待用户完成」）。',
          },
          {
            id: 'archive',
            title: '归档',
            agent: 'spec',
            tier: 'medium',
            params: { stage: '归档' },
            instructions: '检查归档门禁后归档这次变更。',
          },
          {
            ...DOCS_NODE,
            instructions:
              '把这次变更涉及的模块文档同步好（归档后的主 specs 不用再抄一遍）；没有要更新的写明原因。这次修的是用户报的 Bug 才写 Bug 记录。',
          },
        ],
        edges: [
          ['start', 'pre'],
          ['pre', 'design', 'pass'],
          ...chain('design', 'propose', 'impl', 'deferred', 'archive', 'docs', END),
        ],
      },
      {
        id: 'gate',
        name: '规范门禁',
        description: '检查规范是否能进入实现',
        nodes: [
          {
            id: 'gate',
            title: '规范门禁',
            agent: 'spec',
            tier: 'medium',
            params: { stage: '规范门禁' },
            instructions: '检查上面「输入」里的规范。',
          },
        ],
        edges: chain(START, 'gate', END),
      },
    ],
  },
  {
    key: 'migration',
    name: '数据与配置迁移',
    description: '改 schema、数据格式或配置结构：先定兼容策略，迁移和回滚成对写，用旧数据验证，最后才切默认值',
    category: '开发',
    when: '改 schema、数据格式、配置结构，要兼容旧数据',
    notFor: '只加一个可选字段这类不影响旧数据的改动',
    kind: 'change',
    main: 'developer',
    members: [
      ['analyst', '确认迁移范围、读写方和兼容策略（一次性 / 双写 / 懒迁移）'],
      ['developer', '写迁移脚本、回滚和兼容读取'],
      ['tester', '用旧数据样本验证迁移与回滚'],
      ['docsync', '写迁移方案、兼容策略和回滚步骤'],
    ],
    document: `## 适用
表结构、本地数据文件、配置格式、存档格式这类「旧数据还在用」的改动。普通功能开发用「通用项目」，不要为了改字段走这个流程。

## 约定
- 先定兼容策略再写代码：一次性迁移 / 双读写 / 懒迁移，三选一并写理由；不可逆的步骤要单独标出来。
- 迁移和回滚必须成对写，并且都能重跑（幂等）；没有回滚方案的迁移不算完成。
- 用真实的旧数据样本验证，不能只验证新格式；样本从哪来、怎么脱敏要写清楚。
- 切默认值（删旧字段、删旧读取路径）放到最后一步，确认线上 / 用户数据都迁完再做。
${CHILD_RULES}`,
    flows: [
      {
        id: 'main',
        name: '主流程',
        nodes: [
          {
            id: 'plan',
            title: '范围与兼容策略',
            agent: 'analyst',
            tier: 'high',
            params: { scene: true, scale: 'architectural' },
            confirm: true,
            instructions:
              '识别现场后确认：要迁哪些数据结构、所有读写这些数据的路径（含外部调用方和已有数据文件）、能不能停服、选哪种兼容策略（一次性 / 双写 / 懒迁移）。给出迁移和回滚的步骤，等用户确认。',
          },
          {
            id: 'impl',
            title: '实现迁移与回滚',
            agent: 'developer',
            tier: 'high',
            params: { tdd: true },
            retries: 1,
            instructions:
              '先写迁移失败的测试（用旧数据样本），再写迁移、回滚和兼容读取。迁移脚本必须幂等、能重跑；每一步在大数据量下的耗时和失败处理写清楚。改完跑快速检查。',
          },
          {
            id: 'verify',
            title: '旧数据验证',
            agent: 'tester',
            tier: 'medium',
            params: { scope: '本次改动', env: '自动', regress: false, onFail: '只报告', write: true },
            confirm: true,
            instructions:
              '只验证迁移本身（整套测试评审后由执行角色跑）：在旧数据样本上跑迁移 → 校验 → 回滚 → 再迁移，确认数据没有丢失或重复。跑完把结果和剩下的风险列清楚，请用户决定是否可以切默认值。',
          },
          {
            ...DOCS_NODE,
            instructions: '把迁移方案、兼容策略和回滚步骤写进相关模块文档；定下了以后不好改的格式或策略时写 ADR。',
          },
        ],
        edges: chain(START, 'plan', 'impl', 'verify', 'docs', END),
      },
    ],
  },
  {
    key: 'architecture',
    name: '架构设计',
    description: '识别现场并出候选方案 → 压测并确认 → 写成架构文档和 ADR',
    category: '规划',
    when: '要出候选方案、做取舍、写 ADR',
    notFor: '已经定了方案的实现',
    kind: 'change',
    main: 'analyst',
    members: [
      ['analyst', '识别现场，读已有的架构文档，给候选方案和架构契约，再压测方案'],
      ['docsync', '写架构文档和 ADR'],
    ],
    document: `## 适用
新项目、新模块的架构，或者现有架构的评审和调整。只出设计和文档，不写实现代码。`,
    flows: [
      {
        id: 'main',
        name: '主流程',
        nodes: [
          {
            id: 'arch',
            title: '识别现场与候选方案',
            agent: 'analyst',
            tier: 'high',
            params: { scene: true, scale: 'architectural' },
            instructions:
              '先识别现场，读已有的架构文档、ADR 和相关模块的 README；再给出 2–4 个候选方案和推荐方案的架构契约。',
          },
          {
            id: 'grill',
            title: '压测并确认',
            agent: 'analyst',
            tier: 'high',
            params: { scale: 'architectural', grill: true },
            confirm: true,
            instructions: '用 grilling 压测推荐方案，把决策点整理好，请用户确认最终方案。',
          },
          {
            id: 'docs',
            title: '写文档',
            agent: 'docsync',
            tier: 'medium',
            // 架构流程定下来的都是长期决策，ADR 一律写
            params: { adr: '总是' },
            instructions: '把确认的方案写进架构文档；长期决策写成 ADR 并登记索引；新术语更新 CONTEXT.md。',
          },
        ],
        edges: chain(START, 'arch', 'grill', 'docs', END),
      },
    ],
  },
  {
    key: 'review',
    name: '代码评审',
    description: '只读：先把评审范围整理成交接单，再只评改动的行，给出分级评审意见',
    category: '质量',
    when: '用户要求评审一段改动（分支、提交区间或 changelist）',
    notFor: '子对话收尾前的评审（执行角色自己派）',
    kind: 'readonly',
    main: 'reviewer',
    members: [
      ['explorer', '调研：列出评审范围内的改动，整理评审交接单'],
      ['reviewer', '只评差异里改动的行，给出分级评审意见'],
    ],
    document: `## 适用
评审一个分支、一组提交或一个 P4 changelist。全程只读，不改文件、不提交。
在任务描述里写清评审范围（分支、提交区间或 changelist 号）。子对话收尾前的评审不用这个工作流，执行角色直接派「评审」。

## 约定
- 评审只评差异里以 + / - 开头的行，没改的代码不评；唯一例外是改动让没改的代码出错（改了签名、返回值、默认值、数据格式而调用方没跟），报在改动那一行。
- 评审要用的背景由前一个节点整理成交接单交给它，评审自己不读模块地图、模块文档和 bugs.md，不全局搜索，也不跑测试。
- 意见分四级：🔴 高级、🟠 中级、🟡 低级、💡 建议；评审结论交给用户逐条判断，不自动采纳。`,
    flows: [
      {
        id: 'main',
        name: '主流程',
        nodes: [
          {
            id: 'brief',
            title: '整理评审交接单',
            agent: 'explorer',
            tier: 'low',
            params: { target: '影响面', tests: false },
            instructions:
              '按任务里写的评审范围列出改动的文件（git diff --stat / p4 describe -s），整理成评审交接单：goal（这批改动要做什么、验收标准，从提交说明和关联需求里摘）、changes（按文件或模块写改了什么）、context（差异里看不到、判断又要用的事实：调用方怎么用、上游保证了什么、相关接口签名）、focus（最值得重点看的地方）。只整理事实，不评对错。',
          },
          {
            id: 'review',
            title: '评审意见',
            agent: 'reviewer',
            tier: 'high',
            instructions:
              '用上面的交接单当背景，按评审范围取差异（git diff <范围> / p4 describe -du），只评以 + / - 开头的行，给出分级评审意见。改动涉及的模块很多时，可以用 spawn_agents 按模块派子任务并行看，最后由你去重、定级、汇总。',
          },
        ],
        edges: chain(START, 'brief', 'review', END),
      },
    ],
  },
  {
    key: 'deps',
    name: '依赖升级与安全',
    description: '查过期依赖、已知漏洞和许可问题，按风险分批升级，每批都有验证',
    category: '质量',
    when: '升级依赖、查漏洞和许可',
    notFor: '只升一个包的补丁版本',
    kind: 'change',
    main: 'deps',
    members: [
      ['deps', '查过期 / 漏洞 / 许可，按可回滚的批次升级，每批跑项目测试步骤'],
      ['docsync', '同步依赖策略和升级记录'],
    ],
    document: `## 适用
依赖过期、收到安全告警、要升大版本，或者定期做一次依赖体检。

## 约定
- 先体检再动手：体检节点只出清单和风险，不改 lock 文件。
- 升级按可回滚的批次：一次一组相关依赖，装完跑项目测试步骤，通过再进下一批；一批不过就回退这一批，写明原因。
- 漏洞按可利用性排序，不夸大：没有被利用路径的要说明为什么。
- 不擅自改包管理器、不混用锁文件；不动用户已有的未提交改动。
${CHILD_RULES}`,
    flows: [
      {
        id: 'main',
        name: '主流程',
        nodes: [
          {
            id: 'audit',
            title: '依赖体检',
            agent: 'deps',
            tier: 'medium',
            params: { mode: '只体检', audit: true, license: true },
            confirm: true,
            instructions:
              '查这个项目的依赖现状：过期清单、安全漏洞（按严重程度）、许可证冲突、大版本升级的破坏性变更。每条都带命令输出或文件路径。最后给出建议的升级批次和每批的风险，请用户确认升级范围。',
          },
          {
            id: 'upgrade',
            title: '分批升级',
            agent: 'deps',
            tier: 'high',
            params: { mode: '升级补丁版', audit: true },
            retries: 1,
            instructions:
              '按用户确认的批次升级。每批升级后装依赖、跑项目测试步骤，通过才进下一批；失败就按 systematic-debugging 找根因，修不好就回退这一批并说明。',
          },
          {
            ...DOCS_NODE,
            instructions: '有依赖策略或升级记录相关的文档时同步它们（有长期决策时写 ADR）；没有要更新的写明原因。',
          },
        ],
        edges: chain(START, 'audit', 'upgrade', 'docs', END),
      },
    ],
  },
  {
    key: 'release',
    name: '发布与回滚',
    description: '确认发布范围 → 构建并验证产物 → 写发布说明和回滚方案；打 tag、推送和发布由父对话做',
    category: '交付',
    when: '准备发版：定范围、验产物、写发布说明和回滚方案',
    notFor: '打 tag、推送、发布（父对话做）',
    kind: 'change',
    main: 'vcs',
    members: [
      ['vcs', '汇总改动、确认发布范围和版本号'],
      ['tester', '按项目测试步骤跑发布前验证，检查构建产物'],
      ['docsync', '写发布说明和回滚方案'],
    ],
    document: `## 适用
要把一次改动真正发出去：出包、发版本、上线前的准备，以及需要回滚预案的场景。

## 约定
- 工作流只做到「可以发布」：打 tag、推送、触发发布流程、部署都是对外操作，由父对话决定并执行；子对话不执行、不询问、也不建议，结果里写清父对话下一步要做什么。
- 发布前验证必须用本轮的新鲜产物：构建一次、在产物上跑验证，不能拿开发环境的结果代替。
- 回滚方案先写再发：怎么回、回哪个版本、回滚后怎么验证，写在发布说明里。
- 版本号和变更说明按项目自己的规则（AGENTS.md / CONTRIBUTING / 已有的 tag 风格）。`,
    flows: [
      {
        id: 'main',
        name: '主流程',
        nodes: [
          {
            id: 'prepare',
            title: '发布范围',
            agent: 'vcs',
            tier: 'medium',
            params: { vcs: '自动', commit: '只检查' },
            instructions:
              '确认发布范围（哪些提交 / pending 会进这次发布）、目标版本号、项目自己的发布规则。列出还没进这次发布但相关的改动，指出阻塞项。',
          },
          {
            id: 'build',
            title: '构建与产物验证',
            agent: 'tester',
            tier: 'high',
            params: { scope: '整体', env: '自动', regress: true, onFail: '只报告', serial: true },
            instructions:
              '按工作流说明里的「## 项目测试步骤」跑一遍发布前验证，重点检查构建产物本身（产物在不在、版本号对不对、包内容有没有多带文件）。每条都写命令和结果；跑不了的登记为延期验证。最后调用 submit_verdict 交结论，不通过时 blockers 写失败项。',
          },
          {
            id: 'notes',
            title: '发布说明与回滚',
            agent: 'docsync',
            tier: 'low',
            params: { adr: '不写' },
            confirm: true,
            instructions:
              '按项目自己的格式写发布说明（新功能 / 改进 / 修复 / 依赖，写给用户看），并写回滚方案：回滚触发条件、回滚步骤、回滚后怎么验证。最后写清父对话要执行的发布步骤（打 tag、推送、触发发布），请用户确认。',
          },
        ],
        edges: chain(START, 'prepare', 'build', 'notes', END),
      },
    ],
  },
]

/**
 * 整理时合并掉的内置工作流 → 接替它的工作流。启动时本机没改过的副本删掉，项目里的引用改指到接替的那个；
 * 用户改过的副本保留不动（见 install.ts 的 retireBuiltinWorkflows）。
 * - 日常开发：和「通用项目」的主流程是同一件事。
 * - UE 功能开发：和「UE 项目」的主流程是同一件事。
 * - 项目初始化：项目设置里的「AI 初始化项目」已经覆盖（写 AGENTS.md 和文档框架、推荐测试步骤和工作流）。
 * - Bug 修复（ADR 0044 下线）：Bug 交子对话在对话里按逐层定位做，固定节点会丢掉中间的线索。
 */
export const RETIRED_WORKFLOWS: Record<string, string> = {
  'daily-dev': GENERAL_KEY,
  'ue-dev': UE_PROJECT_KEY,
  bootstrap: GENERAL_KEY,
  // ADR 0044：Bug 不走固定剧本（下一步查哪里要看上一步查到了什么），交子对话按逐层定位做
  bugfix: GENERAL_KEY,
}

/** 内置工作流里用到的所有 Agent（key） */
export function builtinAgentKeys(w: BuiltinWorkflow) {
  const keys = new Set([w.main, ...w.members.map((m) => m[0])])
  for (const f of w.flows)
    for (const n of f.nodes) {
      if (n.agent) keys.add(n.agent)
      for (const s of n.steps ?? []) keys.add(s.agent)
    }
  return [...keys]
}

/** 换成本机的 Agent id，生成可以直接保存的工作流（分类、标签由调用方填） */
export function buildWorkflow(
  w: BuiltinWorkflow,
  agentId: (key: string) => string,
): Omit<WorkflowInput, 'categoryId' | 'tags'> {
  return {
    name: w.name,
    description: w.description,
    mainAgentId: agentId(w.main),
    // 子 Agent 在节点上选，不再单独列团队；members 只用来决定要建哪些 Agent
    members: [],
    entryFlowId: 'main',
    document: w.document,
    expose: w.expose ?? [],
    when: w.when,
    notFor: w.notFor,
    kind: w.kind,
    flows: w.flows.map((f) => buildFlow(f, agentId)),
  }
}

/**
 * 一个流程定义换成本机的 Agent id：升级旧副本时比较语义也要用同一套转换，
 * 保证「旧定义」和「本机副本」在同样的字段上比较。
 */
export function buildFlow(f: FlowSpec, agentId: (key: string) => string): Flow {
  return autoLayout({
    id: f.id,
    name: f.name,
    description: f.description ?? '',
    startPos: { x: 0, y: 0 },
    endPos: { x: 600, y: 0 },
    nodes: f.nodes.map((n): FlowNode => {
      const steps = (n.steps ?? []).map((s, i): NodeStep => ({
        id: s.id || `st${i + 1}`,
        title: s.title,
        kind: 'agent',
        agentId: agentId(s.agent),
        flow: null,
        tier: s.tier ?? '',
        params: s.params ?? {},
        instructions: s.instructions,
        retries: s.retries ?? 0,
        ...(s.confirm && { confirm: true }),
        review: s.review ? { kind: 'sub', id: s.review } : null,
        maxRounds: s.maxRounds ?? 3,
      }))
      return {
        id: n.id,
        title: n.title,
        kind: 'agent',
        agentId: steps.length ? '' : agentId(n.agent ?? ''),
        flow: null,
        tier: n.tier ?? '',
        params: n.params ?? {},
        steps,
        retries: steps.length ? 0 : (n.retries ?? 0),
        instructions: steps.length ? '' : n.instructions,
        x: 0,
        y: 0,
        hooks: {
          start: null,
          review: steps.length || !n.review ? null : { kind: 'sub', id: n.review },
          end: null,
          maxRounds: n.maxRounds ?? 3,
          ...(!steps.length && n.confirm && { confirm: true }),
        } satisfies NodeHooks,
      }
    }),
    edges: f.edges.map(([from, to, when], i): FlowEdge => ({ id: `e${i + 1}`, from, to, ...(when && { when }) })),
  })
}
